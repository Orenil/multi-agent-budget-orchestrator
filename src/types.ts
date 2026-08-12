/**
 * Core types shared across the orchestrator, the budget ledger, and agents.
 *
 * A "budget" is a three-dimensional resource envelope. Real multi-agent
 * deployments blow their limits on all three axes independently: an agent
 * can be token-cheap but time-slow (a hung network call), or fast but
 * token-hungry (a verbose model in a tight loop). Collapsing budgets to a
 * single "step count", as most agent frameworks do, catches neither failure
 * mode reliably. So we track and enforce all three.
 */

export interface BudgetAmount {
  /** LLM tokens (prompt + completion combined). */
  tokens: number;
  /** Wall-clock time, in milliseconds. */
  timeMs: number;
  /** Abstract cost unit (e.g. USD-equivalent). Lets tools/LLMs have different $/call. */
  costUsd: number;
}

export function zeroBudget(): BudgetAmount {
  return { tokens: 0, timeMs: 0, costUsd: 0 };
}

export function addBudget(a: BudgetAmount, b: BudgetAmount): BudgetAmount {
  return { tokens: a.tokens + b.tokens, timeMs: a.timeMs + b.timeMs, costUsd: a.costUsd + b.costUsd };
}

export function subBudget(a: BudgetAmount, b: BudgetAmount): BudgetAmount {
  return { tokens: a.tokens - b.tokens, timeMs: a.timeMs - b.timeMs, costUsd: a.costUsd - b.costUsd };
}

/** True if `have` covers `need` on every axis. */
export function covers(have: BudgetAmount, need: BudgetAmount): boolean {
  return have.tokens >= need.tokens && have.timeMs >= need.timeMs && have.costUsd >= need.costUsd;
}

/** Componentwise min — used when clamping a child's request to the parent's remaining pool. */
export function minBudget(a: BudgetAmount, b: BudgetAmount): BudgetAmount {
  return {
    tokens: Math.min(a.tokens, b.tokens),
    timeMs: Math.min(a.timeMs, b.timeMs),
    costUsd: Math.min(a.costUsd, b.costUsd),
  };
}

/** Thrown internally when an intercepted call would exceed a ledger node's remaining budget.
 *  Agents may catch it to build a graceful partial result; if they don't, the orchestrator's
 *  agent-runner does, so it never escapes as an unhandled crash. */
export class BudgetExhaustedError extends Error {
  constructor(public readonly ledgerId: string, public readonly attempted: BudgetAmount, public readonly remaining: BudgetAmount) {
    super(`budget exhausted at ${ledgerId}: attempted ${JSON.stringify(attempted)}, remaining ${JSON.stringify(remaining)}`);
    this.name = "BudgetExhaustedError";
  }
}

export type AgentStatus = "complete" | "incomplete";

/** The structured, always-returned outcome of running an agent. Never a thrown error, never silence. */
export interface AgentResult<T = unknown> {
  status: AgentStatus;
  /** Present when status === "incomplete". Currently only one reason exists, but the field
   *  is a string union so new degradation causes (e.g. "incomplete: parent_terminated") can be
   *  added without breaking existing consumers. */
  reason?: "budget_exhausted" | "parent_terminated" | "error";
  /** Best-available output. Populated incrementally by the agent as it works, so a mid-flight
   *  cutoff still returns whatever was produced so far, not an empty object. */
  partial: T;
  /** Actual resource usage charged to this agent's ledger node. */
  usage: BudgetAmount;
  /** Wall-clock ledger id, useful for debugging hierarchical runs. */
  ledgerId: string;
  /** Human-readable note on why the run ended (useful in tests/logs). */
  note?: string;
}

/** A tool the interceptor can execute on an agent's behalf. */
export interface ToolSpec {
  name: string;
  /** Estimated cost of a single call, used for the pre-flight admission check. */
  estimate: BudgetAmount;
  /** Actual implementation. Receives an AbortSignal that fires if the ledger's remaining
   *  time budget is exceeded mid-call, so long-running tools can be cancelled for real. */
  run(args: unknown, signal: AbortSignal): Promise<unknown>;
}

/** The handle passed into every agent function. It is the *only* way an agent can spend
 *  budget or spawn sub-agents — there is no back door, so accounting cannot be self-reported.
 *
 *  `T` is deliberately a single type parameter shared by the mutable partial accumulator
 *  and the agent's eventual return value: an agent is expected to build its result
 *  incrementally into `ctx.partial` (e.g. `ctx.partial.findings.push(...)`) and return
 *  that same accumulator (optionally finalized) on success. That way, whether the run
 *  completes or gets cut off mid-flight, `AgentResult.partial` is always the same shape. */
export interface AgentContext<T> {
  readonly ledgerId: string;
  readonly task: string;
  /** Mutable partial-result accumulator. Agents append findings here as they go so that
   *  a budget cutoff mid-run still has something real to return. */
  readonly partial: T;
  callTool(name: string, args: unknown): Promise<unknown>;
  callLLM(prompt: string): Promise<string>;
  /** Spawn a sub-agent with a requested sub-budget. The orchestrator clamps the request to
   *  what's actually left in *this* agent's remaining budget — an over-asking child never
   *  gets more than the parent can afford, regardless of what it requests. */
  spawnSubAgent<C>(
    name: string,
    agentFn: AgentFn<C>,
    task: string,
    requestedBudget: BudgetAmount,
    initialPartial: C
  ): Promise<AgentResult<C>>;
  remaining(): Promise<BudgetAmount>;
}

export type AgentFn<T> = (ctx: AgentContext<T>) => Promise<T>;
