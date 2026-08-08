# Relay — M2 Walkthrough: Webhooks & Event Ingest

A complete, beginner-level explanation of the third milestone. Assumes you've read [walkthrough.md](walkthrough.md) and [walkthrough-m1.md](walkthrough-m1.md).

This is the milestone where Relay stops being "an API with accounts" and starts being a webhook platform.

---

# Part 1 — What M2 adds

After M1 you could sign up, create a project, and mint an API key. But there was nowhere to send anything and no way to say anything had happened. The `events`, `deliveries` and `webhooks` tables were all empty, with no endpoint that could fill them.

M2 adds the two halves of the write path:

| | What it does | Who calls it |
|---|---|---|
| **Webhook management** | Register the URLs we'll deliver to | A person, with a JWT |
| **Event ingest** | "This thing happened" | A machine, with an API key |

By the end of it, publishing one event to a project with three webhooks creates **one `Event` row and three `Delivery` rows**, all `PENDING`, waiting for a scheduler that doesn't exist yet.

---

# Part 2 — The most dangerous input in the system

Before any of the CRUD, this had to be dealt with.

## Why a webhook URL is not like other input

Most user input is *data*. You store it, you show it back. If someone types nonsense into a name field, you've stored nonsense.

A webhook URL is different. It's an **instruction to our own servers**: "later, make an HTTP request to this address." And our servers sit inside our network, behind our firewall, with access to things the public internet cannot reach.

That's a vulnerability class with a name: **Server-Side Request Forgery**, or SSRF.

## The attack, concretely

Cloud providers run a magic internal address that any machine can query to learn about itself:

```
http://169.254.169.254/latest/meta-data/iam/security-credentials/
```

On AWS, that path returns **temporary IAM credentials for the host machine**. It's reachable from the instance and from nowhere else — no authentication, because the network position *is* the authentication.

So an attacker signs up for Relay, creates a project, and registers that as their webhook URL.

Then in M4, our worker does exactly what it was built to do: makes an HTTP request to the registered URL. It receives the credentials. And in M5, when we store response bodies as delivery history so customers can debug failures, **it hands them straight back to the attacker.**

They breached nothing. They pasted a URL and let our infrastructure fetch it for them.

The same trick reaches anything internal:

```
http://localhost:5432        our own Postgres
http://10.0.0.5:6379         an internal Redis
http://admin.internal/       a private admin panel
file:///etc/passwd           not even HTTP
```

## What we block

`src/utils/url-safety.ts` rejects:

| Category | Examples |
|---|---|
| Non-HTTP schemes | `file:`, `ftp:`, `gopher:` |
| Embedded credentials | `https://user:pass@host` — would land in our logs |
| Loopback | `localhost`, `127.0.0.1`, `[::1]` |
| Private ranges | `10.x`, `172.16–31.x`, `192.168.x` |
| Link-local | `169.254.x.x` — the metadata range |
| Metadata hostnames | `metadata.google.internal`, `instance-data` |
| Carrier NAT | `100.64.x.x` |
| IPv6 internal | `fc00::/7`, `fe80::`, `::ffff:127.0.0.1` |
| Internal TLDs | `*.internal`, `*.local` |
| Bare hostnames | `http://intranet/hook` — resolves via internal DNS |

## Validated on update, not just create

An easy hole to leave: check the URL when the webhook is created, and forget the edit endpoint.

Then the attack becomes two steps. Register `https://example.com/hook` — passes. Then `PATCH` it to `http://169.254.169.254`. If the update path doesn't validate, you've walked straight through the front door you locked.

**Validation belongs on every path that can set a field**, and there's a test for that exact two-step sequence.

## What this does *not* fix

Worth being honest about, because it's written into the code as a comment rather than quietly assumed handled.

We validate the URL. We do not control **DNS**.

An attacker registers `https://totally-innocent.com/hook`. It resolves to a real public IP. It passes every check. Tomorrow they change their DNS record to point at `127.0.0.1`. Our worker resolves the name fresh at delivery time and connects to *our own machine*.

That's **DNS rebinding**, and closing it needs the resolved IP re-checked at the moment of connection, inside the worker. That's M4's job. The gap is recorded in the source so nobody later assumes registration-time validation was the whole story.

---

# Part 3 — The bug I introduced and how it surfaced

This is the most instructive part of M2, so it gets its own section.

## The setup

Local development needs a webhook pointing at `127.0.0.1` — the M5 load test runs a fake receiver there. But `127.0.0.1` is loopback, which the guard blocks.

So it's a config flag: `ALLOW_PRIVATE_WEBHOOK_URLS`, off by default, on locally.

I also made `env.ts` refuse to boot if that flag is true while `NODE_ENV=production`, so it can't silently ship.

Good so far.

## The bug

I implemented the flag as an early exit:

```ts
if (options.allowPrivate) {
  return null;      // ← skip every remaining check
}
```

"Allow private addresses" became "**skip all address validation**."

Which meant a locally running Relay cheerfully accepted:

```
http://169.254.169.254/latest/meta-data/
```

The exact URL the entire file exists to block.

## Why 31 passing tests didn't catch it

Because every one of them tested the **strict** policy. I'd been thorough about the rule and careless about its exception — and the exception was where the hole was.

## How it actually surfaced

Not from tests. From running the real server and trying the attack by hand:

```
=== SSRF attempt: AWS metadata endpoint ===
{"success":true, ... }  [HTTP 201]
```

`201 Created`. It worked.

## The fix

Metadata hostnames and link-local addresses are now checked **before** the escape hatch, unconditionally.

The reasoning is that the two cases simply aren't comparable. A developer genuinely needs loopback. **Nobody's local setup has ever needed `169.254.169.254`.** A relaxation made for convenience shouldn't extend to the one address that returns IAM credentials.

Re-verified against the running server:

```
loopback receiver   → 201   (allowed, as intended)
AWS metadata        → 400   (blocked)
GCP metadata        → 400   (blocked)
```

## The lesson

> **The risky part of a security control is usually its exception, not its main path.**

Every control ends up with an escape hatch — for local dev, for tests, for one awkward legacy client. That hatch gets less thought and less testing than the rule it bypasses, and it's where the bug lives.

Second lesson: **passing tests are evidence, not proof.** Thirty-one tests were green while the running server was wide open. Actually exercising the thing, with real configuration, found in one minute what the suite had missed entirely.

---

# Part 4 — Webhooks

Five endpoints, all behind a JWT.

| Method | Path |
|---|---|
| `POST` | `/api/v1/projects/:projectId/webhooks` |
| `GET` | `/api/v1/projects/:projectId/webhooks` |
| `GET` | `/api/v1/projects/:projectId/webhooks/:webhookId` |
| `PATCH` | `/api/v1/projects/:projectId/webhooks/:webhookId` |
| `DELETE` | `/api/v1/projects/:projectId/webhooks/:webhookId` |

## The signing secret

Every webhook gets one at creation:

```
whsec_5KpQ2mXvR8nL3jH7fD1sA9wE4tY6uI0oP...
```

In M4, every request we send will carry a signature computed from the request body and this secret. The receiver recomputes it and compares. If they match, the request genuinely came from us and wasn't altered on the way.

### Why we show this secret, when we hide API keys forever

That looks inconsistent. It isn't — they point in opposite directions.

| | Proves | Who verifies it |
|---|---|---|
| **API key** | The customer is who they claim, to us | **Us** |
| **Webhook secret** | We are who we claim, to the customer | **Them** |

An API key is a credential *we* check, so we only need its hash. A webhook secret is a credential *they* check, so they must have the actual value. It's their secret; we're just the other party who also knows it.

## Why API keys can't manage webhooks

Every endpoint above requires a JWT. An API key cannot reach any of them, and that's deliberate.

Suppose a key leaked and could edit webhook URLs. An attacker would repoint every webhook at a server they control. Every payment notification, every order event, every piece of customer data — silently redirected. And from the customer's side **nothing looks wrong**: events are still accepted, deliveries still succeed, dashboards stay green.

That's the worst case in this milestone, and there's a test asserting a foreign `PATCH` returns `404` *and* leaves the stored URL untouched.

---

# Part 5 — Event ingest

```
POST /api/v1/events
X-API-Key: rlk_live_...

{ "eventType": "payment.succeeded", "payload": { "amount": 4200 } }
```

The first and only route authenticated by an API key, because it's the only one a machine calls.

## The project comes from the credential

The single most important line in `event.routes.ts`:

```ts
const result = await publishEvent(
  request.apiKey.projectId,   // ← from the credential
  eventType,
  payload,
);
```

Notice what's absent: the caller never says which project the event belongs to. It's determined entirely by which API key authenticated the request.

**If the body could name a project**, anyone holding any valid key could publish into anyone else's project by changing one field. Not a subtle bug — a complete collapse of tenant isolation.

There's a test that posts another customer's `projectId` in the body and asserts the event lands in the key's own project regardless.

## Fan-out

One event, many destinations:

```
POST /events  ──┐
                ├──► Event row (written once)
                │
                ├──► Delivery → webhook A   (PENDING)
                ├──► Delivery → webhook B   (PENDING)
                └──► Delivery → webhook C   (PENDING)
```

This is the `Event`/`Delivery` split from M0 doing its job. Three independent delivery attempts, each with its own status, retry count and next-retry time. Webhook B failing has no bearing on A.

## The transaction, and what it prevents

```ts
return prisma.$transaction(async (tx) => {
  const event = await tx.event.create({ ... });
  await tx.delivery.createMany({ ... });
  return { event, deliveryCount };
});
```

A **transaction** means both writes happen or neither does. Nothing in between is ever visible.

Picture it without one. The `Event` row is written. The process is killed — deploy, crash, out of memory — before the deliveries are. Now the database holds an event with **zero delivery rows**.

What happens next is the bad part. The scheduler looks for deliveries, not events. It finds none. The event is never sent. Nothing errors, nothing is logged, no alert fires. The customer got their `202 Accepted` and reasonably believes the event is on its way.

**Silent data loss is the worst failure mode there is**, because you don't learn about it — your customer does, later, and they've already made decisions based on a payment notification that never arrived.

The transaction makes that state unreachable. Crash mid-write and the whole thing rolls back; the client's retry creates it cleanly.

## 202 Accepted, not 201 Created

A deliberate choice, and precise.

| Code | Claims |
|---|---|
| `201 Created` | The work is done |
| `202 Accepted` | Received and stored; outcome not yet known |

We have not delivered anything. We've written rows to Postgres. Actual delivery happens in a different process, possibly minutes or days later if the endpoint is unhealthy.

`202` is the honest answer, and the API's status code should never overstate what happened.

## Events with no webhooks are still stored

Publish to a project with no active webhooks and you get `202` with `deliveryCount: 0`. The event is stored anyway.

Why? Because **the event is a fact**. It happened. Having nowhere to send it doesn't make it untrue — and a webhook registered tomorrow can replay it. Discarding it would destroy history to save a row.

It does log a warning, since it's nearly always a misconfiguration and otherwise invisible until someone wonders why nothing is arriving.

---

# Part 6 — Idempotency

## The problem

A customer's server publishes an event. The request times out.

**Did it work?** They cannot tell. Two possibilities look identical from their side:

1. The request never reached us → must retry, or the event is lost
2. It reached us, we saved it, and the *response* was lost → retrying duplicates it

There is no way to distinguish these from outside. And "a payment succeeded" delivered twice can mean a customer charged twice.

## The solution

The client generates a unique key and sends it along:

```
Idempotency-Key: order-42
```

If we've already seen that key for that project, we return **the original event** instead of creating a new one. Retrying becomes safe. The client can retry as often as it likes.

Note the response tells you which happened:

```json
{ "id": "6001eadb-...", "deliveryCount": 3, "deduplicated": false }   ← first
{ "id": "6001eadb-...", "deliveryCount": 3, "deduplicated": true  }   ← retry
```

Same event id. Second one flagged as a duplicate.

## Unique per project, not globally

The database constraint is on `(projectId, idempotencyKey)`.

If it were global, two unrelated customers both using `"order-1"` would collide — and the second would silently receive the first customer's event id. Scoping to the project means everyone chooses their own keys freely.

## The race, and why a check isn't enough

Here's the subtle part.

The obvious implementation is: look for an existing event with this key; if none, create one. That's a **check-then-act** race:

```
Request A: is "order-42" taken?  → no
Request B: is "order-42" taken?  → no     ← A hasn't inserted yet
Request A: INSERT                → ok
Request B: INSERT                → duplicate!
```

Both passed the check because neither had inserted when the other looked. This isn't rare — retries frequently arrive in bursts.

**The database constraint is what actually enforces uniqueness.** Postgres rejects B's insert with error `P2002`, and the service catches that, fetches the winning event, and returns it. B gets the same `202` and the same event id as A.

### Why not use a lock?

A lock in application memory would only coordinate requests hitting *the same server process*. Relay runs multiple API servers behind a load balancer, and A and B can easily land on different machines. An in-process lock wouldn't even see the conflict.

The database constraint is the only thing all processes share. **Correctness at the boundary all participants agree on** — that's the general principle, and it recurs constantly in distributed systems.

There's a test firing five concurrent publishes with one key. All five get `202`, and exactly one event exists.

---

# Part 7 — Another test bug worth recording

Adding the second integration suite broke eleven previously passing tests.

## What happened

Vitest runs test **files** in parallel by default. Both integration suites share one Postgres database, and each clears the users table in `beforeEach`.

Run concurrently, they deleted each other's fixtures mid-test and both tried to register `ada@example.com`. Failures looked like application bugs and moved around between runs.

## The embarrassing detail

Back in M0 I wrote this comment in `vitest.config.ts`:

> *Integration tests share one Postgres database and one Redis instance, so running them concurrently would have them truncating tables out from under each other.*

Correct diagnosis. Written months before the problem. **And I never wrote the config line that would prevent it.**

A comment describing an invariant is not the same as enforcing one. The comment made it *look* handled — arguably worse than no comment, because it discouraged a second look.

## The fix

```ts
fileParallelism: false
```

The alternative — a separate database per worker — is the right answer if the suite ever gets slow enough to need parallelism. At under three seconds, it isn't.

Also pinned the webhook URL policy in `tests/setup.ts`, so the suite no longer depends on whatever happens to be in a developer's local `.env`.

---

# Part 8 — Every file

| File | Responsibility |
|---|---|
| `utils/url-safety.ts` | SSRF guard — the highest-risk validation in the system |
| `repositories/webhook.repository.ts` | Webhook database access, scoped by project |
| `repositories/event.repository.ts` | The fan-out transaction |
| `services/webhook.service.ts` | Webhook rules, secret generation, URL policy |
| `services/event.service.ts` | Publishing, fan-out, idempotency |
| `validators/webhook.schema.ts` | URL and description shape |
| `validators/event.schema.ts` | Event type and payload shape |
| `routes/v1/webhook.routes.ts` | Five JWT-protected endpoints |
| `routes/v1/event.routes.ts` | The one API-key endpoint |

## A note on `eventType` validation

```ts
.regex(/^[a-zA-Z0-9._-]+$/)
```

Only letters, numbers, dots, underscores, hyphens.

Restrictive on purpose. This string ends up in log lines, and later in metric labels and subscription filters. Keeping it to a conservative character set means it's safe to use in all of those without escaping — and there's never a moment where a customer's creative naming breaks a dashboard or, worse, injects something into a downstream system.

## Why `payload` must be an object

```ts
payload: z.record(z.string(), z.unknown())
```

`"hello"` and `42` are both valid JSON, but a bare value leaves no room to add fields later, and every webhook consumer in existence expects to parse an object. Requiring one from day one avoids a breaking change on the day you need to add something.

---

# Part 9 — Verified

96 tests, all passing. Typecheck and lint clean.

| Suite | Tests |
|---|---|
| URL safety (SSRF) | 36 |
| Auth & tenancy | 24 |
| Webhooks | 15 |
| Events | 21 |

Plus a manual run against a live server:

```
Register 2 webhooks       → 201, each with a distinct whsec_ secret
AWS metadata URL          → 400 blocked
Publish event             → 202, deliveryCount: 3
Same Idempotency-Key ×2   → identical event id, second flagged deduplicated
```

## What's in the database now

```
webhooks     │ 3
events       │ 2
deliveries   │ 6      ← all PENDING, attempt 0, nextRetryAt null
```

Those six deliveries are **stuck**. Nothing exists to pick them up.

That's not a defect — it's precisely where M2 ends. The write path is finished; the execution path hasn't been built. M3 gives them somewhere to go.

---

# Part 10 — Next: M3, the execution window

This is the milestone the whole project is named after.

- A `QueueAdapter` interface with a Redis implementation, built on plain list commands
- Two Lua scripts, so capacity-check-then-push is atomic across scheduler replicas
- The scheduler loop: reap stale leases → compute remaining capacity → claim eligible deliveries with `FOR UPDATE SKIP LOCKED` → push → sleep
- The rule that makes it all work: **never exceed 5,000 in Redis**

It also needs Redis actually installed, which is why `/readyz` has been honestly reporting `redis: false` since M0.

---

# Appendix — New terms

| Term | Meaning |
|---|---|
| **Atomic** | Happens completely or not at all; no partial state is ever visible |
| **Check-then-act race** | Two processes both check a condition before either acts on it |
| **DNS rebinding** | Changing a hostname's IP after validation, to defeat an address check |
| **Fan-out** | One input producing many outputs — here, one event to many webhooks |
| **HMAC** | A signature proving a message came from someone holding a shared secret |
| **Idempotent** | Doing it twice has the same effect as doing it once |
| **Instance metadata** | A cloud-internal address returning credentials for the host machine |
| **Link-local** | `169.254.x.x` — addresses valid only on the local network segment |
| **SSRF** | Making a server fetch a URL an attacker chose, from inside its network |
| **Transaction** | A group of database writes that succeed or fail as one unit |
