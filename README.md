# multi-agent-budget-orchestrator

An orchestration layer for multi-agent LLM workflows that enforces hard, hierarchical
token/time/cost budgets per sub-agent and per task — with a defined, structured
degradation behavior when a budget runs out, instead of silence or a thrown error.

## Problem

Multi-agent workflows have no natural termination guarantee. A planner with a bad plan,
or a sub-agent stuck in a tool-call loop, can run indefinitely. Most agent frameworks only
offer a global step-count limit, which doesn't map to anything a budget owner actually
cares about: a "step" can be a free cache hit or a $2 model call; a step-count ceiling
catches neither a token-hungry agent nor a wall-clock-slow one reliably.

This project enforces real budgets — tokens, wall-clock time, and cost, tracked
independently — at the layer that actually executes calls, not self-reported by the
agents spending them. Budgets are hierarchical: an orchestrator hands each sub-agent a
slice of its own remaining budget, and no sub-agent can spend more than the slice it was
actually granted, regardless of what it asks for or what its parent thinks it needs.

## Architecture

```
                        ┌─────────────────────────┐
                        │       Orchestrator        │
                        │  (only thing that touches │
                        │        the ledger)         │
                        └────────────┬───────────────┘
                                     │ creates
                                     ▼
                        ┌─────────────────────────┐
              ┌─────────┤   AgentContext (ctx)      │◄────────┐
              │         │  callTool / callLLM /      │         │
              │         │  spawnSubAgent / remaining  │         │
              │         └────────────┬───────────────┘         │
   agent code │                      │ every call checked        │ spawns a child
 (has *only*  │                      ▼ against ledger before      │ with a sub-budget
   this ctx)  │         ┌─────────────────────────┐               │ clamped to parent's
              │         │      BudgetLedger          │             │ remaining
              │         │  (Memory / Postgres /       │            │
              │         │   Redis — pluggable)        │            │
              │         └─────────────────────────┘               │
              └───────────────────────────────────────────────────┘
```

- **`src/types.ts`** — `BudgetAmount` (tokens/timeMs/costUsd), `AgentContext`,
  `AgentResult`, `BudgetExhaustedError`.
- **`src/ledger/`** — the `BudgetLedger` interface plus three implementations:
  `MemoryLedger` (Map-based, in-process — what the orchestrator uses by default and what
  every test in this repo runs against), `PostgresLedger` and `RedisLedger` (real,
  reviewed, pluggable backends — see "Ledger backends" below).
- **`src/interceptor.ts`** — builds the `AgentContext` handle. This is where every
  LLM/tool call is checked against the ledger *before* it runs, and where the "not
  self-reported" property lives: agent code has no reference to the ledger or the tool
  registry, only to the `ctx` the orchestrator hands it.
- **`src/orchestrator.ts`** — spawns sub-agents with sub-budgets carved out of the
  parent's remaining budget, runs each one under a wall-clock watchdog sized to its own
  allocation, reclaims unused budget when an agent finishes, and converts any budget
  exhaustion into a structured `AgentResult` instead of letting an exception escape.
- **`src/agents/realAgents.ts`** — well-behaved agents (`researchAgent`,
  `plannerAgent`) used to exercise the success path and the degrade-gracefully path.
- **`src/agents/runawayAgents.ts`** — the runaway-agent test harness: a recursive
  planner with no base case, an unbounded tool-call loop, and a slow-tool-starvation
  loop. Real control flow, not step-limited by their own code — only the orchestrator
  stops them.
- **`src/tools/simTools.ts`** — simulated tools with genuine `async`/`setTimeout`
  latency and real `AbortSignal` support, but deterministic output, so the whole suite
  runs fast and reproducibly with no network calls.

### Design decisions

**Budgets are three-dimensional (tokens, time, cost), enforced independently.**
Collapsing to one number (e.g. "N calls") hides the failure mode where an agent is cheap
per call but slow (network-bound tool), or fast but token-hungry (verbose model, tight
loop). The slow-tool-starvation runaway agent exists specifically to prove the *time*
axis is enforced even when tokens/cost are barely touched.

**Allocation happens by earmarking, not by promise.** `BudgetLedger.allocateChild`
immediately deducts the granted amount from the parent's remaining pool at spawn time,
clamped to what's actually left (componentwise min, per axis). A parent cannot allocate
more to its children in total than it was given — the ledger enforces this structurally,
not by trusting the orchestrator's bookkeeping.

**Spawning has a fixed coordination-overhead cost, charged to the parent.** This was the
non-obvious piece: without it, a chain of sub-agents that spawn each other but never call
a tool would never actually shrink the shared budget (a child spawned with "whatever the
parent has left" just inherits the same number forever). Charging a small, fixed,
non-zero cost on every spawn attempt guarantees strictly monotonic depletion, so a
recursive planner with literally no base case is still bounded — by budget divided by
overhead, a real number, not a hidden step counter. See `SPAWN_OVERHEAD` in
`src/orchestrator.ts`.

**A wall-clock watchdog backs up the per-call checks.** Each ledger node runs under a
`setTimeout` sized to its own allocated time budget, wired to an `AbortSignal` that every
simulated tool honors. This means a node is terminated even if it never makes another
intercepted call between when its budget should have run out and whenever it next checks
— genuine preemption, not cooperative polling.

**Degradation is a return value, not an exception.** `BudgetExhaustedError` is thrown
internally at the point of an over-budget call, but it never crosses the
`Orchestrator.run()` boundary: the orchestrator catches it and returns
`{ status: "incomplete", reason: "budget_exhausted", partial, usage, note }`. Agents
build `ctx.partial` incrementally (push a finding after each successful step) so that
whatever was produced before the cutoff is exactly what comes back — not an empty object,
not a stack trace.

**Usage rolls up through the tree.** An `AgentResult.usage` is the ledger node's own
direct spend *plus* the (already-aggregated) usage of every sub-agent it spawned, so the
top-level result tells you the true cost of the whole run, not just what the root
coordinator itself happened to call.

### Rejected tradeoffs

- **A global step-count ceiling instead of real budgets.** Rejected because it's exactly
  the thing the spec identifies as inadequate — it doesn't distinguish a free cache hit
  from an expensive model call, and can't catch a wall-clock-slow agent that makes very
  few, very expensive-in-time calls.
- **Self-reported usage** (agents call `ctx.reportUsage(...)` themselves). Rejected
  because a buggy or adversarial sub-agent can simply not call it, or lie. Every call this
  codebase counts is counted by the interceptor at the moment it intercepts the call, from
  a cost model the agent doesn't control.
- **Killing a sub-agent by rejecting its next call only** (no wall-clock watchdog).
  Rejected because an agent stuck in a loop with no intercepted calls in it (e.g. spinning
  on local logic between spawns) would never hit that check. The `setTimeout`-based
  watchdog is real preemption independent of agent cooperation.
- **A hard depth counter on sub-agent spawning.** Rejected in favor of the
  spawn-coordination-overhead charge for the same reason as the step-count ceiling: a
  counter is an arbitrary number picked by the framework author, unrelated to actual
  resource cost. The overhead charge is denominated in the same currency as everything
  else in the system (tokens/time/cost), so the bound composes correctly with whatever
  budget the caller actually configured, instead of needing its own separately-tuned knob.

## Why this is one collapsed TypeScript service, not a distributed system

The spec describes a control plane (TypeScript/Node) coordinating a Python sidecar that
actually executes agent logic, backed by Postgres and Redis. Given this project's scope
ceiling, that's collapsed into a single Node process:

- **Agents are real, in-process TypeScript async functions**, not calls out to a Python
  process. They do genuine (if deterministic/simulated) planning and tool-call work —
  including the runaway ones, which have real unbounded control flow, not a mocked
  "pretend to loop" stand-in.
- **The ledger is pluggable but defaults to an in-process Map** (`MemoryLedger`). It's
  what the orchestrator uses unless you inject something else, and it's the only backend
  the test suite exercises.
- **Postgres and Redis adapters are included as real, complete, reviewed
  implementations** of the same `BudgetLedger` interface (`src/ledger/postgresLedger.ts`,
  `src/ledger/redisLedger.ts`) — correct transactional/atomic logic (`SELECT ... FOR
  UPDATE` for Postgres, an atomic Lua `EVAL` for Redis), fully documented, but **not run**
  in this repo: there's no database or Redis instance in this environment, and wiring one
  up was out of scope for a single-service portfolio project. Swapping one in is a
  constructor argument: `new Orchestrator({ ledger: new PostgresLedger(pool) })`.

**How a real distributed version would differ:**

1. Agent execution would move to a separate process (the spec's Python sidecar, or any
   language) communicating with the Node control plane over IPC/gRPC/HTTP. The
   interceptor's admission check (`ledger.tryConsume` before the call runs) would happen
   at that IPC boundary — the control plane would refuse to forward a tool/LLM call to the
   sidecar at all once budget is exhausted, rather than the current in-process function
   call being denied.
2. Termination of a runaway sidecar agent would be a process kill /
   container-stop, not an `AbortController` — a stronger guarantee than cooperative
   cancellation, since a hung or malicious child process can't ignore SIGKILL the way it
   could in principle ignore an `AbortSignal` if it didn't check it (all tools in this repo
   do check it, but that's a property of code we trust here; a real sandboxed agent
   process should not be assumed to cooperate).
3. **A subtlety this collapse genuinely hides:** in-process, "an agent bypasses the
   interceptor" isn't fully preventable — nothing stops agent code from `import`-ing
   `src/tools/simTools.ts` directly and calling a tool's `run()` without going through
   `ctx`. The enforcement here is structural-by-convention: the demo/test agents only ever
   use `ctx`, and that's the only capability handle this codebase hands out. A real
   deployment closes this gap for real by running agent code in a separate process (or a
   V8 isolate / worker with no access to the tool implementations at all) so there is no
   direct reference to bypass — the interceptor becomes a network boundary, not just an
   API design convention.
4. The ledger would run as an actual Postgres+Redis pair (durable audit trail + fast hot
   path), as designed in `src/ledger/postgresLedger.ts` / `redisLedger.ts`, instead of a
   Map cleared when the process exits.

## Setup

Requires Node 18+ (tested on Node 23).

```bash
git clone https://github.com/Orenil/multi-agent-budget-orchestrator.git
cd multi-agent-budget-orchestrator
npm install
npm test
```

## Usage

Run the demo, which executes five real scenarios end-to-end and prints actual measured
usage against the configured ceiling for each:

```bash
npm start
```

Real output from this repo:

```
=== 1. planner + 2x research sub-agents, generous budget (expected: complete) ===
status: complete
summary: combined 2 sub-report(s) for "quarterly market scan"
 - [quarterly market scan — background] [deterministic-llm response#ze54f1] re: Summarize findings on "quarterly market scan — background": ...
 - [quarterly market scan — current state] [deterministic-llm response#y86z3z] re: Summarize findings on "quarterly market scan — current state...
usage: tokens=760 timeMs=168 costUsd=0.00444  ceiling: tokens=5000 timeMs=5000 costUsd=1.00000

=== 2. single research agent, budget too small to finish (expected: incomplete, usable partial) ===
status: incomplete  reason: budget_exhausted
findings salvaged: 1
 - search(competitor pricing) -> doc:1660aa-a, doc:1660aa-b
usage: tokens=40 timeMs=15 costUsd=0.00040  ceiling: tokens=130 timeMs=1000 costUsd=1.00000

=== 3. runaway: recursive planner with no base case (expected: bounded depth, never exceeds ceiling) ===
status: complete  reason: undefined
depth reached: 34 (would be unbounded without enforcement)
usage: tokens=495 timeMs=165 costUsd=0.00165  ceiling: tokens=500 timeMs=2000 costUsd=1.00000
within ceiling: true

=== 4. runaway: infinite tool-call loop (expected: bounded call count, never exceeds ceiling) ===
status: incomplete  reason: budget_exhausted
calls completed: 60 (would be infinite without enforcement)
usage: tokens=300 timeMs=120 costUsd=0.00060  ceiling: tokens=300 timeMs=2000 costUsd=1.00000
within ceiling: true

=== 5. runaway: slow-tool starvation (expected: time axis exhausts first, never exceeds ceiling) ===
status: incomplete  reason: budget_exhausted
calls completed: 2
usage: tokens=20 timeMs=240 costUsd=0.00040  ceiling: tokens=5000 timeMs=300 costUsd=1.00000
within ceiling: true
```

### Minimal API example

```ts
import { Orchestrator } from "./src/orchestrator.js";
import { researchAgent } from "./src/agents/realAgents.js";

const orchestrator = new Orchestrator(); // defaults to MemoryLedger + the sim tool registry

const result = await orchestrator.run(
  "battery chemistry",              // task
  { tokens: 2000, timeMs: 2000, costUsd: 1 }, // budget
  researchAgent,
  { findings: [] }                  // initial partial accumulator
);

// result.status is "complete" or "incomplete"
// result.partial is always populated — real findings either way
// result.usage is the actual tokens/time/cost spent, including sub-agents
```

To use a durable ledger instead of the in-process default:

```ts
import { Pool } from "pg";
import { PostgresLedger } from "./src/ledger/postgresLedger.js";

const orchestrator = new Orchestrator({ ledger: new PostgresLedger(new Pool()) });
```

## Testing

```bash
npm test
```

Real output from this repo:

```
 RUN  v3.2.7 /Users/mac/multi-agent-budget-orchestrator

 ✓ test/ledger.test.ts (10 tests) 3ms
 ✓ test/integration.test.ts (5 tests) 240ms
 ✓ test/runaway.test.ts (5 tests) 438ms

 Test Files  3 passed (3)
      Tests  20 passed (20)
```

- **`test/ledger.test.ts`** — hierarchical allocation/reclaim unit tests: clamping to a
  parent's remaining budget per axis, multi-level (grandchild) hierarchies, idempotent
  reclaim, and a full budget-conservation check (remaining + used across the tree equals
  the original allocation).
- **`test/runaway.test.ts`** — the runaway-agent harness: a recursive planner with no
  base case, an unbounded tool-call loop, and slow-tool starvation, each asserted to
  terminate for real (not hang past the test timeout) and to never report usage beyond
  its configured ceiling on any axis.
- **`test/integration.test.ts`** — success-path completion, and the partial-result
  degradation path: asserts a budget cutoff mid-run returns a structured `incomplete`
  result with real, readable partial content (never a thrown error, never an empty
  object), including when the cutoff happens inside a spawned sub-agent.

## Known limitations / cut from scope

- No real LLM or network calls — `callLLM` and the simulated tools are deterministic
  stand-ins so the suite is fast, reproducible, and free to run. The cost-modeling and
  budget-enforcement logic they exercise is real; the "intelligence" behind each call is
  not.
- `PostgresLedger` and `RedisLedger` are real, complete implementations but are not
  exercised by any test in this repo — there's no database/Redis instance available here.
  `MemoryLedger` implements the identical interface and is what every test runs against.
- In-process agent code can technically bypass the interceptor by importing the tool
  registry directly (see "Why this is one collapsed service" above) — this is an
  acknowledged limitation of collapsing everything into one trusted process rather than a
  gap in the interceptor's logic itself.
- A pure synchronous infinite loop with no `await` inside it (e.g. `while (true) {}` with
  no tool calls) cannot be preempted by anything in this design — or by any design without
  worker threads, since it never yields to the event loop. Every agent in this repo
  (including the runaway ones) is realistically modeled as async, since real agent actions
  (tool calls, LLM calls) are inherently asynchronous; this is a known boundary of
  single-threaded JS, not something budget accounting can fix.
