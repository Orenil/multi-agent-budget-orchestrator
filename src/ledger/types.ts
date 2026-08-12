import type { BudgetAmount } from "../types.js";

/**
 * Pluggable budget-ledger backend. This is the single source of truth for "how much
 * budget does node X have left" — the orchestrator's interceptor consults it on every
 * intercepted call, and agents have no way to reach it directly.
 *
 * Three implementations exist:
 *  - MemoryLedger: Map-based, in-process. Used by the orchestrator by default and
 *    exercised by the whole test suite.
 *  - PostgresLedger: durable ledger for auditability across process restarts.
 *  - RedisLedger: sub-millisecond check-and-decrement for high-QPS deployments.
 *
 * Postgres/Redis are real, correct implementations of this interface (see their files
 * for design notes) but are not exercised in this repo's test run — there's no database
 * or Redis instance available in this environment. MemoryLedger is what actually backs
 * every test and the runaway-agent harness.
 */
export interface BudgetLedger {
  /** Create a root ledger node with no parent. */
  createRoot(id: string, budget: BudgetAmount): Promise<void>;

  /**
   * Allocate a child node under `parentId`. The requested budget is clamped to the
   * parent's *current remaining* budget (componentwise min) and immediately deducted
   * from the parent — this is the "earmarking" step that makes hierarchical enforcement
   * real: a parent cannot allocate more to its children than it actually has left, and
   * once allocated, that slice is unavailable to siblings until reclaimed.
   * Returns the amount actually allocated (may be less than requested).
   */
  allocateChild(parentId: string, childId: string, requested: BudgetAmount): Promise<BudgetAmount>;

  /**
   * Atomically check-and-deduct `amount` from node `id`'s remaining budget. Returns
   * false (and deducts nothing) if `amount` would drive any axis negative. This is the
   * fast path the interceptor calls before executing every LLM/tool call.
   */
  tryConsume(id: string, amount: BudgetAmount): Promise<boolean>;

  /**
   * Return unused allocation from a finished child back to its parent's remaining pool.
   * Called once, when a sub-agent completes (whether successfully or via exhaustion) —
   * whatever the child never spent goes back so siblings spawned afterward can use it.
   */
  reclaim(childId: string): Promise<void>;

  getRemaining(id: string): Promise<BudgetAmount>;
  getUsage(id: string): Promise<BudgetAmount>;
  getAllocated(id: string): Promise<BudgetAmount>;
}
