import type { Redis } from "ioredis";
import type { BudgetLedger } from "./types.js";
import type { BudgetAmount } from "../types.js";

/**
 * Redis-backed ledger for the "fast budget-check counters" half of the spec: when the
 * orchestrator is intercepting hundreds of tool calls per second across many concurrent
 * sub-agents, a round trip to Postgres per call is too slow to gate on. Redis with a Lua
 * script gives an atomic check-and-decrement in one network hop, no client-side races.
 *
 * NOT exercised by this repo's test suite — there's no Redis instance in this environment.
 * MemoryLedger implements the identical interface and is what backs every test; this file
 * exists so the pluggable-backend story is real code, not a stub. In a full deployment you'd
 * run RedisLedger for the hot check-and-decrement path and PostgresLedger (or an async
 * write-behind from Redis into Postgres) for durable audit history.
 *
 * Keys used per ledger node `id`:
 *   bl:{id}:parent            -> parent id ("" for root)
 *   bl:{id}:remaining:tokens  bl:{id}:remaining:time  bl:{id}:remaining:cost
 *   bl:{id}:used:tokens       bl:{id}:used:time       bl:{id}:used:cost
 *   bl:{id}:allocated:tokens  bl:{id}:allocated:time  bl:{id}:allocated:cost
 *   bl:{id}:reclaimed         -> "1" once reclaimed
 *
 * Cost is stored as an integer number of millicents to keep the Lua script pure-integer
 * (Redis Lua's number handling is lossy for large floats).
 */

// Atomically checks whether `remaining:*` covers the requested amounts and, if so,
// decrements remaining and increments used in one round trip. Returns 1 (ok) or 0 (denied).
const TRY_CONSUME_SCRIPT = `
local id = KEYS[1]
local tokens = tonumber(ARGV[1])
local timeMs = tonumber(ARGV[2])
local costMc = tonumber(ARGV[3])

local remTokens = tonumber(redis.call('GET', 'bl:' .. id .. ':remaining:tokens'))
local remTime = tonumber(redis.call('GET', 'bl:' .. id .. ':remaining:time'))
local remCost = tonumber(redis.call('GET', 'bl:' .. id .. ':remaining:cost'))

if remTokens == nil then return -1 end
if remTokens < tokens or remTime < timeMs or remCost < costMc then return 0 end

redis.call('DECRBY', 'bl:' .. id .. ':remaining:tokens', tokens)
redis.call('DECRBY', 'bl:' .. id .. ':remaining:time', timeMs)
redis.call('DECRBY', 'bl:' .. id .. ':remaining:cost', costMc)
redis.call('INCRBY', 'bl:' .. id .. ':used:tokens', tokens)
redis.call('INCRBY', 'bl:' .. id .. ':used:time', timeMs)
redis.call('INCRBY', 'bl:' .. id .. ':used:cost', costMc)
return 1
`;

const toMc = (usd: number) => Math.round(usd * 100000);
const fromMc = (mc: number) => mc / 100000;

export class RedisLedger implements BudgetLedger {
  constructor(private redis: Redis) {}

  async createRoot(id: string, budget: BudgetAmount): Promise<void> {
    await this.writeNode(id, "", budget, budget);
  }

  async allocateChild(parentId: string, childId: string, requested: BudgetAmount): Promise<BudgetAmount> {
    // Optimistic clamp-and-decrement with a WATCH/MULTI transaction so a concurrent
    // allocateChild on the same parent can't over-grant.
    const key = (suffix: string) => `bl:${parentId}:${suffix}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.redis.watch(key("remaining:tokens"), key("remaining:time"), key("remaining:cost"));
      const [remTokens, remTime, remCost] = await this.redis.mget(key("remaining:tokens"), key("remaining:time"), key("remaining:cost"));
      if (remTokens === null) {
        await this.redis.unwatch();
        throw new Error(`ledger node ${parentId} does not exist`);
      }
      const granted: BudgetAmount = {
        tokens: Math.max(0, Math.min(requested.tokens, Number(remTokens))),
        timeMs: Math.max(0, Math.min(requested.timeMs, Number(remTime))),
        costUsd: Math.max(0, Math.min(requested.costUsd, fromMc(Number(remCost)))),
      };
      const tx = this.redis.multi();
      tx.decrby(key("remaining:tokens"), granted.tokens);
      tx.decrby(key("remaining:time"), granted.timeMs);
      tx.decrby(key("remaining:cost"), toMc(granted.costUsd));
      const result = await tx.exec();
      if (result !== null) {
        await this.writeNode(childId, parentId, granted, granted);
        return granted;
      }
      // WATCH key changed concurrently — retry.
    }
    throw new Error(`allocateChild(${childId}) under ${parentId} lost the race too many times`);
  }

  async tryConsume(id: string, amount: BudgetAmount): Promise<boolean> {
    const result = (await this.redis.eval(TRY_CONSUME_SCRIPT, 1, id, amount.tokens, amount.timeMs, toMc(amount.costUsd))) as number;
    if (result === -1) throw new Error(`ledger node ${id} does not exist`);
    return result === 1;
  }

  async reclaim(childId: string): Promise<void> {
    const already = await this.redis.get(`bl:${childId}:reclaimed`);
    if (already === "1") return;
    const [parentId, remTokens, remTime, remCost] = await this.redis.mget(
      `bl:${childId}:parent`,
      `bl:${childId}:remaining:tokens`,
      `bl:${childId}:remaining:time`,
      `bl:${childId}:remaining:cost`
    );
    if (remTokens === null) throw new Error(`ledger node ${childId} does not exist`);
    const tx = this.redis.multi();
    tx.set(`bl:${childId}:reclaimed`, "1");
    tx.set(`bl:${childId}:remaining:tokens`, 0);
    tx.set(`bl:${childId}:remaining:time`, 0);
    tx.set(`bl:${childId}:remaining:cost`, 0);
    if (parentId) {
      tx.incrby(`bl:${parentId}:remaining:tokens`, Number(remTokens));
      tx.incrby(`bl:${parentId}:remaining:time`, Number(remTime));
      tx.incrby(`bl:${parentId}:remaining:cost`, Number(remCost));
    }
    await tx.exec();
  }

  async getRemaining(id: string): Promise<BudgetAmount> {
    const [tokens, timeMs, cost] = await this.redis.mget(`bl:${id}:remaining:tokens`, `bl:${id}:remaining:time`, `bl:${id}:remaining:cost`);
    if (tokens === null) throw new Error(`ledger node ${id} does not exist`);
    return { tokens: Number(tokens), timeMs: Number(timeMs), costUsd: fromMc(Number(cost)) };
  }

  async getUsage(id: string): Promise<BudgetAmount> {
    const [tokens, timeMs, cost] = await this.redis.mget(`bl:${id}:used:tokens`, `bl:${id}:used:time`, `bl:${id}:used:cost`);
    if (tokens === null) throw new Error(`ledger node ${id} does not exist`);
    return { tokens: Number(tokens), timeMs: Number(timeMs), costUsd: fromMc(Number(cost)) };
  }

  async getAllocated(id: string): Promise<BudgetAmount> {
    const [tokens, timeMs, cost] = await this.redis.mget(`bl:${id}:allocated:tokens`, `bl:${id}:allocated:time`, `bl:${id}:allocated:cost`);
    if (tokens === null) throw new Error(`ledger node ${id} does not exist`);
    return { tokens: Number(tokens), timeMs: Number(timeMs), costUsd: fromMc(Number(cost)) };
  }

  private async writeNode(id: string, parentId: string, allocated: BudgetAmount, remaining: BudgetAmount): Promise<void> {
    const tx = this.redis.multi();
    tx.set(`bl:${id}:parent`, parentId);
    tx.set(`bl:${id}:allocated:tokens`, allocated.tokens);
    tx.set(`bl:${id}:allocated:time`, allocated.timeMs);
    tx.set(`bl:${id}:allocated:cost`, toMc(allocated.costUsd));
    tx.set(`bl:${id}:remaining:tokens`, remaining.tokens);
    tx.set(`bl:${id}:remaining:time`, remaining.timeMs);
    tx.set(`bl:${id}:remaining:cost`, toMc(remaining.costUsd));
    tx.set(`bl:${id}:used:tokens`, 0);
    tx.set(`bl:${id}:used:time`, 0);
    tx.set(`bl:${id}:used:cost`, 0);
    await tx.exec();
  }
}
