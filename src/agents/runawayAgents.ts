import type { AgentFn } from "../types.js";

/**
 * The "simulated runaway agent" test harness required by the spec: real, in-process
 * TypeScript agents with deliberately pathological control flow (no base case, no loop
 * exit, an expensive-per-call pattern), used to prove the orchestrator's ceilings hold
 * under genuine execution rather than being asserted against a mock.
 */

export interface RecursivePartial {
  depthReached: number;
  trail: string[];
}

/**
 * Recursive planner with no base case: at every level it asks to spawn exactly one more
 * level of itself, requesting its *entire* remaining budget for the child (maximally
 * greedy — it never holds anything back "just in case"). Left unchecked this recurses
 * forever. What actually stops it is the orchestrator's fixed spawn-coordination-overhead
 * charge (`SPAWN_OVERHEAD` in orchestrator.ts) depleting the shared ancestor budget a
 * little more on every level, until a spawn attempt can no longer afford even that
 * overhead and comes back `budget_exhausted` without ever entering another level. This
 * agent stops recursing once that happens — not because it "checked a depth counter", but
 * because there is nothing further it *can* do once the orchestrator says no.
 */
export const recursivePlannerAgent: AgentFn<RecursivePartial> = async (ctx) => {
  ctx.partial.depthReached += 1;
  ctx.partial.trail.push(ctx.ledgerId);

  const remaining = await ctx.remaining();
  const child = await ctx.spawnSubAgent("plan", recursivePlannerAgent, ctx.task, remaining, {
    depthReached: ctx.partial.depthReached,
    trail: [],
  });
  ctx.partial.depthReached = Math.max(ctx.partial.depthReached, child.partial.depthReached);
  ctx.partial.trail.push(...child.partial.trail);
  return ctx.partial;
};

export interface LoopPartial {
  callsCompleted: number;
  lastResult: number | null;
}

/**
 * No termination condition at all — a bare `while (true)` making real tool calls, never
 * checking remaining budget itself. The only thing that stops it is the interceptor
 * refusing the next call once the ledger is exhausted, which surfaces as a thrown
 * `BudgetExhaustedError` this agent deliberately does not catch. The orchestrator's
 * runner catches it instead and turns it into a well-formed incomplete result built from
 * `ctx.partial` exactly as it stood after the last successful call.
 */
export const infiniteToolLoopAgent: AgentFn<LoopPartial> = async (ctx) => {
  let i = 0;
  while (true) {
    const { squared } = (await ctx.callTool("compute", { n: i })) as { squared: number };
    ctx.partial.callsCompleted += 1;
    ctx.partial.lastResult = squared;
    i += 1;
  }
};

export interface StarvationPartial {
  callsCompleted: number;
}

/**
 * Simulates "slow tool starvation": each call is cheap in tokens/cost but individually
 * expensive in wall-clock time, so a naive agent that just keeps calling it burns through
 * the *time* axis of its budget long before token or cost limits would ever trip — a
 * failure mode a token-only or step-count-only budget system can't see coming. Proves the
 * interceptor enforces all three budget axes independently, not just whichever is
 * cheapest to check.
 */
export const slowToolStarvationAgent: AgentFn<StarvationPartial> = async (ctx) => {
  while (true) {
    await ctx.callTool("slowFetch", {});
    ctx.partial.callsCompleted += 1;
  }
};
