# Relay — M3 Walkthrough: The Execution Window

A complete, beginner-level explanation of the fourth milestone. Assumes you've read [walkthrough.md](walkthrough.md), [M1](walkthrough-m1.md) and [M2](walkthrough-m2.md).

**This is the milestone the project is named after.** Everything before it was competent backend work that thousands of projects also have. This is the part that is actually Relay.

---

# Part 1 — The idea, one more time

After M2 the database held deliveries that were completely stuck. Nothing existed to pick them up.

The obvious fix is a queue: push every pending delivery into Redis, let workers pull them off. That is how most webhook platforms work, and it fails in a specific way.

## The failure

A customer's endpoint goes down. They generate 10,000 events an hour. Nobody notices for a week.

```
10,000 × 24 × 7 = 1,680,000 pending deliveries
```

If those live in Redis, you are holding 1.68 million records **in RAM**. Not because they are being worked on — they can't be, the endpoint is down — but because that's where you happened to put the waiting list. RAM is the most expensive storage you have and you have spent it on work that cannot proceed.

A few customers having a bad week at once and Redis runs out of memory. Everything stops, including all the customers whose endpoints are perfectly healthy.

## Relay's answer

> Redis holds only the jobs that are **executable right now**, and never more than a fixed number of them.

```
Postgres        1,680,000 deliveries        on disk, cheap, permanent
Redis                 5,000 delivery IDs    in RAM, bounded, always
```

The number is fixed. Not "usually around 5,000", not "5,000 unless there's a spike". **Exactly at most 5,000**, whether the backlog behind it is five thousand or five million.

M3 builds the thing that enforces that.

---

# Part 2 — Three keys

The window is three Redis keys, and nothing outside one class is allowed to touch them.

| Key | Type | Holds |
|---|---|---|
| `relay:window` | LIST | delivery IDs ready to execute |
| `relay:inflight` | LIST | claimed by a worker, outcome unknown |
| `relay:enqueued` | SET | membership guard |

**Occupancy is `LLEN window + LLEN inflight`.** Two commands. That exactness is the entire point — it is why the cap is something you can *demonstrate* rather than something you assert in a README.

## Why in-flight counts

A worker claims a job. It leaves the ready list, so `LLEN relay:window` drops. Is it still "in Redis"?

Yes. It's sitting in the in-flight list, occupying memory, and the worker holding it might take thirty seconds to finish.

If occupancy ignored in-flight jobs, then with 5,000 jobs all claimed simultaneously the scheduler would see an empty window and cheerfully add 5,000 more. Then 5,000 more. The window would grow without bound **precisely when workers were busiest** — which is exactly when you can least afford it.

## Why the dedupe set

Without it, the same delivery could be pushed twice and two workers would send the same webhook to the same customer. Duplicate payment notifications are not a cosmetic bug.

---

# Part 3 — Why Lua

The scripts in `src/queue/scripts.ts` are the least obvious part of M3, and the reason is worth understanding properly.

## Redis runs one thing at a time

Redis processes commands one after another, so any *single* command is safe.

The problem is that our operations are not single commands. Adding to the window means:

1. Read how full it is
2. Decide how many fit
3. Write that many

Between steps 1 and 3, other clients get to run.

## The race

Two schedulers, both healthy, both doing exactly the right thing:

```
Scheduler A:  LLEN → 4,900.  Room for 100.
Scheduler B:  LLEN → 4,900.  Room for 100.
Scheduler A:  RPUSH 100  →  5,000
Scheduler B:  RPUSH 100  →  5,100    ← the invariant is gone
```

Neither made a mistake. Both read a value that was true when they read it. They just both acted on it.

This is a **check-then-act race**, and it is the same shape as the idempotency race in M2 — which is not a coincidence. Whenever you read state, make a decision, and then write, something else can move between the read and the write.

## What Lua fixes

A Lua script runs **atomically**. Redis executes the whole thing with nothing interleaved. B cannot read until A has entirely finished.

```lua
local occupancy = redis.call('LLEN', readyKey) + redis.call('LLEN', inFlightKey)

for i = 2, #ARGV do
  if occupancy >= capacity then break end
  if redis.call('SADD', dedupeKey, ARGV[i]) == 1 then
    redis.call('RPUSH', readyKey, ARGV[i])
    occupancy = occupancy + 1
  end
end
```

Two details worth noticing.

**Capacity is re-checked every iteration**, not computed once. Offer 500 jobs to a window with 80 slots and it takes exactly 80 and stops.

**`SADD` returns 1 for new, 0 for already-present.** Using its return value makes "is this queued?" and "mark it queued" one indivisible step. `SISMEMBER` followed by `SADD` would reintroduce the same race inside the script we wrote to eliminate it.

---

# Part 4 — Claiming, and the job that vanishes

Workers take jobs with **`BLMOVE`** — one command that pops from one list and pushes to another.

```
BLMOVE relay:window relay:inflight LEFT RIGHT 5
```

Scheduler appends on the right, workers take from the left, so the oldest eligible delivery goes first. The `5` means "wait up to 5 seconds if empty" — the worker sleeps rather than spinning.

## Why not pop then push?

```
id = LPOP relay:window          ← job is now in no list at all
RPUSH relay:inflight id
```

Between those two lines the job exists **only in the worker's memory**.

If the worker dies there — a crash, an OOM kill, an abrupt deploy — the job is simply gone from Redis. And here's the part that makes it worse: the dedupe set still contains its ID, so the scheduler believes it is safely queued and will never offer it again.

The delivery is never sent. Nothing errors. Nothing is logged. It is a permanently stuck row that no component is looking at.

`BLMOVE` makes that state impossible. The job is always in exactly one list.

---

# Part 5 — The scheduler

`src/scheduler/scheduler.ts`. One tick:

```
1. Reclaim deliveries abandoned by dead workers
2. capacity = windowSize − occupancy
3. If capacity is 0 → done, sleep
4. Claim that many eligible deliveries from Postgres
5. Offer them to the window
6. Mark the accepted ones QUEUED
7. Sleep, repeat
```

## What "eligible" means

```sql
WHERE status = 'PENDING'
   OR (status = 'WAITING' AND "nextRetryAt" <= $now)
```

Two states, and the second is the one that makes the whole architecture work.

`WAITING` means a delivery failed and is waiting to be retried. **It is not in Redis.** It sits in Postgres with a future `nextRetryAt`, completely invisible to this query until its moment arrives.

That is why a million failed deliveries cost nothing. They're rows on a disk. The scheduler doesn't even look at them.

## `FOR UPDATE SKIP LOCKED`

The query ends:

```sql
LIMIT $1
FOR UPDATE SKIP LOCKED
```

This is what lets you run more than one scheduler.

- **`FOR UPDATE`** locks the selected rows until the transaction ends.
- **`SKIP LOCKED`** tells any other transaction: don't wait for locked rows, just skip past them.

Without `SKIP LOCKED`, scheduler B would block until A committed — pointless serialisation. Without `FOR UPDATE` at all, both would select the same rows and hand the same delivery to two workers, and the customer gets the webhook twice.

With both, A takes rows 1–500 and B takes 501–1000, simultaneously, no coordination and no overlap.

Prisma has no API for this, so it's the one raw SQL query in the codebase. Tested with four concurrent schedulers against 300 deliveries: exactly 50 land in a 50-slot window.

## The ordering that makes it self-healing

Look carefully at where the Redis call sits:

```ts
prisma.$transaction(async (tx) => {
  const rows = await tx.$queryRaw`SELECT ... FOR UPDATE SKIP LOCKED`;
  const accepted = await offerToWindow(rows.map(r => r.id));   // ← Redis, inside
  await tx.delivery.updateMany({ where: { id: { in: accepted } }, ... });
});
```

Redis is offered the IDs **inside the transaction**, and only what it accepts gets marked `QUEUED`. Walk the failure cases:

| What fails | What happens |
|---|---|
| Redis rejects some (window full) | Those rows stay `PENDING`, picked up next tick |
| Redis is unreachable | Callback throws, transaction rolls back, nothing changed |
| Process dies after Redis accepted, before commit | Rows roll back to `PENDING`; IDs remain in Redis. A worker claims one, sees the row isn't `QUEUED`, discards it and frees the slot |

Every one degrades to *"try again shortly"*. None produces a stuck delivery or a duplicate one.

That third case is the interesting one. The system ends up briefly inconsistent — Redis thinks a job exists that Postgres doesn't agree is queued — and it **repairs itself** as a side effect of normal operation. That's a much better property than being impossible to break, because being impossible to break is rarely achievable.

## Recovering from a dead worker

A worker sets `PROCESSING` and stamps `lockedAt` when it claims a delivery. If it dies mid-request, that row stays `PROCESSING` forever and its Redis slot is never freed. Enough of those and the window fills with work nobody is doing.

The reaper finds `PROCESSING` rows whose `lockedAt` is older than `LEASE_TIMEOUT_MS` and returns them to `WAITING`.

**Postgres decides, Redis is told.** In that order, deliberately. Clear Redis first and die before the database update, and the row is `PROCESSING` with no slot and no owner — invisible to everything.

### One judgement call: the attempt counter

A reclaimed delivery has its `attempt` incremented, even though the worker never got a response. That feels unfair — we're counting our own crash against the customer's delivery.

It's deliberate. Imagine a payload that reliably kills the worker processing it. Without counting the attempt, that delivery cycles forever, taking down a worker each time, indefinitely. Counting it means such a delivery eventually reaches `FAILED` and stops being a hazard.

The cost is that a routine deploy consumes one attempt from anything in flight. Against `MAX_ATTEMPTS = 8`, that's an acceptable trade.

---

# Part 6 — The timezone bug

The best bug in this milestone, because it looks like correct code.

## The query

```sql
WHERE nextRetryAt <= now()
```

Read that. It's obviously right. "Give me deliveries whose retry time has passed."

It was wrong by five and a half hours.

## What actually happens

Two facts collide:

1. `nextRetryAt` is `timestamp` **without time zone**, holding UTC values — that's how Prisma writes `DateTime`
2. Postgres `now()` returns `timestamptz` — **with** time zone

Comparing a `timestamp` to a `timestamptz` makes Postgres convert one of them, using **the database session's timezone**.

This machine's Postgres runs `Asia/Kolkata`:

```
now()              → 2026-08-10 15:07:28+05:30
now()::timestamp   → 2026-08-10 15:07:28        ← what the comparison uses
actual UTC         → 2026-08-10 09:37:28        ← what the column holds
```

The query's "now" was **5½ hours in the future**.

## The consequence

Every retry scheduled less than 5½ hours ahead looked due immediately.

Exponential backoff — the mechanism that gives a struggling endpoint room to recover — would have been completely defeated. Relay would have hammered exactly the endpoints that were already failing, which is the single worst thing a delivery platform can do.

And in a *negative* offset timezone the same bug runs the other way: deliveries stall past their due time and sit there.

## Why it's nasty

- Nothing errors. The query runs fine and returns rows.
- It depends on a **server setting**, not on the code. Same code, different machine, different behaviour.
- It would pass on a developer laptop set to UTC and fail in production, or the reverse.
- The symptom — "retries are firing too fast" — points nowhere near the cause.

## The fix

Stop consulting the database clock:

```ts
const now = new Date();
// ...  WHERE "nextRetryAt" <= ${now}
```

Prisma serialises that Date the same way it writes the column, so the comparison no longer depends on any server setting.

## The lesson

> When two systems both have a clock, decide which one is authoritative — and never let the answer be "whichever one the query happened to consult."

The regression test uses a deliberately small **5-minute** offset, so it fails under *any* timezone skew rather than only a dramatic one.

---

# Part 7 — The rate limit found by load testing

The other bug in M3, and it came from running the thing rather than thinking about it.

## What happened

First attempt at publishing 12,000 events to watch the window fill:

```
accepted: 100    rejected: 11,900
```

The global rate limit — 100 requests a minute — was being applied to event ingest.

## Why that was badly wrong

100 requests a minute is a sensible ceiling for a **person** clicking around a dashboard.

For a **machine** publishing events it is catastrophic. A customer with any real traffic hits it in the first second of every minute and gets rejected for the remaining fifty-nine. For comparison, Stripe allows roughly 100 requests per *second*.

That isn't throttling. It's an outage with a `429` status code.

## The fix

Three limits, matched to who is actually calling:

| Endpoints | Limit | Reasoning |
|---|---|---|
| Auth | 10/min | Credential stuffing target; each attempt costs an Argon2 hash, so it's a CPU exhaustion vector too |
| Management | 100/min | A person using a dashboard |
| Ingest | 6000/min | A machine publishing in bulk — 100/second |

All configurable by environment variable.

## The lesson

**A single global rate limit is almost always wrong**, because "a request" isn't one kind of thing. A login, a dashboard click and a bulk event publish have nothing in common except the transport.

I'd have found this eventually in production, when a customer complained their events were vanishing. Load testing found it in about ninety seconds.

---

# Part 8 — Watching it work

The demonstration. 6,000 deliveries in Postgres, a 5,000 window, no workers running so nothing drains.

```
elapsed  postgres  | redis:window  inflight  dedupe | QUEUED  PENDING  cap
0.0s     6000      | 0            0         0      | 0       6000     5000
1.6s     6000      | 5000         0         5000   | 5000    1000     5000
3.1s     6000      | 5000         0         5000   | 5000    1000     5000
6.3s     6000      | 5000         0         5000   | 5000    1000     5000
9.4s     6000      | 5000         0         5000   | 5000    1000     5000
14.0s    6000      | 5000         0         5000   | 5000    1000     5000
```

Read across the `1.6s` row:

- **Postgres holds all 6,000.** Nothing was discarded.
- **Redis holds exactly 5,000.** Not 4,998, not 5,013.
- **1,000 remain `PENDING`** on disk, costing nothing.

Then read *down*. The scheduler keeps ticking every two seconds. It finds no capacity and does nothing. The window sits at 5,000 indefinitely.

Scale the numbers to a real outage — 1.68 million in Postgres — and the middle column still reads 5,000.

---

# Part 9 — Every file

| File | Responsibility |
|---|---|
| `queue/QueueAdapter.ts` | The interface — put in, take out, report fullness |
| `queue/scripts.ts` | Three Lua scripts, with the races they prevent |
| `queue/RedisWindowQueue.ts` | The implementation over three keys |
| `repositories/delivery.repository.ts` | Eligibility query, reaper, counts |
| `scheduler/scheduler.ts` | The loop |
| `scheduler/main.ts` | Process entrypoint and graceful shutdown |

## Two smaller decisions

**Batching.** The scheduler claims 500 at a time rather than filling all 5,000 in one query. A single statement selecting 5,000 rows holds locks on all of them for its whole duration and returns one large result set. Shorter transactions are easier to reason about and easier on the database.

**A failed tick never ends the loop.** If Postgres restarts or Redis blips, the tick is logged and the loop continues. If the scheduler process exited on error, the window would stop refilling and **every delivery in the system would silently stall** — a far worse outcome than one lost cycle.

---

# Part 10 — Where we are

| Check | Result |
|---|---|
| `npm run typecheck` | Clean |
| `npm run lint` | Clean |
| `npm test` | 137 passing |
| Window cap, 6,000 backlog | Exactly 5,000, held |

Redis is finally installed, so `/readyz` reports `{"database":true,"redis":true}` for the first time since M0.

> A note on that install: Homebrew's Redis 8.10.0 ships a `redis.conf` referencing bundled modules by relative path that aren't in the package, so the service crash-looped on startup. Those `loadmodule` lines are commented out (config backed up first). Relay uses only lists, sets and Lua, so none of them were needed.

## What's still missing

**Nothing consumes the window.** 5,000 delivery IDs are sitting in Redis and no process is taking them. `BLMOVE` is implemented and tested, but no worker calls it.

That's M4:

- A worker pool claiming jobs with `BLMOVE`
- HMAC-SHA256 signing, so receivers can verify the request is genuinely from us
- The real HTTP request, with a timeout
- `2xx` → `DELIVERED`; otherwise `WAITING` with an exponential backoff and **full jitter**
- Redis released on every path, in a `finally`

The jitter matters more than it sounds. Without it, 5,000 deliveries that failed together retry together, and a recovering endpoint gets a synchronised wall of traffic at exactly the moment it can least handle it.

---

# Appendix — New terms

| Term | Meaning |
|---|---|
| **Atomic** | Runs as one indivisible step; nothing interleaves |
| **BLMOVE** | Redis command that pops from one list and pushes to another, atomically, blocking if empty |
| **Check-then-act race** | Two processes both read a value before either acts on it |
| **Execution window** | The bounded set of jobs resident in Redis |
| **FIFO** | First in, first out — oldest job served first |
| **FOR UPDATE** | SQL locking the selected rows for the transaction |
| **Lease** | A time-limited claim on a job, so a dead worker doesn't hold it forever |
| **Lua script** | Code Redis runs atomically, server-side |
| **Occupancy** | Jobs currently in the window: ready plus in-flight |
| **Reaper** | The pass that recovers work from crashed workers |
| **SKIP LOCKED** | SQL instruction to pass over locked rows rather than wait |
| **timestamptz** | A Postgres timestamp that carries a timezone; `timestamp` does not |
