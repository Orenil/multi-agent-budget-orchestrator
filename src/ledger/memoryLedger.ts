import type { BudgetLedger } from "./types.js";
import { addBudget, minBudget, subBudget, zeroBudget, type BudgetAmount } from "../types.js";

interface Node {
  parentId: string | null;
  allocated: BudgetAmount;
  remaining: BudgetAmount;
  used: BudgetAmount;
  reclaimed: boolean;
}

/**
 * In-process, Map-based ledger. Node.js is single-threaded and every method here does
 * its check-and-mutate without an `await` in between, so operations on a given node are
 * atomic with respect to concurrent async callers (no interleaving can happen inside a
 * synchronous block). This is the ledger actually exercised by the orchestrator and the
 * full test suite — the fast counters described in the spec, minus the network hop.
 */
export class MemoryLedger implements BudgetLedger {
  private nodes = new Map<string, Node>();

  async createRoot(id: string, budget: BudgetAmount): Promise<void> {
    if (this.nodes.has(id)) throw new Error(`ledger node ${id} already exists`);
    this.nodes.set(id, { parentId: null, allocated: budget, remaining: { ...budget }, used: zeroBudget(), reclaimed: false });
  }

  async allocateChild(parentId: string, childId: string, requested: BudgetAmount): Promise<BudgetAmount> {
    const parent = this.mustGet(parentId);
    const granted = minBudget(requested, parent.remaining);
    // Clamp negatives (a parent with zero left on some axis grants zero on that axis).
    granted.tokens = Math.max(0, granted.tokens);
    granted.timeMs = Math.max(0, granted.timeMs);
    granted.costUsd = Math.max(0, granted.costUsd);
    parent.remaining = subBudget(parent.remaining, granted);
    this.nodes.set(childId, { parentId, allocated: granted, remaining: { ...granted }, used: zeroBudget(), reclaimed: false });
    return granted;
  }

  async tryConsume(id: string, amount: BudgetAmount): Promise<boolean> {
    const node = this.mustGet(id);
    if (
      node.remaining.tokens < amount.tokens ||
      node.remaining.timeMs < amount.timeMs ||
      node.remaining.costUsd < amount.costUsd
    ) {
      return false;
    }
    node.remaining = subBudget(node.remaining, amount);
    node.used = addBudget(node.used, amount);
    return true;
  }

  async reclaim(childId: string): Promise<void> {
    const child = this.mustGet(childId);
    if (child.reclaimed) return; // idempotent: double-reclaim is a no-op, not a double-credit
    child.reclaimed = true;
    if (!child.parentId) return; // root nodes have nothing to reclaim into
    const parent = this.mustGet(child.parentId);
    parent.remaining = addBudget(parent.remaining, child.remaining);
    child.remaining = zeroBudget();
  }

  async getRemaining(id: string): Promise<BudgetAmount> {
    return { ...this.mustGet(id).remaining };
  }

  async getUsage(id: string): Promise<BudgetAmount> {
    return { ...this.mustGet(id).used };
  }

  async getAllocated(id: string): Promise<BudgetAmount> {
    return { ...this.mustGet(id).allocated };
  }

  private mustGet(id: string): Node {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`ledger node ${id} does not exist`);
    return n;
  }
}
