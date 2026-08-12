import type { Pool } from "pg";
import type { BudgetLedger } from "./types.js";
import type { BudgetAmount } from "../types.js";

/**
 * Postgres-backed ledger: durable budget accounting that survives orchestrator restarts
 * and gives you a real audit trail (`SELECT * FROM budget_ledger WHERE id = ...`) of who
 * spent what. This is the backend you'd point at in production for the "budget ledger"
 * half of the spec.
 *
 * NOT exercised by this repo's test suite — there's no Postgres instance in this
 * environment. The code is real and reviewed for correctness (row-level locking via
 * `SELECT ... FOR UPDATE` makes tryConsume atomic under concurrent writers, which is the
 * property that actually matters here), but it has not been run against a live database.
 * MemoryLedger implements the identical interface and is what backs every test.
 *
 * Schema (run once):
 *
 *   CREATE TABLE budget_ledger (
 *     id             TEXT PRIMARY KEY,
 *     parent_id      TEXT REFERENCES budget_ledger(id),
 *     allocated_tokens  BIGINT NOT NULL,
 *     allocated_time_ms BIGINT NOT NULL,
 *     allocated_cost    NUMERIC NOT NULL,
 *     remaining_tokens  BIGINT NOT NULL,
 *     remaining_time_ms BIGINT NOT NULL,
 *     remaining_cost    NUMERIC NOT NULL,
 *     used_tokens    BIGINT NOT NULL DEFAULT 0,
 *     used_time_ms   BIGINT NOT NULL DEFAULT 0,
 *     used_cost      NUMERIC NOT NULL DEFAULT 0,
 *     reclaimed      BOOLEAN NOT NULL DEFAULT FALSE
 *   );
 */
export class PostgresLedger implements BudgetLedger {
  constructor(private pool: Pool) {}

  async createRoot(id: string, budget: BudgetAmount): Promise<void> {
    await this.pool.query(
      `INSERT INTO budget_ledger
         (id, parent_id, allocated_tokens, allocated_time_ms, allocated_cost,
          remaining_tokens, remaining_time_ms, remaining_cost)
       VALUES ($1, NULL, $2, $3, $4, $2, $3, $4)`,
      [id, budget.tokens, budget.timeMs, budget.costUsd]
    );
  }

  async allocateChild(parentId: string, childId: string, requested: BudgetAmount): Promise<BudgetAmount> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT remaining_tokens, remaining_time_ms, remaining_cost
           FROM budget_ledger WHERE id = $1 FOR UPDATE`,
        [parentId]
      );
      if (rows.length === 0) throw new Error(`ledger node ${parentId} does not exist`);
      const granted: BudgetAmount = {
        tokens: Math.max(0, Math.min(requested.tokens, rows[0].remaining_tokens)),
        timeMs: Math.max(0, Math.min(requested.timeMs, rows[0].remaining_time_ms)),
        costUsd: Math.max(0, Math.min(requested.costUsd, Number(rows[0].remaining_cost))),
      };
      await client.query(
        `UPDATE budget_ledger
            SET remaining_tokens = remaining_tokens - $2,
                remaining_time_ms = remaining_time_ms - $3,
                remaining_cost = remaining_cost - $4
          WHERE id = $1`,
        [parentId, granted.tokens, granted.timeMs, granted.costUsd]
      );
      await client.query(
        `INSERT INTO budget_ledger
           (id, parent_id, allocated_tokens, allocated_time_ms, allocated_cost,
            remaining_tokens, remaining_time_ms, remaining_cost)
         VALUES ($1, $2, $3, $4, $5, $3, $4, $5)`,
        [childId, parentId, granted.tokens, granted.timeMs, granted.costUsd]
      );
      await client.query("COMMIT");
      return granted;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async tryConsume(id: string, amount: BudgetAmount): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT remaining_tokens, remaining_time_ms, remaining_cost
           FROM budget_ledger WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (rows.length === 0) throw new Error(`ledger node ${id} does not exist`);
      const r = rows[0];
      if (r.remaining_tokens < amount.tokens || r.remaining_time_ms < amount.timeMs || Number(r.remaining_cost) < amount.costUsd) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `UPDATE budget_ledger
            SET remaining_tokens = remaining_tokens - $2,
                remaining_time_ms = remaining_time_ms - $3,
                remaining_cost = remaining_cost - $4,
                used_tokens = used_tokens + $2,
                used_time_ms = used_time_ms + $3,
                used_cost = used_cost + $4
          WHERE id = $1`,
        [id, amount.tokens, amount.timeMs, amount.costUsd]
      );
      await client.query("COMMIT");
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async reclaim(childId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT parent_id, remaining_tokens, remaining_time_ms, remaining_cost, reclaimed
           FROM budget_ledger WHERE id = $1 FOR UPDATE`,
        [childId]
      );
      if (rows.length === 0) throw new Error(`ledger node ${childId} does not exist`);
      const child = rows[0];
      if (child.reclaimed) {
        await client.query("ROLLBACK");
        return;
      }
      await client.query(`UPDATE budget_ledger SET reclaimed = TRUE, remaining_tokens = 0, remaining_time_ms = 0, remaining_cost = 0 WHERE id = $1`, [childId]);
      if (child.parent_id) {
        await client.query(
          `UPDATE budget_ledger
              SET remaining_tokens = remaining_tokens + $2,
                  remaining_time_ms = remaining_time_ms + $3,
                  remaining_cost = remaining_cost + $4
            WHERE id = $1`,
          [child.parent_id, child.remaining_tokens, child.remaining_time_ms, child.remaining_cost]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getRemaining(id: string): Promise<BudgetAmount> {
    const { rows } = await this.pool.query(`SELECT remaining_tokens, remaining_time_ms, remaining_cost FROM budget_ledger WHERE id = $1`, [id]);
    if (rows.length === 0) throw new Error(`ledger node ${id} does not exist`);
    return { tokens: rows[0].remaining_tokens, timeMs: rows[0].remaining_time_ms, costUsd: Number(rows[0].remaining_cost) };
  }

  async getUsage(id: string): Promise<BudgetAmount> {
    const { rows } = await this.pool.query(`SELECT used_tokens, used_time_ms, used_cost FROM budget_ledger WHERE id = $1`, [id]);
    if (rows.length === 0) throw new Error(`ledger node ${id} does not exist`);
    return { tokens: rows[0].used_tokens, timeMs: rows[0].used_time_ms, costUsd: Number(rows[0].used_cost) };
  }

  async getAllocated(id: string): Promise<BudgetAmount> {
    const { rows } = await this.pool.query(`SELECT allocated_tokens, allocated_time_ms, allocated_cost FROM budget_ledger WHERE id = $1`, [id]);
    if (rows.length === 0) throw new Error(`ledger node ${id} does not exist`);
    return { tokens: rows[0].allocated_tokens, timeMs: rows[0].allocated_time_ms, costUsd: Number(rows[0].allocated_cost) };
  }
}
