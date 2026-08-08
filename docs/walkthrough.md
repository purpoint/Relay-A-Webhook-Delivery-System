# Relay — A Beginner's Walkthrough

A plain-English record of what this project is, why it's built the way it is, and what exists so far. No prior knowledge assumed. Every piece of jargon is explained the first time it appears.

Updated through **M1 (Authentication & tenancy)**.

---

# Part 1 — What are we even building?

## What is a webhook?

Normally, when your app wants data from another service, *your app asks*. You call an API, it answers. That's **pull**.

A webhook is the reverse. The other service **pushes** to you the moment something happens.

> You buy something online. Stripe processes the payment. Stripe then sends an HTTP POST request to *your* server's URL saying "payment succeeded, here are the details."

That POST request is a webhook. You registered a URL with Stripe; Stripe calls it when there's news.

## So what is Relay?

Relay is the machinery that **sends** those webhooks — the Stripe side, not the customer side.

A company using Relay would:

1. Register their customers' webhook URLs with us
2. Tell us "this event just happened"
3. Trust us to actually get that event delivered to every registered URL, even if those URLs are broken right now

That last word — *even* — is the entire difficulty.

## Why is this hard? Deliveries fail.

The customer's server might be:

- Down for maintenance
- Overloaded and timing out
- Returning `500 Internal Server Error` because of a bug
- Behind a network partition

You can't just try once and give up. You must **retry** — wait a bit, try again, wait longer, try again.

And here's where it gets genuinely difficult.

---

# Part 2 — The problem Relay exists to solve

## Some arithmetic

A customer generates **10,000 events per hour**. Their endpoint goes down. Nobody notices for **a week**.

```
10,000 events/hour × 24 hours × 7 days = 1,680,000 events
```

1.68 million events are now waiting to be delivered. **Where do you keep them?**

## The obvious answer, and why it fails

Most webhook platforms use a **queue** — a to-do list of pending jobs — and most of those queues live in **Redis**.

### What is Redis?

Redis is a database that keeps everything in **RAM** (memory), not on disk.

| | Redis | Postgres |
|---|---|---|
| Stores data in | RAM (memory) | Disk |
| Speed | Extremely fast | Fast |
| Capacity | Limited by your RAM (expensive) | Limited by disk (cheap) |
| Survives a restart? | Not reliably | Yes, always |

Redis is *fast* precisely because RAM is fast. But RAM is expensive and limited. A server might have 500 GB of disk and only 16 GB of RAM.

### The failure

If you put all 1.68 million pending events in Redis, you're holding 1.68 million records in memory. Multiply by a few customers having a bad week and **Redis runs out of memory and the whole system falls over** — not because delivery is hard, but because of where you chose to keep the waiting list.

Worse: those events are just *sitting* there. They can't be delivered — the endpoint is down. You're spending your most expensive resource storing work that cannot be done yet.

## Relay's answer

> **Storage and execution are two different jobs. Stop making one component do both.**

| Component | Job | Holds |
|---|---|---|
| **Postgres** | Storage | Every event, forever, on disk |
| **Redis** | Execution | Only the next **5,000** jobs actually ready to run |

All 1.68 million events live safely in Postgres on cheap disk. Redis holds a small, **fixed-size** working set — never more than 5,000 — regardless of whether the backlog is 5,000 or 5 million.

### The post office analogy

A post office has a **warehouse** and a **conveyor belt**.

- Every parcel lives in the warehouse (Postgres). It's big, cheap, and nothing gets lost.
- The conveyor belt (Redis) holds parcels currently being processed. It fits exactly 5,000.
- As workers clear parcels off the belt, a supervisor (the **Scheduler**) fetches more from the warehouse to refill it.
- A parcel that can't be delivered today **goes back to the warehouse** with a note saying "try again Thursday." It does *not* sit on the belt taking up space.

The belt never overflows, no matter how many parcels arrive. That last point — failed items going *back to the warehouse* rather than staying on the belt — is the single most important rule in this system.

---

# Part 3 — The pieces of the system

Relay is not one program. It's **three separate programs** sharing two databases.

```
        Customer's app
              │
              │  "this event happened"
              ▼
    ┌──────────────────┐
    │   1. API Server  │   Saves the event. That's all it does.
    └──────────────────┘   Never sends a webhook itself.
              │
              ▼
    ┌──────────────────┐
    │    PostgreSQL    │   Every event, forever. The source of truth.
    └──────────────────┘
              │
              ▼
    ┌──────────────────┐
    │   2. Scheduler   │   Keeps the belt full. Never exceeds 5,000.
    └──────────────────┘
              │
              ▼
    ┌──────────────────┐
    │      Redis       │   The execution window. Max 5,000 job IDs.
    └──────────────────┘
              │
              ▼
    ┌──────────────────┐
    │   3. Workers     │   Take a job, send the HTTP request, record result.
    └──────────────────┘
              │
              ▼
      Customer's endpoint
```

## Why split into three programs?

Because they need to **scale independently**.

If deliveries are slow, you need more Workers — you don't need more API servers. Splitting them means you can run 20 Workers and 2 API servers. If it were one program, you'd have to duplicate everything to get more of any one thing.

It also keeps responsibilities honest: the API server *cannot* accidentally start sending webhooks, because that code doesn't exist in it.

## The single most important rule

**The API server never sends a webhook.**

When a customer publishes an event, we save it to Postgres and immediately reply `202 Accepted`. "Accepted" means **we have safely stored it**, not "we delivered it."

Why? Because sending an HTTP request to someone else's possibly-broken server takes seconds — sometimes 30 seconds before it times out. If the API waited for that, the customer's app would hang. Instead: save fast, reply fast, deliver in the background.

---

# Part 4 — Decisions made before writing any code

Four choices were settled up front because each one changes the shape of everything after it.

## Decision 1 — Write the queue by hand, not use a library

There's a popular library called **BullMQ** that manages job queues in Redis. The obvious move is to use it.

We didn't. Here's why.

BullMQ's headline feature is **automatic retries**: a job fails, BullMQ remembers it, waits, tries again. All that remembering happens **inside Redis**.

That is precisely the thing Relay forbids. In Relay, a failed job is **deleted from Redis** and recorded in Postgres. Using BullMQ would mean installing a library and then switching off the reason people install it.

So the queue is about 150 lines written directly against Redis's built-in list commands:

```
LPUSH relay:window <delivery-id>     # scheduler adds a job
BLMOVE relay:window relay:inflight   # worker claims the next job
```

The payoff: "how many jobs are in Redis right now?" is answered by **one command** (`LLEN`), so the 5,000 cap is directly provable rather than approximately true.

## Decision 2 — Backend only, no dashboard yet

The interesting part of Relay is the backend. A user interface is a whole second technology stack and doesn't demonstrate anything about distributed systems. **Swagger** (auto-generated, clickable API documentation) will serve as the interim interface.

## Decision 3 — Run Postgres and Redis directly, not in Docker

Docker isn't installed on this machine; Postgres 15 already is. Installing Docker before writing a single line of code is a poor trade. The Docker files are still written — they're part of the deliverable — they're just not what we use day to day.

## Decision 4 — Split `Event` from `Delivery`

**This is the one place the finished system deliberately differs from the original spec, so it's worth understanding.**

The original documents said each event has a status: `PENDING`, `DELIVERED`, `FAILED`, and so on.

That works — until a project registers **two** webhooks.

> An event fires. It must go to both `https://customer.com/hook-a` and `https://customer.com/hook-b`.
> Hook A succeeds. Hook B is down.
>
> What is the event's status now?

There's no correct answer. It's simultaneously delivered and failing. One column cannot hold both.

So the model splits in two:

| | What it is | Changes? |
|---|---|---|
| **`Event`** | The fact that something happened | **Never.** Written once, frozen. |
| **`Delivery`** | One attempt-stream, for one event to one webhook | Constantly — status, attempt count, next retry time |

One event to three webhooks creates **one** `Event` row and **three** `Delivery` rows, each tracking its own fate independently.

Everything else in the spec survives unchanged. The queue simply holds *delivery* IDs instead of *event* IDs.

---

# Part 5 — Setting up the workspace

## The directory rename

The project folder was named `Realy-A Webhook ` — with a **trailing space**, and `Realy` looks like a typo for `Relay`.

That trailing space is invisible and genuinely harmful: every terminal command needs quotes around the path or it breaks, and git tooling and CI systems handle it badly. Renamed to `~/relay` before anything else, while the folder held only five documents and there was nothing to lose.

## Git

**Git** records the history of every change. A **commit** is one saved snapshot with a message explaining it. **GitHub** is the website where those commits are backed up and shared.

The project is now on GitHub at `purpoint/Relay-A-Webhook-Delivery-System`, with a commit for each meaningful step rather than one giant dump.

---

# Part 6 — The tools installed, and what each is for

| Tool | What it does | Why it's here |
|---|---|---|
| **Node.js** | Runs JavaScript outside a browser | The runtime everything executes on |
| **TypeScript** | JavaScript plus type checking | Catches mistakes before the code runs |
| **Fastify** | Web framework | Receives HTTP requests. Chosen over Express for speed |
| **Prisma** | ORM — talks to the database in TypeScript instead of raw SQL | Type-safe queries, and manages schema changes |
| **PostgreSQL** | Disk database | The permanent home of every event |
| **Redis** | Memory database | The bounded execution window |
| **ioredis** | Redis client for Node | How our code talks to Redis |
| **Zod** | Validates data shapes at runtime | Rejects malformed input and bad config |
| **Pino** | Logging | Machine-readable logs |
| **argon2** | Password hashing | Stores passwords irreversibly |
| **Vitest** | Test runner | Verifies the code does what we claim |
| **ESLint** | Linter | Flags suspicious patterns |
| **Prettier** | Formatter | Consistent style, no arguments about it |

### Jargon check

**ORM** (Object-Relational Mapper): lets you write `prisma.user.findMany()` instead of `SELECT * FROM users`. It also generates TypeScript types from your database schema, so misspelling a column becomes a compile error rather than a 2am crash.

**Hashing**: a one-way scramble. We never store your actual password — only its hash. At login we hash what you typed and compare hashes. If our database leaked, the passwords aren't in it.

**Linter** vs **formatter**: a linter finds *problems* ("this variable is never used"). A formatter fixes *appearance* (indentation, quotes). Different jobs.

---

# Part 7 — The database design

Seven tables were created. Here's what each holds and why it exists.

```
users ──< projects ──< api_keys
                   │
                   ├──< webhooks ──┐
                   │               │
                   └──< events ──< deliveries ──< delivery_attempts
```

(`──<` means "one to many": one user has many projects.)

| Table | Holds | Notes |
|---|---|---|
| `users` | Accounts | Password stored only as an argon2 hash |
| `projects` | A workspace owned by a user | Everything else hangs off a project |
| `api_keys` | Machine credentials | Only the **hash** is stored |
| `webhooks` | Customer endpoint URLs | Each has a `secret` for signing |
| `events` | The immutable facts | Written once, never modified |
| `deliveries` | One attempt-stream per event × webhook | **The row the scheduler works with** |
| `delivery_attempts` | An audit log, one row per HTTP attempt | For the delivery-history view |

## The six delivery states

Every `Delivery` row is in exactly one of these:

| Status | Meaning | In Redis? |
|---|---|---|
| `PENDING` | Saved, never yet scheduled | No |
| `QUEUED` | Sitting in the execution window | **Yes** |
| `PROCESSING` | A worker has it, HTTP request in flight | **Yes** |
| `WAITING` | Attempt failed, retry scheduled for later | **No** ← *the crucial one* |
| `DELIVERED` | Endpoint returned success. Done. | No |
| `FAILED` | Ran out of attempts. Done. | No |

**`WAITING` is the state that makes the whole architecture work.** A failed delivery lives here — in Postgres, on disk, costing nothing — and is completely absent from Redis until its retry time arrives. This is why 1.68 million backlogged events don't consume 1.68 million slots of memory.

## Two indexes that matter

An **index** is a lookup structure that makes searching fast — like a book's index versus reading every page.

```sql
(status, nextRetryAt)   -- the scheduler's hot path
(status, lockedAt)      -- finding jobs abandoned by crashed workers
```

The scheduler asks "which deliveries are ready to run?" every couple of seconds. Once the table holds millions of rows, that question without an index means scanning every single one. With the index, it's near-instant. Adding these now costs nothing; discovering the need later means an outage.

## What is a migration?

A **migration** is a recorded, versioned change to the database structure. Rather than manually typing `CREATE TABLE` and hoping every environment matches, the change is a file committed to git. Anyone can run `npm run db:migrate` and get an identical database.

Ours is `prisma/migrations/20260808151250_init/`.

---

# Part 8 — Every file, and what it does

## Configuration

### `src/config/env.ts` — settings, validated at startup

An **environment variable** is a setting supplied from outside the code — database passwords, port numbers. They live in a `.env` file that is **never committed to git** (it holds secrets).

The naive approach is reading `process.env.DATABASE_URL` wherever you need it. The problem is *when you find out it's missing*: three hours in, inside a worker, halfway through a delivery, as a baffling `undefined` error.

This file reads and validates **every** variable once, at startup. Something missing or malformed? The process refuses to boot and prints exactly what's wrong. All problems at once, too — fixing config one error per restart is miserable.

It also enforces one rule spanning two variables:

```
LEASE_TIMEOUT_MS  must be greater than  DELIVERY_TIMEOUT_MS
```

Here's why that matters. When a worker takes a job, it "leases" it. If the worker crashes, the lease expires and the scheduler gives the job to someone else. But if the lease expires *faster* than a delivery is allowed to take, the scheduler would snatch jobs away from workers that are still perfectly fine — and the same webhook gets sent twice. The check makes that misconfiguration impossible.

### `src/config/database.ts` — the Postgres connection

Opening a fresh database connection per query is slow, so we keep a **pool** of reusable ones. Pool size matters: if 10 workers are running but the pool only allows 5 connections, half your workers spend their time waiting for a connection instead of delivering webhooks.

### `src/config/redis.ts` — the Redis connection

Two things worth knowing here.

**Retries are unlimited.** If Redis blips, commands wait rather than fail. The scheduler and workers are long-running loops that should ride out a hiccup, not crash.

**Blocking commands get their own connection.** Workers use `BLMOVE`, which means "wait until a job appears." That command occupies its connection for the entire wait. If workers shared the main connection, one waiting worker would freeze every other Redis command in the process. Each gets its own.

## Utilities

### `src/utils/logger.ts` — structured logging

`console.log` is fine for one machine. Across three programs and many instances, you need logs you can *search*. Pino writes JSON, so you can query "all errors for delivery X" instead of grepping text.

It also **redacts secrets** — API keys, passwords, `Authorization` headers are replaced with `[redacted]` before they can reach a log file. Leaked credentials in logs are a classic, avoidable breach.

### `src/utils/response.ts` — one response shape

Every endpoint, success or failure, returns the same envelope:

```json
{
  "success": true,
  "data": { },
  "error": null,
  "timestamp": "2026-08-08T16:22:56.485Z"
}
```

A client writes **one** unwrapping helper and **one** error branch, instead of special-casing every endpoint.

### `src/utils/errors.ts` — typed errors

Errors are defined as types — `NotFoundError`, `UnauthorizedError`, `ConflictError` — rather than HTTP status codes.

Why? Because the scheduler and workers use the same service code as the API, and **they have no HTTP request to respond to**. A service saying "this webhook doesn't exist" shouldn't need to know that HTTP calls that `404`. The translation happens in one place, later.

There's a security note in there too: when someone requests a resource belonging to another user, we return **404, not 403**. Saying "403 Forbidden" confirms the resource *exists* — which is itself a leak.

## The web layer

### `src/middleware/error-handler.ts` — where exceptions become responses

One function catches everything and decides the HTTP reply.

The important rule: for unexpected `500` errors, the caller gets **no detail** — just "an unexpected error occurred." Stack traces and database driver messages reveal your table names, file paths, and library versions. Attackers read those. The full details go to the logs, where they belong.

### `src/routes/health.ts` — two probes that answer different questions

| Endpoint | Question | Used by |
|---|---|---|
| `/health` | Is this process alive? | Restart it if not |
| `/readyz` | Can it actually serve traffic? | Remove from load balancer if not |

`/readyz` genuinely pings Postgres and Redis. A probe that returns `200` without checking anything is **worse than no probe** — it confidently keeps a broken server receiving traffic.

### `src/app.ts` — assembling the server

Builds the Fastify instance and attaches:

- **helmet** — security headers
- **rate limiting** — caps requests per caller
- the error handler and routes

One detail worth calling out. Rate limiting counts per **API key** when one is present, falling back to IP address otherwise. Counting purely by IP would mean one customer behind shared office internet could exhaust the limit for everyone sharing that connection.

Another: `trustProxy` is only enabled in production. This setting tells the server to believe the `X-Forwarded-For` header about who the caller really is. Behind a real proxy that's correct. Enabled everywhere, **anyone could forge that header and dodge rate limiting entirely.**

### `src/server.ts` — starting and stopping cleanly

Starts the server and handles **graceful shutdown**.

When a server is told to stop, it shouldn't drop requests mid-flight. The sequence is: stop accepting new requests → let in-flight ones finish → close database connections → exit.

## Tooling files

| File | Purpose |
|---|---|
| `tsconfig.json` | TypeScript rules — strict mode fully on |
| `tsconfig.build.json` | Build-only variant, compiles `src/` alone |
| `eslint.config.js` | Lint rules |
| `.prettierrc.json` | Formatting rules |
| `vitest.config.ts` | Test setup |
| `Dockerfile` | Recipe for a container image |
| `docker-compose.yml` | Runs all five services together |
| `.gitignore` | What git must never record (`.env`, `node_modules`) |

### One note on the Docker setup

In `docker-compose.yml`, Redis is deliberately given **no persistent storage**, while Postgres gets a volume.

That looks like an oversight. It isn't — it's the architecture stated in configuration. Redis holds only the execution window, and every job in it also exists in Postgres. Destroy the Redis container and you lose *nothing* the scheduler can't rebuild in seconds. Giving Redis a volume would imply a durability role it must never have.

---

# Part 9 — Two real bugs, found by actually running it

Both were found by booting the server on a machine where **Redis wasn't installed**. Neither would have appeared in normal testing. Both are the kind that only bite in production, at the worst moment.

## Bug 1 — the health check hung instead of answering

`/readyz` was supposed to report "Redis is down." Instead the request **never came back at all**.

**Cause:** we configured Redis with unlimited retries — correct for the scheduler and workers, which should survive a blip. But it means a command sent while Redis is down waits *forever* rather than failing. The health check sat waiting for a reply that would never arrive.

**Why it matters:** a monitoring probe that never responds is exactly as useless as one that lies. Your dashboard shows "checking…" indefinitely and nobody gets paged.

**Fix:** the ping now races against a 2-second timer. Whichever finishes first wins.

## Bug 2 — the process would not shut down

Much worse. On being told to stop, the server **hung forever**.

**Cause:** shutting down calls Redis `QUIT`, which politely finishes pending commands before closing. Against a server that isn't there, that finishing can never happen — so `QUIT` never succeeded *and never failed*. It just hung, and shutdown hung with it.

**Why it matters:** this is a genuine production failure. Deployment systems send a polite "please stop" signal, wait ~30 seconds, then **force-kill**. A process force-killed mid-write can corrupt data — which is the exact thing graceful shutdown exists to prevent. Every deployment would have been a slow, risky roll.

**Fix:** two layers.
1. `QUIT` gets 2 seconds, then the connection is severed by force.
2. A 10-second **watchdog** over the whole shutdown. If anything stalls, the process exits anyway.

Belt and braces, because "the process can always die on request" is not a property you want depending on one library behaving well.

### The lesson

Both bugs came from the same root: **a setting that's right in one context is wrong in another.** Unlimited retries are correct for a worker loop and dangerous in a health check. Recognising that distinction only happens when you run the thing against a genuinely broken dependency — not when everything is working.

---

# Part 10 — Milestone 1: Authentication & tenancy

This milestone answers two questions: **who are you**, and **what are you allowed to touch**.

## Authentication vs authorisation

Two words that sound alike and mean different things.

| | Question | Example |
|---|---|---|
| **Authentication** | Who are you? | Logging in with a password |
| **Authorisation** | Are you allowed to do this? | Checking the project belongs to you |

You need both. Being logged in doesn't entitle you to another customer's data.

## Multi-tenancy

Relay is **multi-tenant**: many separate customers share one running system and one database. Your projects and mine sit in the same tables, distinguished only by a `userId` column.

That's efficient, and it's also the biggest risk in the whole application. A missing `WHERE userId = ...` doesn't crash anything or throw an error. It quietly serves my data to you, and nobody notices until it's a headline.

## The four layers

Every feature from here follows this chain, and each layer only talks to the one below it:

```
Route       →  "POST /api/v1/projects exists, and needs a valid token"
Controller  →  read the request, call a service, send the response
Service     →  the actual rules ("does this user own this project?")
Repository  →  the only code allowed to touch the database
```

Why bother? Because in M3 and M4 the **scheduler and workers will call the same services** — and they have no HTTP request at all. If the ownership rules lived in the route handler, none of it could be reused. Splitting the layers is what makes the same logic work in a web request and a background loop.

## Two kinds of credential

| | JWT | API key |
|---|---|---|
| Held by | A person, in a browser | A machine, in server config |
| Lives for | 1 hour | Years |
| Can do | Everything — projects, webhooks, keys | Publish events. Nothing else. |

This split is **containment**. An API key sits in a customer's config file for years; it's far more likely to leak than a token that expires before lunch. So if a key does leak, the damage is capped: the attacker can send junk events, but cannot read your delivery history, create projects, or mint more keys.

### What is a JWT?

A **JSON Web Token** is a small blob of data with a cryptographic signature attached. When you log in, we build `{ sub: "your-user-id", email: "..." }`, sign it with a secret only the server knows, and hand it to you. You send it back on every request; we verify the signature.

The point is that the server stores **nothing**. It doesn't need to look up your session — the signature alone proves the token is genuine and unmodified. That's what makes the API **stateless**, and stateless is what lets you run twenty API servers behind a load balancer without them needing to share session storage.

> **Important:** a JWT is *signed*, not *encrypted*. Anyone holding it can read what's inside. Never put secrets in one. The signature stops tampering, not reading.

## The most interesting decision: two different hashing algorithms

Passwords and API keys are both secrets, but they're hashed completely differently, and the reasoning is genuinely worth understanding.

### Passwords → Argon2 (deliberately slow)

Humans pick terrible passwords. `hunter2` is one guess out of maybe a few million — not out of 2^256. You cannot make a human password unguessable, so the only defence left is making **each individual guess expensive**.

Argon2 deliberately burns CPU and memory. It takes ~50ms and 19MB of RAM to compute one hash. That's imperceptible when you log in once. For an attacker trying a billion passwords, it's ruinous.

**Slow is the entire feature.**

### API keys → SHA-256 (deliberately fast)

An API key is 32 bytes we generate from cryptographic randomness — 256 bits of entropy. There is *nothing to guess*. Nobody brute-forces 2^256; the universe isn't old enough.

So slow hashing buys **zero** extra security here — and costs a great deal. That check runs on every single published event, the hottest path in the entire system.

There's a second, structural reason. Argon2 salts every hash randomly, so hashing the same key twice gives different results. **You cannot look a key up by its hash.** You'd have to load every key in the database and verify them one at a time. SHA-256 is deterministic, so the hash drops straight into a unique index and the lookup is one indexed query.

> **The lesson:** "always use the strongest hash" is wrong. The right algorithm depends on where the security actually comes from. For passwords it comes from slowness; for API keys it comes from entropy.

## Three security details worth knowing

### 1. Account enumeration and the dummy hash

If you try to log in with an email that doesn't exist, the obvious code returns immediately. If the email *does* exist, we spend ~50ms running Argon2 before rejecting the wrong password.

That timing difference is measurable over a network. An attacker scripts it and learns **which email addresses have accounts here** — valuable for phishing, and a privacy breach in itself.

The fix: when the email is unknown, we verify the password against a **dummy hash** anyway. Same work, same delay, no signal. Both cases also return the byte-identical message, "Invalid email or password".

### 2. 404, not 403

When you request a project belonging to somebody else, Relay returns **404 Not Found** — not 403 Forbidden.

`403` means "this exists, but you can't have it." That confirms the resource is real, which is itself a leak. Someone probing IDs could map out which projects exist. `404` tells them nothing.

### 3. The key is shown exactly once

When you create an API key, the plaintext appears in that one response and never again. We store only the SHA-256 hash, so we genuinely **cannot** show it to you later — even if we wanted to.

Lose it and you issue a new one. That's not a limitation; it's the property that makes a database leak survivable.

## What got built

| File | Does what |
|---|---|
| `utils/crypto.ts` | Password hashing, API key generation, constant-time comparison |
| `repositories/*.repository.ts` | The only database access — users, projects, keys |
| `services/auth.service.ts` | Register and login, including the timing defence |
| `services/project.service.ts` | Projects and keys, with the ownership check |
| `middleware/authenticate.ts` | `requireUser` (JWT) and `requireApiKey` |
| `validators/*.schema.ts` | Zod rules for every input |
| `routes/v1/*.routes.ts` | The endpoints themselves |
| `types/fastify.d.ts` | Teaches TypeScript what an authenticated request carries |

### The endpoints

| Method | Path | Auth |
|---|---|---|
| `POST` | `/api/v1/auth/register` | none |
| `POST` | `/api/v1/auth/login` | none |
| `POST` | `/api/v1/projects` | JWT |
| `GET` | `/api/v1/projects` | JWT |
| `GET` | `/api/v1/projects/:projectId` | JWT |
| `POST` | `/api/v1/projects/:projectId/api-keys` | JWT |
| `GET` | `/api/v1/projects/:projectId/api-keys` | JWT |
| `DELETE` | `/api/v1/projects/:projectId/api-keys/:keyId` | JWT |

### One password rule that might surprise you

The only requirement is **12 characters**. No "must contain a capital and a symbol."

Those composition rules are counterproductive. They push people toward predictable patterns — `Password1!` satisfies every box and is trivially cracked — while blocking genuinely strong passphrases like `correct horse battery staple`. Both NIST and OWASP now recommend length minimums instead. We follow that.

## A discovery while testing

Six tests failed on the first run, and the cause turned out to be a good sign: **the rate limiter was working.** Auth endpoints are capped at 10 requests/minute, the test suite blew straight through that, and later registrations got `429 Too Many Requests`.

Real protection doing its job — but it made test results depend on the order they happened to run in, which is unacceptable in a test suite.

The fix wasn't to weaken the limit. Rate limiting is now **off by default in tests only**, and a dedicated test builds an app with it explicitly switched on. The protection stays covered rather than quietly disabled.

Why is the auth limit so much tighter than the general one (10/min vs 100/min)? Two reasons. Login is the target for **credential stuffing** — replaying millions of email/password pairs leaked from other breaches. And because every attempt costs us an Argon2 hash, an unthrottled login endpoint is also a way for an attacker to **exhaust our own CPU**.

## Verified

24 tests pass, including:

- The password hash never appears in any response
- Unknown email and wrong password return identical responses
- Listing projects shows only your own
- Another user's project returns 404
- You cannot mint a key inside someone else's project
- The plaintext key appears once and never again
- What's stored is a 64-character hash, not the key

Plus a manual run of the whole flow — register → create project → mint key → list keys → rejected without a token — all behaving correctly.

---

# Part 11 — Where the project stands

## Verified working

| Check | Result |
|---|---|
| `npm run typecheck` | Clean |
| `npm run lint` | Clean |
| `npm test` | 24 passing |
| `GET /health` | `200` |
| `GET /readyz` | `503` in 2.0s, correctly reporting `database: true, redis: false` |
| Shutdown on signal | Exits in 2s |
| Auth flow, end to end | Register → project → API key, all working |

The `503` is the **correct** answer — Redis genuinely isn't installed yet. The probe is telling the truth, which is the whole point of it.

## Two environment notes

- **Port 3000 was already taken** by another project on this machine (a `Tracker/server` process). Relay runs on **3100** locally. That other app was left running.
- **Prisma 7 is very new** and changed two things the original docs predate: it needs an explicit database adapter (`@prisma/adapter-pg`), and it generates its client as TypeScript source into `src/generated/` rather than JavaScript into `node_modules`. That folder is gitignored — it's rebuilt from the schema whenever needed.

## The roadmap

| | Milestone | Status |
|---|---|---|
| **M0** | Scaffold — config, logging, health, database schema | **Done** |
| **M1** | Auth & tenancy — users, projects, API keys | **Done** |
| M2 | Webhooks & event ingest — the write path | Next |
| M3 | Execution window & scheduler — *the core idea* |  |
| M4 | Worker pool — the delivery engine |  |
| M5 | Observability & hardening — plus the proof |  |

## What "done" will look like

At M5 there's a single test that justifies the entire project:

1. Start a fake customer endpoint that deliberately returns `500` for everything
2. Publish **50,000** events at it
3. Start the scheduler and workers
4. Watch the Redis job count in a loop

**Expected result:** Postgres holds all 50,000 events with retry counts climbing. Redis **never once exceeds 5,000.** Then flip the fake endpoint to success, and the entire backlog drains without restarting anything.

That one observation — *50,000 stored, never more than 5,000 in memory* — is the product.

---

# Appendix — Glossary

| Term | Meaning |
|---|---|
| **API** | A way for programs to talk to each other over the network |
| **Backoff** | Waiting longer between each retry (5s, 10s, 20s…) instead of hammering |
| **Commit** | One saved snapshot in git history |
| **Docker** | Packages an app with everything it needs, so it runs identically anywhere |
| **Endpoint** | One specific URL an API responds on |
| **Env var** | A setting supplied from outside the code |
| **Fan-out** | One event going to multiple destinations |
| **Hash** | A one-way scramble; used so passwords are never stored readably |
| **HMAC** | A signature proving a message came from who it claims, unmodified |
| **Index** | A database lookup structure that makes searching fast |
| **Jitter** | Deliberate randomness in retry timing, so failures don't all retry in lockstep |
| **JWT** | A signed token proving you logged in |
| **Lease** | A time-limited claim on a job, so a crashed worker doesn't hold it forever |
| **Migration** | A recorded, versioned change to database structure |
| **ORM** | A library letting you query the database in your language, not SQL |
| **Pool** | Reusable database connections, so you don't open a new one per query |
| **Queue** | A to-do list of jobs waiting to be processed |
| **Rate limiting** | Capping how many requests one caller may make |
| **Source of truth** | The one place that is authoritative when copies disagree |
| **Stateless** | Keeps no memory between requests, so any instance can serve any request |
| **Webhook** | An HTTP request a service sends you when something happens |
