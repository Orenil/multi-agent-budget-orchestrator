import type { AgentFn } from "../types.js";

/**
 * Legitimate agents used in the success-path tests and the demo CLI — they terminate on
 * their own, by design, unlike the runaway agents in `runawayAgents.ts`. Included so the
 * test suite exercises both "budget was never the bottleneck" and "budget was the
 * bottleneck" outcomes through the same orchestrator code path.
 */

export interface ResearchPartial {
  findings: string[];
  summary?: string;
}

/** search -> fetch each result -> summarize via the (simulated) LLM. Three to four
 *  intercepted calls total, each appended to `ctx.partial.findings` as it lands, so a
 *  budget cut anywhere in the sequence still leaves real, readable output behind. */
export const researchAgent: AgentFn<ResearchPartial> = async (ctx) => {
  const { results } = (await ctx.callTool("search", { q: ctx.task })) as { results: string[] };
  ctx.partial.findings.push(`search(${ctx.task}) -> ${results.join(", ")}`);
  for (const id of results) {
    const doc = (await ctx.callTool("fetch", { id })) as { body: string };
    ctx.partial.findings.push(doc.body);
  }
  ctx.partial.summary = await ctx.callLLM(`Summarize findings on "${ctx.task}": ${ctx.partial.findings.join(" / ")}`);
  return ctx.partial;
};

export interface PlannerPartial {
  subReports: string[];
  summary?: string;
}

/** Splits the task into two subtopics and spawns a `researchAgent` for each, handing
 *  every child half of whatever budget is left *at spawn time* (so the second child gets
 *  half of what remains after the first child's actual spend and reclaim, not a static
 *  pre-planned split). Demonstrates hierarchical allocate -> execute -> reclaim on a real
 *  multi-agent success path, not just the runaway harness. */
export const plannerAgent: AgentFn<PlannerPartial> = async (ctx) => {
  const subtopics = [`${ctx.task} — background`, `${ctx.task} — current state`];
  for (const subtopic of subtopics) {
    const remaining = await ctx.remaining();
    const half = {
      tokens: Math.floor(remaining.tokens / 2),
      timeMs: Math.floor(remaining.timeMs / 2),
      costUsd: remaining.costUsd / 2,
    };
    const result = await ctx.spawnSubAgent("research", researchAgent, subtopic, half, { findings: [] });
    if (result.status === "complete") {
      ctx.partial.subReports.push(`[${subtopic}] ${result.partial.summary}`);
    } else {
      ctx.partial.subReports.push(`[${subtopic}] INCOMPLETE (${result.reason}) — ${result.partial.findings.length} finding(s) salvaged`);
    }
  }
  ctx.partial.summary = `combined ${ctx.partial.subReports.length} sub-report(s) for "${ctx.task}"`;
  return ctx.partial;
};
