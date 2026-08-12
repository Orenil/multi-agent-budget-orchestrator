import { describe, expect, it } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import { recursivePlannerAgent, infiniteToolLoopAgent, slowToolStarvationAgent } from "../src/agents/runawayAgents.js";
import type { BudgetAmount } from "../src/types.js";

/**
 * The runaway-agent test harness required by the spec. Each agent here has genuinely
 * pathological control flow — no base case, no loop exit, a deliberately slow tool called
 * in an unbounded loop — and would run forever (or until the process is killed) without
 * real enforcement. These tests prove the orchestrator's ceilings hold under actual
 * execution: every run must settle (not hang past the vitest timeout) and must never
 * report usage beyond the budget it was given, on any axis.
 */

function withinCeiling(usage: BudgetAmount, ceiling: BudgetAmount): boolean {
  return usage.tokens <= ceiling.tokens && usage.timeMs <= ceiling.timeMs && usage.costUsd <= ceiling.costUsd + 1e-9;
}

describe("runaway agent harness", () => {
  it("recursive planner with no base case is bounded by spawn-coordination overhead, not a depth counter", async () => {
    const orch = new Orchestrator();
    const budget: BudgetAmount = { tokens: 500, timeMs: 3000, costUsd: 1 };
    const result = await orch.run("infinite plan", budget, recursivePlannerAgent, { depthReached: 0, trail: [] });

    // It must actually stop — real recursion depth, not an infinite hang.
    expect(result.partial.depthReached).toBeGreaterThan(0);
    expect(result.partial.depthReached).toBeLessThan(1000);
    // Ledger math predicts the ceiling exactly: overhead is 15 tokens/level, budget is 500.
    expect(result.partial.depthReached).toBeLessThanOrEqual(Math.floor(500 / 15) + 1);
    expect(withinCeiling(result.usage, budget)).toBe(true);
    // Every visited ledger id shows up exactly once in the trail — real distinct sub-agent
    // invocations, not a counter incremented without doing anything.
    expect(new Set(result.partial.trail).size).toBe(result.partial.trail.length);
  }, 10_000);

  it("a recursive planner given a near-zero budget is stopped at the very first spawn attempt", async () => {
    const orch = new Orchestrator();
    // Too small to afford even the first sub-agent's overhead beyond the root call.
    const budget: BudgetAmount = { tokens: 10, timeMs: 3000, costUsd: 1 };
    const result = await orch.run("infinite plan", budget, recursivePlannerAgent, { depthReached: 0, trail: [] });
    expect(result.partial.depthReached).toBe(1);
    expect(withinCeiling(result.usage, budget)).toBe(true);
  });

  it("infinite tool-call loop is cut off by token exhaustion and returns the calls it did complete", async () => {
    const orch = new Orchestrator();
    const budget: BudgetAmount = { tokens: 300, timeMs: 5000, costUsd: 1 };
    const result = await orch.run("loop forever", budget, infiniteToolLoopAgent, { callsCompleted: 0, lastResult: null });

    expect(result.status).toBe("incomplete");
    expect(result.reason).toBe("budget_exhausted");
    expect(result.partial.callsCompleted).toBeGreaterThan(0);
    expect(result.partial.lastResult).not.toBeNull();
    expect(withinCeiling(result.usage, budget)).toBe(true);
    // compute costs 5 tokens/call — usage should land within one call's cost of the ceiling,
    // proving the loop actually ran until the budget was nearly exhausted rather than
    // stopping early for an unrelated reason.
    expect(budget.tokens - result.usage.tokens).toBeLessThan(5);
  }, 10_000);

  it("slow-tool starvation is cut off by the time axis specifically, even with tokens/cost to spare", async () => {
    const orch = new Orchestrator();
    const budget: BudgetAmount = { tokens: 100_000, timeMs: 300, costUsd: 100 };
    const start = Date.now();
    const result = await orch.run("starve the clock", budget, slowToolStarvationAgent, { callsCompleted: 0 });
    const wallClockElapsed = Date.now() - start;

    expect(result.status).toBe("incomplete");
    expect(result.reason).toBe("budget_exhausted");
    // Plenty of tokens/cost budget remained — time was the binding constraint.
    expect(result.usage.tokens).toBeLessThan(budget.tokens);
    expect(result.usage.costUsd).toBeLessThan(budget.costUsd);
    expect(withinCeiling(result.usage, budget)).toBe(true);
    // The process didn't actually hang forever: real wall-clock time elapsed was bounded
    // and close to the configured time ceiling (allowing scheduling slack), not orders of
    // magnitude beyond it.
    expect(wallClockElapsed).toBeLessThan(budget.timeMs + 2000);
  }, 10_000);

  it("a slow-starved agent never exceeds its time ceiling even under a tighter budget", async () => {
    const orch = new Orchestrator();
    const budget: BudgetAmount = { tokens: 100_000, timeMs: 150, costUsd: 100 };
    const result = await orch.run("starve harder", budget, slowToolStarvationAgent, { callsCompleted: 0 });
    expect(withinCeiling(result.usage, budget)).toBe(true);
    // A single slowFetch call costs 120ms; with a 150ms ceiling at most one call fits.
    expect(result.partial.callsCompleted).toBeLessThanOrEqual(1);
  }, 10_000);
});
