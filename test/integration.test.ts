import { describe, expect, it } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import { researchAgent, plannerAgent } from "../src/agents/realAgents.js";
import type { BudgetAmount } from "../src/types.js";

/**
 * Integration tests against well-behaved agents (as opposed to the runaway harness):
 * verify the full success path, and — the core of the spec — that a budget cutoff mid-run
 * produces a structured, genuinely usable partial result rather than silence or a thrown
 * error escaping to the caller.
 */
describe("integration — success path", () => {
  it("completes normally and returns a real synthesized result when the budget is generous", async () => {
    const orch = new Orchestrator();
    const budget: BudgetAmount = { tokens: 2000, timeMs: 2000, costUsd: 1 };
    const result = await orch.run("edge computing trends", budget, researchAgent, { findings: [] });

    expect(result.status).toBe("complete");
    expect(result.reason).toBeUndefined();
    expect(result.partial.findings.length).toBeGreaterThanOrEqual(3);
    expect(result.partial.summary).toBeTruthy();
    expect(result.partial.summary).toContain("edge computing trends");
  });

  it("a planner that spawns two research sub-agents completes and reclaims unused sub-budget", async () => {
    const orch = new Orchestrator();
    const budget: BudgetAmount = { tokens: 5000, timeMs: 5000, costUsd: 1 };
    const result = await orch.run("renewable energy", budget, plannerAgent, { subReports: [] });

    expect(result.status).toBe("complete");
    expect(result.partial.subReports).toHaveLength(2);
    for (const line of result.partial.subReports) expect(line).not.toContain("INCOMPLETE");
    // Root's own overhead (2 spawns) plus both children's real work, well under the ceiling.
    expect(result.usage.tokens).toBeLessThan(budget.tokens);
    expect(result.usage.tokens).toBeGreaterThan(0);
  });
});

describe("integration — partial-result degradation path", () => {
  it("returns a well-formed incomplete result, never a thrown error, when budget runs out mid-run", async () => {
    const orch = new Orchestrator();
    // Enough for exactly one tool call (search costs 40 tokens) but not the fetches or
    // LLM summary that would follow.
    const budget: BudgetAmount = { tokens: 45, timeMs: 5000, costUsd: 1 };

    let thrown: unknown = null;
    let result;
    try {
      result = await orch.run("battery chemistry", budget, researchAgent, { findings: [] });
    } catch (err) {
      thrown = err;
    }

    // The core contract: no exception ever escapes orch.run for a budget condition.
    expect(thrown).toBeNull();
    expect(result!.status).toBe("incomplete");
    expect(result!.reason).toBe("budget_exhausted");
    expect(result!.note).toBeTruthy();
  });

  it("the partial result is genuinely usable output, not an empty placeholder", async () => {
    const orch = new Orchestrator();
    const budget: BudgetAmount = { tokens: 45, timeMs: 5000, costUsd: 1 };
    const result = await orch.run("battery chemistry", budget, researchAgent, { findings: [] });

    expect(result.status).toBe("incomplete");
    expect(result.partial.findings.length).toBeGreaterThan(0);
    // Real, readable content from the one search call that did complete — not silence.
    expect(result.partial.findings[0]).toContain("battery chemistry");
    expect(result.partial.findings[0]).toContain("doc:");
    // No summary was ever reached — proves the cutoff happened where the budget actually
    // ran out (before the LLM call), not that the agent silently produced a fake one.
    expect(result.partial.summary).toBeUndefined();
  });

  it("degradation composes through a spawned sub-agent: the parent still finishes and reports the child's shortfall honestly", async () => {
    const orch = new Orchestrator();
    // Enough to spawn one child that itself runs out partway through.
    const budget: BudgetAmount = { tokens: 90, timeMs: 5000, costUsd: 1 };
    const result = await orch.run("solid-state batteries", budget, plannerAgent, { subReports: [] });

    expect(result.partial.subReports.length).toBeGreaterThan(0);
    expect(result.partial.subReports.some((line) => line.includes("INCOMPLETE"))).toBe(true);
    // The planner itself still returns a complete, well-formed top-level result even
    // though a piece of its plan was cut short — degradation at one level doesn't corrupt
    // or silence the level above it.
    expect(result.status).toBe("complete");
  });
});
