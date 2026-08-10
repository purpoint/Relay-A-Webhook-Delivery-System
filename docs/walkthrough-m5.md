# Relay — M5 Walkthrough: Observability & the Proof

A complete, beginner-level explanation of the final backend milestone. Assumes you've read [walkthrough.md](walkthrough.md) and [M1](walkthrough-m1.md)–[M4](walkthrough-m4.md).

M4 made Relay work. M5 makes it **inspectable**, and then proves the claim the whole project was built to make.

---

# Part 1 — The question this milestone answers

A customer emails: *"We sent an event two hours ago and it never arrived."*

After M4, Relay could handle that situation perfectly — store the event, retry with backoff, recover from crashes — and there was **no way to look at any of it.** The information existed in Postgres; nothing exposed it.

That gap matters more than it sounds. A delivery platform where customers can't see what happened generates a support ticket for every failure, and each one requires an engineer with database access to answer. The read side isn't a nice-to-have; it's what makes the product operable.

So M5 adds six endpoints, interactive documentation, and the load test.

---

# Part 2 — Delivery history

| Method | Path | Answers |
|---|---|---|
| `GET` | `/projects/:id/events` | What have we published? |
| `GET` | `/projects/:id/events/:eventId` | What was in this event? |
| `GET` | `/projects/:id/events/:eventId/deliveries` | Where was it sent, and how did it go? |
| `GET` | `/projects/:id/deliveries/:deliveryId` | Full history for one delivery |
| `POST` | `/projects/:id/deliveries/:deliveryId/replay` | Try that one again |
| `GET` | `/projects/:id/stats` | Overall health |

## What a delivery view contains

```json
{
  "id": "d4f8...",
  "status": "WAITING",
  "attempt": 2,
  "webhook": { "id": "w1...", "url": "https://customer.com/hook" },
  "nextRetryAt": "2026-08-10T22:14:03.000Z",
  "lastError": "HTTP 500: internal server error",
  "responseStatus": 500,
  "attempts": [
    { "attempt": 1, "responseStatus": 500, "errorMessage": "boom", "durationMs": 42 },
    { "attempt": 2, "responseStatus": 500, "errorMessage": "boom", "durationMs": 39 }
  ]
}
```

That answers the customer's question without anyone touching a database. Their endpoint returned `500` twice, we're trying again at a stated time, and here's how long each attempt took.

The `attempts` array is why `DeliveryAttempt` was in the schema back in M0. `Delivery` holds the *current* state; `DeliveryAttempt` holds the *history* behind it. Without the second table you'd know a delivery had failed twice but nothing about how.

---

# Part 3 — Pagination, and why `OFFSET` is a trap

The obvious way to paginate:

```sql
SELECT * FROM events ORDER BY created_at DESC LIMIT 25 OFFSET 10000
```

"Skip 10,000 rows, give me 25." It reads naturally and it is wrong in two ways.

## It gets slower the deeper you go

Postgres cannot jump to row 10,000. It must **produce and discard** all 10,000 first. Page 400 does forty times the work of page 10 to return the same 25 rows. On a table with millions of events — which is exactly what Relay accumulates — deep pages become unusable.

## It shows duplicates

Worse, and less obvious.

You read page 1 (rows 1–25). While you're reading, a new event arrives and takes position 1, pushing everything down. You request page 2 with `OFFSET 25` — but what *was* row 25 is now row 26, so you see it again.

Rows can also be skipped entirely if something is deleted. The results are simply not consistent while the data moves, and in a system ingesting events continuously the data is always moving.

## Keyset pagination

Instead of "skip 10,000", say **"give me what comes after this specific row"**:

```
GET /events?limit=25
  → { events: [...], nextCursor: "a3f8-..." }

GET /events?limit=25&cursor=a3f8-...
```

The cursor is the last row's id. The database seeks straight to it using the index — the same speed at page 400 as at page 1 — and new arrivals at the top can't shift your position, because your position is a row, not a count.

## The trick for `nextCursor`

Knowing whether more pages exist normally means a second `COUNT(*)` query, which is expensive and stale by the time it returns.

Instead: **ask for one more row than you need.**

```ts
const rows = await listEvents({ limit: options.limit + 1 });
const hasMore = rows.length > options.limit;
```

Ask for 26, get 26 → there's more. Get 25 → that's the end. One query, exact answer.

## And a cap

```ts
limit: z.coerce.number().int().min(1).max(100).default(25)
```

Without a maximum, `?limit=10000000` is a request to load the entire table into memory. Any parameter controlling result size needs a ceiling.

---

# Part 4 — Replay

Sometimes a delivery fails permanently — the endpoint was misconfigured, and once fixed the customer wants their events resent.

```
POST /projects/:id/deliveries/:deliveryId/replay
```

## What it deliberately does not do

It does **not** send the webhook.

It resets the row to `PENDING` and stops. The scheduler picks it up on its next tick, the window admits it if there's room, a worker delivers it. Exactly as if it were new.

That restraint is the design. A replay that sent directly would be a **second delivery mechanism**, and it would need its own retry logic, its own crash handling, its own concurrency safety — all of which would drift out of step with the real one. Going through the normal path means replay inherits every property already built: the window cap, jittered backoff, lease recovery.

> When you're tempted to add a fast path around your own system, the question is what you'd have to reimplement to make it safe. Usually it's everything.

## Refusing when it isn't safe

```ts
if (delivery.status !== "FAILED" && delivery.status !== "DELIVERED") {
  throw new ConflictError(...)
}
```

Only terminal deliveries can be replayed.

A `QUEUED` or `PROCESSING` delivery is *already on its way*. Resetting it would either send it twice, or strand whatever worker is currently holding it. So the API returns `409 Conflict` and explains why.

Refusing loudly beats succeeding quietly and corrupting state. The customer can retry in a moment; a duplicate payment notification is not so easily undone.

## Resetting the attempt counter

```ts
data: { status: "PENDING", attempt: 0, lastError: null, ... }
```

A replayed delivery starts fresh. If it kept `attempt: 8`, it would be immediately over the limit and fail on its first try — technically a replay, practically useless.

---

# Part 5 — Who can read history

Every endpoint in this milestone requires a **JWT**. An API key returns `401`.

That's the M1 containment decision paying off in a concrete way. Recall the two credential types:

| | Lives for | Can |
|---|---|---|
| JWT | 1 hour | Everything |
| API key | Years, in a config file | Publish events. Nothing else. |

An API key is the credential most likely to leak — it sits in server configs, `.env` files, occasionally a git repo. If it could read history, a leaked key would expose **every event the customer has ever sent**, including payloads containing customer data.

It can't. A leaked key can publish junk events, which is noisy and recoverable. It cannot read anything.

There's a test asserting exactly that: `GET /events` with a valid API key returns `401`.

---

# Part 6 — Swagger

`/docs` serves interactive documentation generated from the API definition.

It's the interim interface the plan called for. Until M6's monitor exists, this is the only way to explore Relay that isn't `curl` — and it doubles as the reference a customer integrating against the API would read.

The description spells out the two things most likely to confuse someone new:

- The two credential types, and that they are **not interchangeable**
- Why publishing returns **`202`, not `201`** — acceptance means durably stored, not delivered

It's disabled under `NODE_ENV=test`, where nothing reads it and it only slows startup.

---

# Part 7 — The load test

The point of the whole project, made repeatable.

## Why it needed to be a script

Every run before this was assembled by hand — start these processes, publish some events, watch some numbers. That's fine for finding bugs and useless as evidence. A claim you can only demonstrate by improvising isn't a claim anyone else can check.

So: `npm run receiver` and `npm run load-test`.

## The receiver

A stand-in for a customer endpoint that reads its behaviour from a file **on every request**:

```bash
echo fail > /tmp/relay-receiver-mode   # 500
echo ok   > /tmp/relay-receiver-mode   # 200
echo hang > /tmp/relay-receiver-mode   # accept and never answer
```

Reading per-request rather than at startup is what makes the interesting moment possible: **flipping a dead endpoint healthy while everything runs**, with nothing restarted.

## It asserts, rather than displays

```ts
if (s.occupancy > WINDOW) breached = true;
...
if (breached) process.exitCode = 1;
```

The script fails if Redis ever exceeds the cap. That makes it a test, not a demo you have to squint at.

---

# Part 8 — The results

50,000 events, one webhook, endpoint returning `500`.

## Phase 1 — the endpoint is down

```
elapsed |  postgres | redis  (ready+flight) | PENDING  WAITING   QUEUED DELIVERED  FAILED
0s      |     50000 |  2949 ( 2924+ 25) |    1076    46070     2842         0       0
6s      |     50000 |     0 (    0+  0) |       0    49525      450         0       0
12s     |     50000 |   808 (  783+ 25) |       0    49254      732         0       0
24s     |     50000 |     0 (    0+  0) |       0    50000        0         0       0
34s     |     50000 |     0 (    0+  0) |       0    50000        0         0       0
40s     |     50000 |   737 (  718+ 19) |       0    49316      668         0       0

Window cap:            5,000
Peak Redis occupancy:  3,035
Deliveries in Postgres: 50,000
```

**Read the `24s` row. It is the entire project in one line.**

```
postgres 50,000     WAITING 50,000     redis 0
```

Fifty thousand pending deliveries. **Redis holding nothing at all.**

Every one had failed, been recorded in Postgres with a jittered future retry time, and left Redis completely. The backlog costs **zero memory**. Scale it to the 1.68 million from the original problem statement and that column still reads `0`.

Notice also the sawtooth: the window fills to ~3,000, drains as workers process, refills. Occupancy never approached 5,000 because 25 workers were consuming faster than the scheduler refilled — a system comfortably within capacity.

## Phase 2 — recovery

`echo ok > /tmp/relay-receiver-mode`. Nothing restarted.

```
elapsed | redis | WAITING DELIVERED FAILED
0s      |     0 |    1905     48095      0
20s     |     0 |     750     49250      0
46s     |     0 |      14     49986      0
106s    |     0 |       2     49998      0

final: delivered=50000 failed=0 total=50000
```

**50,000 delivered. Zero failed.**

And afterwards:

```
window=0  inflight=0  dedupe=0
```

Redis completely clean. No leaked slots, no orphans, no stragglers.

The receiver's own tally:

```
delivered=50000 rejected=192808
```

**192,808 failed attempts** were tracked, backed off and rescheduled — entirely through Postgres — while Redis never exceeded 3,035.

## Why recovery took 100 seconds rather than 5

Attempt counts had reached 3–6 by then, so each delivery was waiting out a backoff of up to ~160 seconds, jittered.

That's not slowness, it's the design working. The retries arrived spread across their windows instead of as one synchronised wall — which is precisely what full jitter exists to produce. A recovering endpoint gets a ramp, not a flood.

---

# Part 9 — Every file

| File | Responsibility |
|---|---|
| `repositories/event-query.repository.ts` | Read-side queries, keyset pagination |
| `services/event-query.service.ts` | History, replay rules, page assembly |
| `routes/v1/event-query.routes.ts` | Six JWT-protected endpoints |
| `config/swagger.ts` | Interactive docs at `/docs` |
| `scripts/receiver.mjs` | Switchable fake customer endpoint |
| `scripts/load-test.mjs` | The proof, as a pass/fail script |

## Why the read side is a separate repository

`event.repository.ts` owns the write path; `event-query.repository.ts` owns reads.

They have genuinely different shapes. Writes are one transaction on the hottest path in the system, where every millisecond counts. Reads are paginated joins that a human is waiting on and a hundred milliseconds is fine.

Keeping them apart means the ingest path doesn't accumulate query helpers it never calls, and it's obvious at a glance which code runs 10,000 times a minute and which runs when someone opens a dashboard.

---

# Part 10 — Where the backend stands

| Check | Result |
|---|---|
| `npm run typecheck` | Clean |
| `npm run lint` | Clean |
| `npm test` | 232 passing |
| Load test, 50,000 events | **PASSED** — peak 3,035 of 5,000 |
| Recovery | 50,000 delivered, 0 failed |
| Redis after | window 0, in-flight 0, dedupe 0 |

**The backend is complete.** Every milestone from M0 to M5 is done, and the claim the project was built to demonstrate has been shown under load, with the numbers written down.

## What's left

Neither remaining milestone is backend work.

**M6** turns the monitor output above into a single live page. The table in Part 8 is convincing to someone who reads it carefully; a gauge pinned at its ceiling while a counter climbs past it is convincing in about ten seconds. One screen, no CRUD forms — the reasoning is in [milestone.md](milestone.md).

It also forces three backend additions the frontend causes: CORS, refresh tokens (a one-hour JWT logs a person out mid-task), and a deliberate decision about where the browser keeps its token.

**M7** deploys it, so the proof lives at a URL rather than in a README.

---

# Appendix — New terms

| Term | Meaning |
|---|---|
| **Cursor** | A row marker used to fetch the next page, instead of a numeric offset |
| **Keyset pagination** | Paging by "after this row" rather than "skip N rows" |
| **OFFSET** | SQL's skip-N-rows, which must produce and discard everything skipped |
| **OpenAPI** | The specification format Swagger UI renders |
| **Read side / write side** | Splitting query code from mutation code; they have different demands |
| **Replay** | Requeueing a terminal delivery for another attempt |
| **Sawtooth** | The fill-drain-refill pattern of a queue under steady consumption |
| **Terminal state** | A status nothing will change on its own — here, `DELIVERED` or `FAILED` |
