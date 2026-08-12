import { Orchestrator } from "./orchestrator.js";
import { plannerAgent, researchAgent } from "./agents/realAgents.js";
import { recursivePlannerAgent, infiniteToolLoopAgent, slowToolStarvationAgent } from "./agents/runawayAgents.js";
import type { BudgetAmount } from "./types.js";

/**
 * Demo CLI: runs one full "success" scenario, one "graceful degradation" scenario, and
 * all three runaway agents, printing usage vs. the configured ceiling for each so you can
 * see — in real, executed output — that the ceiling is never exceeded. `npm start`.
 */

function fmt(b: BudgetAmount): string {
  return `tokens=${b.tokens} timeMs=${b.timeMs} costUsd=${b.costUsd.toFixed(5)}`;
}

async function main() {
  console.log("=== 1. planner + 2x research sub-agents, generous budget (expected: complete) ===");
  {
    const orch = new Orchestrator();
    const budget: BudgetAmount = { tokens: 5000, timeMs: 5000, costUsd: 1 };
    const result = await orch.run("quarterly market scan", budget, plannerAgent, { subReports: [] });
    console.log("status:", result.status);
    console.log("summary:", result.partial.summary);
    for (const r of result.partial.subReports) console.log(" -", r);
    console.log("usage:", fmt(result.usage), " ceiling:", fmt(budget));
  }

  console.log("\n=== 2. single research agent, budget too small to finish (expected: incomplete, usable partial) ===");
  {
    const orch = new Orchestrator();
    const budget: BudgetAmount = { tokens: 130, timeMs: 1000, costUsd: 1 };
    const result = await orch.run("competitor pricing", budget, researchAgent, { findings: [] });
    console.log("status:", result.status, " reason:", result.reason);
    console.log("findings salvaged:", result.partial.findings.length);
    for (const f of result.partial.findings) console.log(" -", f);
    console.log("usage:", fmt(result.usage), " ceiling:", fmt(budget));
  }

  console.log("\n=== 3. runaway: recursive planner with no base case (expected: bounded depth, never exceeds ceiling) ===");
  {
    const orch = new Orchestrator();
    const budget: BudgetAmount = { tokens: 500, timeMs: 2000, costUsd: 1 };
    const result = await orch.run("infinite plan", budget, recursivePlannerAgent, { depthReached: 0, trail: [] });
    console.log("status:", result.status, " reason:", result.reason);
    console.log("depth reached:", result.partial.depthReached, "(would be unbounded without enforcement)");
    console.log("usage:", fmt(result.usage), " ceiling:", fmt(budget));
    console.log("within ceiling:", result.usage.tokens <= budget.tokens && result.usage.timeMs <= budget.timeMs);
  }

  console.log("\n=== 4. runaway: infinite tool-call loop (expected: bounded call count, never exceeds ceiling) ===");
  {
    const orch = new Orchestrator();
    const budget: BudgetAmount = { tokens: 300, timeMs: 2000, costUsd: 1 };
    const result = await orch.run("loop forever", budget, infiniteToolLoopAgent, { callsCompleted: 0, lastResult: null });
    console.log("status:", result.status, " reason:", result.reason);
    console.log("calls completed:", result.partial.callsCompleted, "(would be infinite without enforcement)");
    console.log("usage:", fmt(result.usage), " ceiling:", fmt(budget));
    console.log("within ceiling:", result.usage.tokens <= budget.tokens && result.usage.timeMs <= budget.timeMs);
  }

  console.log("\n=== 5. runaway: slow-tool starvation (expected: time axis exhausts first, never exceeds ceiling) ===");
  {
    const orch = new Orchestrator();
    const budget: BudgetAmount = { tokens: 5000, timeMs: 300, costUsd: 1 };
    const result = await orch.run("starve the clock", budget, slowToolStarvationAgent, { callsCompleted: 0 });
    console.log("status:", result.status, " reason:", result.reason);
    console.log("calls completed:", result.partial.callsCompleted);
    console.log("usage:", fmt(result.usage), " ceiling:", fmt(budget));
    console.log("within ceiling:", result.usage.tokens <= budget.tokens && result.usage.timeMs <= budget.timeMs);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exitCode = 1;
});
