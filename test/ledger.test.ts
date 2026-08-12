import { describe, expect, it } from "vitest";
import { MemoryLedger } from "../src/ledger/memoryLedger.js";

/**
 * Unit tests on the ledger in isolation — no orchestrator, no agents. These pin down the
 * hierarchical allocation/reclaim contract that everything else (interceptor, runaway
 * harness) depends on being correct.
 */
describe("MemoryLedger — hierarchical allocation", () => {
  it("grants a child exactly what it requests when the parent can afford it", async () => {
    const ledger = new MemoryLedger();
    await ledger.createRoot("root", { tokens: 1000, timeMs: 1000, costUsd: 1 });
    const granted = await ledger.allocateChild("root", "child", { tokens: 300, timeMs: 200, costUsd: 0.3 });
    expect(granted).toEqual({ tokens: 300, timeMs: 200, costUsd: 0.3 });
    expect(await ledger.getRemaining("root")).toEqual({ tokens: 700, timeMs: 800, costUsd: 0.7 });
    expect(await ledger.getRemaining("child")).toEqual({ tokens: 300, timeMs: 200, costUsd: 0.3 });
  });

  it("clamps a child's request to the parent's remaining budget, per axis independently", async () => {
    const ledger = new MemoryLedger();
    await ledger.createRoot("root", { tokens: 100, timeMs: 5000, costUsd: 0.01 });
    // Requests more tokens and cost than the parent has, but less time.
    const granted = await ledger.allocateChild("root", "child", { tokens: 9999, timeMs: 10, costUsd: 999 });
    expect(granted).toEqual({ tokens: 100, timeMs: 10, costUsd: 0.01 });
    // Parent is now fully drained on tokens/cost but still has time left.
    expect(await ledger.getRemaining("root")).toEqual({ tokens: 0, timeMs: 4990, costUsd: 0 });
  });

  it("never grants a negative allocation even when the parent is already overdrawn on an axis", async () => {
    const ledger = new MemoryLedger();
    await ledger.createRoot("root", { tokens: 10, timeMs: 10, costUsd: 10 });
    await ledger.allocateChild("root", "child-a", { tokens: 10, timeMs: 10, costUsd: 10 });
    // root is now at 0 remaining on every axis; a second allocation must grant zero, not throw.
    const granted = await ledger.allocateChild("root", "child-b", { tokens: 50, timeMs: 50, costUsd: 50 });
    expect(granted).toEqual({ tokens: 0, timeMs: 0, costUsd: 0 });
  });

  it("supports multi-level hierarchies (grandchildren draw from the child's earmarked pool, not the root's)", async () => {
    const ledger = new MemoryLedger();
    await ledger.createRoot("root", { tokens: 1000, timeMs: 1000, costUsd: 1 });
    await ledger.allocateChild("root", "child", { tokens: 400, timeMs: 400, costUsd: 0.4 });
    const grandGranted = await ledger.allocateChild("child", "grandchild", { tokens: 9999, timeMs: 9999, costUsd: 9999 });
    // Grandchild is clamped to the *child's* remaining (400), not the root's (600 left).
    expect(grandGranted).toEqual({ tokens: 400, timeMs: 400, costUsd: 0.4 });
    expect(await ledger.getRemaining("root")).toEqual({ tokens: 600, timeMs: 600, costUsd: 0.6 });
  });
});

describe("MemoryLedger — consumption", () => {
  it("deducts on successful tryConsume and tracks usage separately from remaining", async () => {
    const ledger = new MemoryLedger();
    await ledger.createRoot("root", { tokens: 100, timeMs: 100, costUsd: 1 });
    const ok = await ledger.tryConsume("root", { tokens: 30, timeMs: 10, costUsd: 0.1 });
    expect(ok).toBe(true);
    expect(await ledger.getRemaining("root")).toEqual({ tokens: 70, timeMs: 90, costUsd: 0.9 });
    expect(await ledger.getUsage("root")).toEqual({ tokens: 30, timeMs: 10, costUsd: 0.1 });
  });

  it("refuses to consume past zero on any single axis, and deducts nothing when refused", async () => {
    const ledger = new MemoryLedger();
    await ledger.createRoot("root", { tokens: 100, timeMs: 100, costUsd: 1 });
    // Affordable on tokens/cost but not time.
    const ok = await ledger.tryConsume("root", { tokens: 10, timeMs: 200, costUsd: 0.1 });
    expect(ok).toBe(false);
    // Nothing was deducted — a rejected call must be a true no-op, not a partial charge.
    expect(await ledger.getRemaining("root")).toEqual({ tokens: 100, timeMs: 100, costUsd: 1 });
    expect(await ledger.getUsage("root")).toEqual({ tokens: 0, timeMs: 0, costUsd: 0 });
  });
});

describe("MemoryLedger — reclaim", () => {
  it("credits a finished child's unused remainder back to its parent", async () => {
    const ledger = new MemoryLedger();
    await ledger.createRoot("root", { tokens: 1000, timeMs: 1000, costUsd: 1 });
    await ledger.allocateChild("root", "child", { tokens: 500, timeMs: 500, costUsd: 0.5 });
    await ledger.tryConsume("child", { tokens: 200, timeMs: 100, costUsd: 0.2 }); // child only spends 200/100/0.2
    expect(await ledger.getRemaining("root")).toEqual({ tokens: 500, timeMs: 500, costUsd: 0.5 }); // still earmarked
    await ledger.reclaim("child");
    // Root gets back exactly what the child didn't spend (300/400/0.3), not the full 500.
    expect(await ledger.getRemaining("root")).toEqual({ tokens: 800, timeMs: 900, costUsd: 0.8 });
    expect(await ledger.getRemaining("child")).toEqual({ tokens: 0, timeMs: 0, costUsd: 0 });
  });

  it("makes a later sibling's allocation reflect an earlier sibling's reclaimed leftovers", async () => {
    const ledger = new MemoryLedger();
    await ledger.createRoot("root", { tokens: 1000, timeMs: 1000, costUsd: 1 });
    await ledger.allocateChild("root", "child-a", { tokens: 900, timeMs: 900, costUsd: 0.9 });
    await ledger.tryConsume("child-a", { tokens: 100, timeMs: 100, costUsd: 0.1 });
    await ledger.reclaim("child-a"); // returns 800/800/0.8 to root

    // Before reclaim, a second child requesting 900 would have been clamped to 100.
    // After reclaim, root has 900 again, so the second child gets its full request.
    const grantedB = await ledger.allocateChild("root", "child-b", { tokens: 900, timeMs: 900, costUsd: 0.9 });
    expect(grantedB).toEqual({ tokens: 900, timeMs: 900, costUsd: 0.9 });
  });

  it("is idempotent — reclaiming twice does not double-credit the parent", async () => {
    const ledger = new MemoryLedger();
    await ledger.createRoot("root", { tokens: 100, timeMs: 100, costUsd: 1 });
    await ledger.allocateChild("root", "child", { tokens: 100, timeMs: 100, costUsd: 1 });
    await ledger.reclaim("child");
    await ledger.reclaim("child");
    expect(await ledger.getRemaining("root")).toEqual({ tokens: 100, timeMs: 100, costUsd: 1 });
  });

  it("conserves total budget across allocate + partial spend + reclaim (root remaining + usage == original)", async () => {
    const ledger = new MemoryLedger();
    const original = { tokens: 1000, timeMs: 1000, costUsd: 1 };
    await ledger.createRoot("root", original);
    await ledger.allocateChild("root", "child", { tokens: 600, timeMs: 600, costUsd: 0.6 });
    await ledger.tryConsume("child", { tokens: 250, timeMs: 150, costUsd: 0.25 });
    await ledger.tryConsume("root", { tokens: 50, timeMs: 50, costUsd: 0.05 }); // root spends directly too
    await ledger.reclaim("child");

    const rootRemaining = await ledger.getRemaining("root");
    const rootUsage = await ledger.getUsage("root");
    const childUsage = await ledger.getUsage("child");
    const total = {
      tokens: rootRemaining.tokens + rootUsage.tokens + childUsage.tokens,
      timeMs: rootRemaining.timeMs + rootUsage.timeMs + childUsage.timeMs,
      costUsd: rootRemaining.costUsd + rootUsage.costUsd + childUsage.costUsd,
    };
    expect(total.tokens).toBeCloseTo(original.tokens, 10);
    expect(total.timeMs).toBeCloseTo(original.timeMs, 10);
    expect(total.costUsd).toBeCloseTo(original.costUsd, 10);
  });
});
