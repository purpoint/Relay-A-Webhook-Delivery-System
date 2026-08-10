# Relay — M4 Walkthrough: The Worker Pool

A complete, beginner-level explanation of the fifth milestone. Assumes you've read [walkthrough.md](walkthrough.md), [M1](walkthrough-m1.md), [M2](walkthrough-m2.md) and [M3](walkthrough-m3.md).

**This is the milestone where Relay finally sends a webhook.** Everything before it stored, scheduled and bounded. Nothing had ever made an outbound request.

---

# Part 1 — What a worker does

The whole job, in six steps:

```
1. Take a delivery ID from the window        (BLMOVE)
2. Take ownership of the row                 (conditional UPDATE)
3. Sign the payload                          (HMAC-SHA256)
4. Send the HTTP request                     (with a timeout)
5. Record what happened                      (DELIVERED / WAITING / FAILED)
6. Release the Redis slot                    (always)
```

Then repeat, forever.

Workers keep **no state between jobs**. That's what makes running twenty identical to running one, twenty times over — and it's why the worker is the tier you scale when a backlog builds.

Two things a worker deliberately never does:

- **It never decides what to work on.** That's the scheduler's job. A worker takes whatever the window hands it.
- **It never adds to the window.** It only ever removes finished work.

---

# Part 2 — Signing, and why it's necessary

## The problem

Your webhook arrives at the customer's server as an ordinary HTTP POST from an IP they've never seen, carrying JSON.

How do they know it came from us?

They don't. The URL is not a secret — it appears in configuration files, logs, error reports, and it only has to leak once. Anyone who learns it can post whatever they like, and the customer's system would process a fabricated "payment succeeded" exactly like a real one.

## The solution

Every request carries a signature: an **HMAC-SHA256** of the request body, computed with the secret shared with that specific webhook.

```
X-Relay-Signature: t=1700000000,v1=5257a869e7bcf6f0...
```

The receiver recomputes it from the body they actually received and compares. A match proves two things simultaneously:

- The sender holds the secret, so it's us
- The body is byte-identical to what we signed, so nothing was altered in transit

### What HMAC is, briefly

A hash with a key. `SHA256("hello")` is something anyone can compute. `HMAC-SHA256(secret, "hello")` can only be computed by someone holding the secret — and it cannot be worked backwards to recover it.

## The detail that matters: signing the timestamp

The signed string is not the body alone. It's:

```
{timestamp}.{body}
```

Here's why that matters enormously.

Suppose we sent the timestamp as a separate, unsigned header. An attacker captures one genuine request — from a log, a proxy, anywhere. A week later they replay it, editing only the timestamp header to look current. The signature still matches, because the signature never covered the timestamp.

That reduces the whole scheme to *"this was valid at some point in history"*, which is nearly worthless.

By signing the timestamp **with** the body, changing it invalidates the signature. The attacker can replay the original, but the receiver sees an old timestamp, checks it against its tolerance window, and rejects it.

There's a test performing exactly that forgery and asserting it fails.

### And the dot

Without a separator, timestamp `12` with body `"34x"` and timestamp `1` with body `"234x"` produce the identical string `1234x`. Two different requests, one signature. The `.` makes them distinct.

## Tolerance in both directions

The receiver rejects anything more than five minutes old — that's the replay defence.

It also rejects anything more than five minutes in the **future**. Bounding only the past would mean a captured request stamped years ahead stays valid indefinitely.

## Why the version prefix

```
v1=5257a869...
```

If we ever need a different scheme, we can send `v1` and `v2` together for a transition period. Receivers understanding only `v1` keep working. Without the prefix, any change breaks every customer at once.

---

# Part 3 — Retry timing, and the herd

## Exponential backoff

An endpoint is down. We retry. It's still down. When do we try again?

Fixed intervals are wrong: every 5 seconds for an endpoint down for two hours is 1,440 pointless requests aimed at a server that's struggling.

Exponential backoff doubles the wait each time — 5s, 10s, 20s, 40s, 80s — giving a struggling endpoint progressively more room while staying responsive to a brief blip.

## The problem exponential backoff alone doesn't solve

This is the part worth understanding, because it only appears at scale and it's counter-intuitive.

Five thousand deliveries are queued for one endpoint. The endpoint goes down. They all fail within the same second.

With pure exponential backoff, **every one of them computes the same delay**. Five thousand retries fire at the same instant — a wall of traffic hitting a server that is already unwell.

They all fail again. And now they're synchronised for the next round too. And the one after.

Worse, it's self-reinforcing: **the spike is what's keeping the endpoint down**, and being down is what keeps the group in lockstep. You've built a machine that periodically attacks your customer.

This is called a **thundering herd**.

## Full jitter

Instead of waiting exactly `delay`, wait a random amount between `0` and `delay`:

```ts
return Math.floor(random() * ceiling);
```

Those 5,000 retries now spread evenly across the whole window. The endpoint sees a manageable trickle instead of a wall.

And the synchronisation is broken **permanently** — after one jittered round the group has scattered and never re-converges.

"Full" jitter (the whole range) rather than a smaller fraction because it's the variant AWS measured as minimising both completion time and server load. It does mean a retry can happen almost immediately, which is fine — the goal is spreading the *group*, not delaying each member.

The test fires 5,000 deliveries and asserts the delays land in all four quarters of the window rather than clustering.

## Which failures are worth retrying

Not all of them.

| Status | Retry? | Why |
|---|---|---|
| `5xx` | **Yes** | The endpoint is unwell and may recover |
| `408`, `425` | **Yes** | Timing problems; the same request may work later |
| `429` | **Yes** | They're asking us to slow down, not to stop |
| Other `4xx` | **No** | `404`, `401`, `422` — the identical request gets the identical answer |
| `3xx` | **No** | See below |
| No response at all | **Yes** | DNS, refused connection, timeout — describes the network right now |

Retrying a `404` eight times wastes both sides' resources and delays the customer discovering their endpoint is misconfigured.

### Why 3xx is a failure, not a redirect to follow

We do **not** follow redirects, and that's a security decision rather than a convenience one.

Following one would deliver to a URL that never passed the SSRF checks from M2. It's the perfect bypass: register a clean public endpoint, have it return `302 → http://169.254.169.254/`, and every protection is circumvented in one step.

So a `3xx` means the endpoint isn't where the customer registered it. Only they can fix that; repeating the request cannot.

---

# Part 4 — Claiming without a lock

Two workers must never send the same webhook. How do you prevent it?

## The wrong way

```ts
const delivery = await findDelivery(id);
if (delivery.status === "QUEUED") {
  await markProcessing(id);
  await send(delivery);
}
```

Classic check-then-act — the same shape as the idempotency race in M2 and the window race in M3. Both workers read `QUEUED`, both proceed, the customer gets the webhook twice.

## The right way

```ts
const result = await prisma.delivery.updateMany({
  where: { id: deliveryId, status: "QUEUED" },   // ← the condition
  data:  { status: "PROCESSING", lockedAt: new Date() },
});

if (result.count === 0) return null;   // someone else got it
```

One statement. The condition is *inside* the update.

Postgres guarantees that of two concurrent `UPDATE`s to the same row, only one can see it as `QUEUED`. The other finds it already `PROCESSING`, matches zero rows, and walks away.

**No lock, no coordination, no race** — the database's row-level concurrency does the work. `result.count` tells you whether you won.

The test races two workers at one delivery: outcomes are exactly `["delivered", "skipped"]`, and the receiver logs exactly one request.

## The lease

`lockedAt` is a timestamp, and it starts a **lease**. If this worker dies mid-request, the scheduler's reaper sees a `PROCESSING` row whose lease expired and returns it to `WAITING`.

That's the division of labour: the worker handles *its own* failures; the scheduler handles the worker's *death*.

---

# Part 5 — The request

## The timeout is not optional

```ts
headersTimeout: options.timeoutMs,
bodyTimeout: options.timeoutMs,
```

Consider an endpoint that accepts the TCP connection and then simply never responds. Not an error — it just holds the line open.

Without a timeout, that worker waits forever. One customer with a misbehaving endpoint occupies a worker permanently. Enough of them and **every worker in the pool is stuck**, and deliveries stop for every other customer.

That's a denial of service any customer could trigger by accident.

The test uses a receiver that deliberately hangs, and asserts the worker gives up in under three seconds.

## Reading the body you're going to discard

```ts
const text = await response.body.text();
```

We mostly throw this away — only the first 500 bytes are kept, for the delivery-history view.

But it must be *read*. Undici pools connections, and a connection whose response body was never consumed cannot be reused. Leave enough of them and the pool is exhausted and all delivery stops.

An easy thing to omit, with a failure mode that appears only under sustained load.

## The envelope

```json
{
  "id": "evt_abc123",
  "type": "payment.succeeded",
  "created_at": "2026-08-10T09:37:28.376Z",
  "data": { "amount": 4200, "currency": "GBP" }
}
```

The customer's payload goes under `data` rather than at the top level. That way we can add envelope fields later without colliding with whatever keys the customer happens to use. Send their object bare and adding an `id` field breaks anyone who already had one.

---

# Part 6 — The most important line in the worker

```ts
} finally {
  await this.queue.complete(deliveryId).catch(...);
}
```

A delivery that finishes **without releasing** leaves its ID in the in-flight list and the dedupe set. Forever.

The consequences compound:

- The Redis slot is consumed permanently
- The dedupe set says "already queued", so the scheduler never offers it again
- The delivery never happens, and nothing reports a problem

Enough of those and the window fills with ghosts and all delivery stops, with a perfectly healthy-looking system.

`finally` runs on **every** path — success, failure, and thrown exception. The test deletes a webhook mid-flight so the load throws, then asserts the slot was still released.

## What this does *not* cover

A worker whose **process dies** never reaches a `finally` block. Nothing in the worker can handle that.

That case belongs to the scheduler's lease reaper, and the two mechanisms cover different things:

| Failure | Handled by |
|---|---|
| Exception in a running worker | The `finally` block |
| The worker process dies | The scheduler's lease reaper |

---

# Part 7 — A concurrency bug caught before it shipped

While wiring the worker entrypoint I nearly introduced a bug that would have been invisible.

`BLMOVE` is a **blocking** command — it holds its connection for the entire timeout while waiting for work.

My first version gave the whole pool one Redis client. Ten worker loops, one connection.

The result: the loops would have **queued behind each other** rather than waiting in parallel. Configured concurrency of ten, actual concurrency of one. And nothing would have looked wrong — no error, no warning, just deliveries running ten times slower than the configuration claimed.

Each loop now gets its own connection, closed on shutdown.

> The general shape: a blocking operation on a shared resource silently serialises everything behind it. Worth checking whenever "concurrency" is a configuration value.

---

# Part 8 — The bug that only appeared with everything running

The best bug of the project so far, and it needed all three processes running together to show itself.

## The symptom

Running the API, scheduler and workers against a failing endpoint:

```
elapsed | redis(win+inflight) | PENDING WAITING QUEUED PROC DELIVERED
10s     |     0 (   0+  0)    |       0    5651    349    0         0
20s     |     0 (   0+  0)    |       0    4875   1125    0         0
23s     |     0 (   0+  0)    |       0    4784   1216    0         0
```

Redis empty. `QUEUED` climbing: 349 → 1,125 → 1,216.

Those rows were **unreachable**. The scheduler reads only `PENDING` and `WAITING`. Workers read only Redis. A `QUEUED` row absent from Redis is invisible to both — it would sit there permanently. 1,216 deliveries silently lost in twenty seconds, with nothing in any log.

## The cause

The claim in M3 was ordered:

```
1. SELECT ... FOR UPDATE SKIP LOCKED     (rows locked, still PENDING)
2. Push IDs to Redis                     ← workers can see them now
3. UPDATE ... SET status = 'QUEUED'
4. COMMIT
```

Between 2 and 4, a worker claims the ID and runs:

```sql
UPDATE deliveries SET status='PROCESSING' WHERE id = ? AND status = 'QUEUED'
```

I had assumed this would **block** on the scheduler's row lock, then proceed after the commit and see `QUEUED`.

**It does not block.** In `READ COMMITTED`, a row that fails the `WHERE` clause in the current snapshot is never a candidate for the lock at all. The row reads as `PENDING`, so the update matches zero rows and returns immediately.

The worker concludes it's an orphan, skips it, releases the slot. *Then* the scheduler commits `QUEUED`.

## Why my reasoning was wrong

In M3 I'd carefully documented the failure cases of this ordering and concluded it was self-healing. That analysis covered:

- Redis rejects some IDs → those stay `PENDING` ✓
- Redis unreachable → rollback ✓
- Crash after push, before commit → rows `PENDING`, worker discards orphan ✓

What it missed was the case where **nothing fails at all** — where both components work perfectly and simply interleave. I'd reasoned about crashes and errors, not about ordinary concurrent success.

## The fix

Commit first, publish after:

```
1. SELECT ... FOR UPDATE SKIP LOCKED
2. UPDATE ... SET status = 'QUEUED'
3. COMMIT                                 ← row is durably QUEUED
4. Push IDs to Redis                      ← only now can a worker see them
5. Return anything the window declined to PENDING
```

A worker can no longer encounter an ID before the row is `QUEUED`.

## The new failure mode, and why the sweep became mandatory

This doesn't eliminate the risk, it **inverts** it. Now a process dying between step 3 and step 4 leaves the same orphan state — rare instead of routine, but still possible.

So the orphan sweep is no longer a nice-to-have. Interestingly, I'd written `findOrphanedQueued` and `resetToPending` back in M3 as belt-and-braces and then **never wired them in**. They now run every tick.

The sweep checks membership against Redis with `SMISMEMBER` rather than inferring from age, because during a genuine backlog a row can legitimately sit `QUEUED` in the window for a long time waiting for a worker. Ageing alone would reclaim live work.

## The lesson

> Reasoning about failure is not the same as reasoning about concurrency. My analysis was thorough about what happens when things *break*, and silent about what happens when two correct components simply interleave.

And: **this bug was unreachable by unit tests.** Every component behaved correctly in isolation. It required the real system, running, under load.

---

# Part 9 — Watching the whole thing work

Three processes, 6,000 deliveries, an endpoint that fails and then recovers.

## Phase 1 — the endpoint is down

```
elapsed | redis(win+inflight) | PENDING WAITING QUEUED PROC DELIVERED | peak
0s      |     0 (   0+  0)    |    6000       0      0    0         0 | 0
3s      |  1008 ( 991+ 17)    |    1000    4045    938   17         0 | 1008
5s      |  1779 (1760+ 19)    |       0    4278   1708   14         0 | 1779
10s     |     0 (   0+  0)    |       0    6000      0    0         0 | 1779
20s     |     0 (   0+  0)    |       0    6000      0    0         0 | 1779

PEAK REDIS OCCUPANCY: 1779  (cap 5000)
```

Read the `10s` row carefully, because it is the entire thesis:

**All 6,000 deliveries are `WAITING`. Redis holds nothing at all.**

Every delivery failed, was recorded in Postgres with a future retry time, and **left Redis completely**. The backlog costs zero memory. Scale it to 1.68 million and that row still reads `0`.

The peak of 1,779 never approached the 5,000 cap because workers were draining faster than the scheduler refilled — which is what a healthy system looks like.

## Phase 2 — the endpoint recovers

Flip it to `200`. Nothing restarted, nothing reconfigured.

```
elapsed | redis(win+inflight) | PENDING WAITING QUEUED PROC DELIVERED
0s      |     0 (   0+  0)    |       0    6000      0    0         0
3s      |  1208 (1190+ 18)    |       0    1000   1133   18      3849
5s      |     0 (   0+  0)    |       0       0      0    0      6000
```

The entire backlog drains in about five seconds.

## And a footnote about that timezone bug

Setting up phase 2, I ran:

```sql
UPDATE deliveries SET "nextRetryAt" = now() - interval '1 second' ...
```

Nothing drained. Same trap as M3, this time in my own test command: `now()` is `timestamptz`, the column is `timestamp`, and Postgres cast it to `Asia/Kolkata` — storing a time 5½ hours in the future. The scheduler correctly ignored every row.

The fix was `now() AT TIME ZONE 'UTC'`. Worth recording because it shows the bug class doesn't disappear once you've fixed it in the application — it lives at every boundary where the two types meet.

---

# Part 10 — Where we are

| Check | Result |
|---|---|
| `npm run typecheck` | Clean |
| `npm run lint` | Clean |
| `npm test` | 216 passing |
| Full cycle, live | 6,000 fail → all `WAITING`, Redis empty → recover → all delivered in ~5s |
| Orphan check | `QUEUED` in Postgres and Redis dedupe set both 0 |

**Relay now works end to end.** An event published through the API is stored, scheduled into a bounded window, delivered with a verifiable signature, retried with jittered backoff when it fails, and recovered if the worker handling it dies.

## What's left

**M5 — observability and hardening**, which is mostly about making all this visible:

- `GET /events`, `GET /events/:id/deliveries` — see what happened and why
- `POST /deliveries/:id/replay` — resend a failed delivery
- Swagger, so the API is browsable
- The 50,000-event load test from `docs/milestone.md`, formalised as a repeatable script rather than the ad-hoc runs above

Then **M6** turns that monitor output into a page, and **M7** deploys it.

---

# Appendix — New terms

| Term | Meaning |
|---|---|
| **Envelope** | A wrapper around the customer's payload, so fields can be added later |
| **Exponential backoff** | Doubling the wait between retries |
| **Full jitter** | Choosing the delay uniformly at random from `[0, delay]` |
| **HMAC** | A hash keyed with a secret; proves origin and integrity together |
| **Lease** | A time-limited claim on a job, so a dead worker doesn't hold it forever |
| **READ COMMITTED** | Postgres's default isolation: each statement sees rows committed when it began |
| **Replay attack** | Re-sending a captured valid request later |
| **Thundering herd** | Many clients retrying simultaneously and overwhelming a recovering service |
| **Tolerance window** | How much clock difference a receiver accepts before rejecting a signature |
