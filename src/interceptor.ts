import type { BudgetLedger } from "./ledger/types.js";
import { BudgetExhaustedError, type AgentContext, type AgentFn, type AgentResult, type BudgetAmount, type ToolSpec } from "./types.js";
import { abortableDelay } from "./util.js";

/**
 * Builds the sole capability handle an agent function ever receives. This is where
 * "budget accounting happens at the orchestrator layer, not self-reported" is actually
 * enforced: agent code gets a `ctx` closed over a ledger it cannot reach directly and a
 * tool registry it cannot call directly. Every call is check-then-execute against the
 * ledger *before* any real work happens — an agent cannot spend first and confess later.
 *
 * The `watchdogSignal` is the orchestrator's hard kill switch for this ledger node: it
 * fires when this node's allocated wall-clock time elapses, regardless of whether the
 * agent or its tools ever call back in to report progress. Any call in flight when it
 * fires is aborted for real (the simulated tools all honor AbortSignal), which is what
 * lets a stuck or malicious sub-agent be terminated "regardless of what the parent
 * thinks it needs."
 */
export interface CreateContextOpts<T> {
  ledger: BudgetLedger;
  ledgerId: string;
  task: string;
  partial: T;
  tools: Map<string, ToolSpec>;
  watchdogSignal: AbortSignal;
  spawn: <C>(name: string, agentFn: AgentFn<C>, task: string, requestedBudget: BudgetAmount, initialPartial: C) => Promise<AgentResult<C>>;
}

// Deterministic pseudo-LLM cost model: token count scales with prompt length plus a
// fixed completion size, so budgets drain predictably in tests without a real API call.
const COMPLETION_TOKENS = 24;
const COST_PER_TOKEN = 0.000002;

export function createContext<T>(opts: CreateContextOpts<T>): AgentContext<T> {
  const { ledger, ledgerId, tools, watchdogSignal } = opts;

  async function checkedConsume(amount: BudgetAmount): Promise<void> {
    if (watchdogSignal.aborted) {
      throw new BudgetExhaustedError(ledgerId, amount, await ledger.getRemaining(ledgerId));
    }
    const ok = await ledger.tryConsume(ledgerId, amount);
    if (!ok) {
      throw new BudgetExhaustedError(ledgerId, amount, await ledger.getRemaining(ledgerId));
    }
  }

  return {
    ledgerId,
    task: opts.task,
    partial: opts.partial,

    async callTool(name: string, args: unknown): Promise<unknown> {
      const spec = tools.get(name);
      if (!spec) throw new Error(`unknown tool: ${name}`);
      await checkedConsume(spec.estimate);
      try {
        return await spec.run(args, watchdogSignal);
      } catch (err) {
        if (watchdogSignal.aborted) {
          throw new BudgetExhaustedError(ledgerId, spec.estimate, await ledger.getRemaining(ledgerId));
        }
        throw err;
      }
    },

    async callLLM(prompt: string): Promise<string> {
      const promptTokens = Math.ceil(prompt.length / 4);
      const amount: BudgetAmount = {
        tokens: promptTokens + COMPLETION_TOKENS,
        timeMs: 8 + Math.floor(prompt.length / 40),
        costUsd: (promptTokens + COMPLETION_TOKENS) * COST_PER_TOKEN,
      };
      await checkedConsume(amount);
      try {
        await abortableDelay(amount.timeMs, watchdogSignal);
      } catch {
        throw new BudgetExhaustedError(ledgerId, amount, await ledger.getRemaining(ledgerId));
      }
      return `[deterministic-llm response#${hash(prompt)}] re: ${prompt.slice(0, 60)}`;
    },

    async spawnSubAgent<C>(name: string, agentFn: AgentFn<C>, task: string, requestedBudget: BudgetAmount, initialPartial: C) {
      return opts.spawn<C>(name, agentFn, task, requestedBudget, initialPartial);
    },

    async remaining(): Promise<BudgetAmount> {
      return ledger.getRemaining(ledgerId);
    },
  };
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
