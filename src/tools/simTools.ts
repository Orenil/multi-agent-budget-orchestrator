import type { ToolSpec } from "../types.js";
import { abortableDelay } from "../util.js";

/**
 * Simulated tools with genuine async behavior (real `setTimeout` latency, real
 * `AbortSignal` cancellation) but deterministic outputs — no network calls, so the test
 * suite is fast and reproducible. Each tool declares an `estimate` used for the
 * interceptor's pre-flight admission check; `run()` is the real (if simplified)
 * implementation that actually consumes wall-clock time.
 */

/** Cheap, fast lookup — a few ms of latency, small token cost. */
export const searchTool: ToolSpec = {
  name: "search",
  estimate: { tokens: 40, timeMs: 15, costUsd: 0.0004 },
  async run(args, signal) {
    const { q } = args as { q: string };
    await abortableDelay(10, signal);
    return { results: [`doc:${hash(q)}-a`, `doc:${hash(q)}-b`] };
  },
};

/** Fetch a "document" body — moderate latency. */
export const fetchTool: ToolSpec = {
  name: "fetch",
  estimate: { tokens: 120, timeMs: 25, costUsd: 0.0008 },
  async run(args, signal) {
    const { id } = args as { id: string };
    await abortableDelay(20, signal);
    return { id, body: `synthetic content for ${id}, checksum ${hash(id)}` };
  },
};

/** Deliberately slow tool — used by the starvation runaway agent to drain time budget fast. */
export const slowFetchTool: ToolSpec = {
  name: "slowFetch",
  estimate: { tokens: 10, timeMs: 120, costUsd: 0.0002 },
  async run(_args, signal) {
    await abortableDelay(120, signal);
    return { body: "slow payload" };
  },
};

/** Pure-compute tool, near-zero cost — used by the infinite-loop runaway agent so its
 *  budget drain comes from call *count*, not any single expensive call. */
export const computeTool: ToolSpec = {
  name: "compute",
  estimate: { tokens: 5, timeMs: 2, costUsd: 0.00001 },
  async run(args, signal) {
    await abortableDelay(1, signal);
    const { n } = args as { n: number };
    return { squared: n * n };
  },
};

export const ALL_TOOLS: ToolSpec[] = [searchTool, fetchTool, slowFetchTool, computeTool];

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
