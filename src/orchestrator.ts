import { MemoryLedger } from "./ledger/memoryLedger.js";
import type { BudgetLedger } from "./ledger/types.js";
import { createContext } from "./interceptor.js";
import { ALL_TOOLS } from "./tools/simTools.js";
import { addBudget, BudgetExhaustedError, zeroBudget, type AgentFn, type AgentResult, type BudgetAmount, type ToolSpec } from "./types.js";

export interface OrchestratorOptions {
  ledger?: BudgetLedger;
  tools?: ToolSpec[];
}

/**
 * Fixed coordination overhead charged to the *parent* on every spawn attempt, before any
 * allocation happens. This models the real (if simplified) cost of spawning a sub-agent —
 * context handoff, an initial planning call, IPC in a distributed deployment — and it is
 * what actually bounds pathologically greedy recursion (e.g. a planner that always asks
 * to spawn "just one more level" with no base case). Without it, a chain of spawns where
 * nothing ever calls a tool would never shrink the shared budget pool at all: the child
 * would inherit exactly what the parent had left, forever. Charging a nonzero, fixed
 * overhead on the spawn itself guarantees strictly monotonic depletion, so recursion
 * depth is mathematically bounded by budget / overhead — a real resource ceiling, not a
 * hidden step counter.
 */
const SPAWN_OVERHEAD: BudgetAmount = { tokens: 15, timeMs: 5, costUsd: 0.00005 };

/**
 * The orchestrator is the only thing that ever touches the ledger. Agents get a `ctx`
 * (built by the interceptor) that funnels every action through here; there is no
 * secondary path for an agent to spend budget or spawn work.
 *
 * Hierarchical enforcement, concretely:
 *  1. `run(task, rootBudget, agentFn)` creates a root ledger node with the full budget
 *     and executes `agentFn` against it.
 *  2. When that agent calls `ctx.spawnSubAgent(...)`, the orchestrator allocates a child
 *     node whose budget is `min(requested, parent's current remaining)` — a child can
 *     never get more than its parent actually has left, no matter what it asks for.
 *  3. The child runs under its own watchdog timer sized to its own allocated time
 *     budget. If it (or anything it spawns) exceeds its slice on any axis, calls made
 *     through its `ctx` start failing immediately — real termination, not a step count.
 *  4. Whatever the child didn't spend is reclaimed back into the parent's remaining pool
 *     the moment it finishes, so later siblings can use it.
 *  5. A parent that is itself now out of budget will fail on its *own* next intercepted
 *     call or spawn attempt, which is how "an over-budget sub-agent is terminated
 *     regardless of what the parent thinks it needs" composes all the way up the tree.
 */
export class Orchestrator {
  private ledger: BudgetLedger;
  private tools: Map<string, ToolSpec>;
  private idCounter = 0;
  // Accumulates completed children's *total* usage (their own spend plus everything
  // below them) keyed by parent ledgerId, so a node's reported usage reflects the whole
  // subtree it spawned, not just the calls it made directly.
  private childUsage = new Map<string, BudgetAmount>();

  constructor(opts: OrchestratorOptions = {}) {
    this.ledger = opts.ledger ?? new MemoryLedger();
    this.tools = new Map((opts.tools ?? ALL_TOOLS).map((t) => [t.name, t]));
  }

  async run<T>(task: string, budget: BudgetAmount, agentFn: AgentFn<T>, initialPartial: T): Promise<AgentResult<T>> {
    const rootId = `root-${++this.idCounter}`;
    await this.ledger.createRoot(rootId, budget);
    return this.execute(rootId, task, agentFn, initialPartial);
  }

  /** Shared execution path for both the root agent and every spawned sub-agent. */
  private async execute<T>(ledgerId: string, task: string, agentFn: AgentFn<T>, initialPartial: T): Promise<AgentResult<T>> {
    const allocated = await this.ledger.getRemaining(ledgerId);
    const watchdog = new AbortController();
    // Hard wall-clock ceiling for this node: fires even if the agent never makes another
    // intercepted call (e.g. it's stuck in a tight loop between calls), so a node can
    // never outlive the time budget it was actually granted.
    const timer = setTimeout(() => watchdog.abort(), Math.max(0, allocated.timeMs));
    // setTimeout keeps the process alive; unref so it never blocks a clean exit/test run.
    if (typeof (timer as any).unref === "function") (timer as any).unref();

    const ctx = createContext<T>({
      ledger: this.ledger,
      ledgerId,
      task,
      partial: initialPartial,
      tools: this.tools,
      watchdogSignal: watchdog.signal,
      spawn: (name, childFn, childTask, requested, childInitial) => this.spawn(ledgerId, name, childFn, childTask, requested, childInitial),
    });

    try {
      const value = await agentFn(ctx);
      clearTimeout(timer);
      return { status: "complete", partial: value, usage: await this.subtreeUsage(ledgerId), ledgerId };
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof BudgetExhaustedError || watchdog.signal.aborted) {
        return {
          status: "incomplete",
          reason: "budget_exhausted",
          partial: ctx.partial,
          usage: await this.subtreeUsage(ledgerId),
          ledgerId,
          note: err instanceof BudgetExhaustedError ? err.message : "wall-clock watchdog fired: node exceeded its allocated time budget",
        };
      }
      // A genuine bug in agent code (not a budget condition) — surfaces as a normal
      // rejection rather than being silently reinterpreted as a degradation.
      throw err;
    } finally {
      await this.ledger.reclaim(ledgerId);
      this.childUsage.delete(ledgerId);
    }
  }

  /** This node's own direct spend plus the (already-aggregated) usage of every child it
   *  spawned, read before the `finally` block above clears the accumulator entry. */
  private async subtreeUsage(ledgerId: string): Promise<BudgetAmount> {
    const own = await this.ledger.getUsage(ledgerId);
    return addBudget(own, this.childUsage.get(ledgerId) ?? zeroBudget());
  }

  private async spawn<C>(
    parentId: string,
    name: string,
    agentFn: AgentFn<C>,
    task: string,
    requestedBudget: BudgetAmount,
    initialPartial: C
  ): Promise<AgentResult<C>> {
    const childId = `${parentId}.${name}-${++this.idCounter}`;
    // Real event-loop tick between spawn attempts. Belt-and-suspenders alongside
    // SPAWN_OVERHEAD: it guarantees the process always yields to the macrotask queue
    // (where watchdog timers live) between successive spawns, even if agent code retries
    // spawning in a tight loop after being told a child was budget_exhausted.
    await new Promise((resolve) => setImmediate(resolve));

    const overheadOk = await this.ledger.tryConsume(parentId, SPAWN_OVERHEAD);
    if (!overheadOk) {
      return {
        status: "incomplete",
        reason: "budget_exhausted",
        partial: initialPartial,
        usage: { tokens: 0, timeMs: 0, costUsd: 0 },
        ledgerId: childId,
        note: "parent could not afford spawn coordination overhead; sub-agent never started",
      };
    }

    const granted = await this.ledger.allocateChild(parentId, childId, requestedBudget);
    // A child granted (effectively) nothing can't do useful work; fail it fast without
    // even entering agentFn, rather than letting it run and immediately hit exhaustion.
    if (granted.tokens <= 0 && granted.timeMs <= 0 && granted.costUsd <= 0) {
      await this.ledger.reclaim(childId);
      return {
        status: "incomplete",
        reason: "budget_exhausted",
        partial: initialPartial,
        usage: { tokens: 0, timeMs: 0, costUsd: 0 },
        ledgerId: childId,
        note: "parent had no remaining budget to allocate at spawn time",
      };
    }
    const result = await this.execute(childId, task, agentFn, initialPartial);
    this.childUsage.set(parentId, addBudget(this.childUsage.get(parentId) ?? zeroBudget(), result.usage));
    return result;
  }
}
