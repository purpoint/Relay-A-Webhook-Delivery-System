# Relay — Milestones

The build sequence. Each milestone ends in a state that runs, is committed, and can be demonstrated on its own. Nothing is "finished later."

**M0–M5 are backend only**, with Swagger UI as the interim interface. **M6 adds a single frontend screen** — the live execution-window monitor — and **M7 deploys it.** The frontend deliberately comes last: it exists to make the backend's central property visible, so it cannot be built before that property exists.

---

## Structural note — `Event` vs `Delivery`

The other docs describe delivery status as living on the event. That holds only while a project has one webhook. With two, a single event can succeed against one endpoint and fail against the other, and one `status` column cannot represent both outcomes.

So the model splits in two:

| | Responsibility |
|---|---|
| **`Event`** | The immutable fact that something happened. Written once at ingest, never mutated. |
| **`Delivery`** | One attempt-stream, per (event × webhook). Owns `status`, `attempt`, `nextRetryAt`, `lockedAt`. |

The Execution Window therefore holds **delivery IDs**, not event IDs. Everything else in `Architecture.md` and `prompt.md` carries over unchanged — this is the same design, made correct under fan-out.

---

## M0 — Scaffold

Goal: an empty but production-shaped service that boots and reports its own health honestly.

- `git init`; TypeScript in strict mode; Fastify; `tsx` for the dev loop
- `src/config/env.ts` — every environment variable parsed through Zod at startup. A missing or malformed var fails the boot, not a request at 3am
- Pino structured logging, request IDs threaded through
- Prisma installed, first migration applied
- ESLint, Prettier, Vitest
- `Dockerfile` and `docker-compose.yml` authored as deliverables
- `GET /health` — liveness, returns unconditionally
- `GET /readyz` — readiness, actually pings Postgres and Redis and fails if either is unreachable

**Done when:** `npm run dev` boots, `/readyz` returns 200 with both dependencies up and 503 with either down.

---

## M1 — Auth & tenancy

Goal: multi-tenant boundaries that hold, with the two credential types Relay actually needs.

- `User` (argon2id password hashing), `Project`, `ApiKey`
- **Two deliberate auth paths:**
  - **JWT** → management endpoints. The caller is a human.
  - **API key** → `POST /events` only. The caller is a machine.
- API keys stored hashed, returned in plaintext exactly once at creation, prefixed `rlk_live_` so they are greppable in logs and catchable by secret scanners
- `@fastify/helmet`, `@fastify/rate-limit`

**Done when:** a user can register, log in, create a project, and mint an API key — and cannot read another user's project.

---

## M2 — Webhooks & event ingest

Goal: the write path. Durable, fast, and completely free of outbound I/O.

- Webhook CRUD — `url`, generated `secret`, `isActive`
- `POST /api/v1/events`, the hot path:
  1. Authenticate the API key → resolve the project
  2. Validate the body with Zod
  3. **One transaction:** insert the `Event`, then one `Delivery` row per active webhook at `PENDING`
  4. Return `202 Accepted`
- Optional `Idempotency-Key` header, unique per project, so a client retry does not duplicate the event

The API server never makes an outbound HTTP call. Acceptance means *persisted*, not *delivered*.

**Done when:** publishing an event against a project with three webhooks creates one `Event` row and three `PENDING` `Delivery` rows, and the endpoint returns in single-digit milliseconds.

---

## M3 — Execution Window + Scheduler

Goal: the bounded window — the part that makes Relay Relay.

**Redis: three keys, two Lua scripts.**

| Key | Type | Holds |
|---|---|---|
| `relay:window` | LIST | delivery IDs ready to execute |
| `relay:inflight` | LIST | claimed by a worker, not yet finished |
| `relay:enqueued` | SET | dedupe guard |

Occupancy is `LLEN relay:window + LLEN relay:inflight`. Nothing outside the queue adapter writes these keys.

- `enqueue.lua` — re-check capacity, `SADD` the dedupe guard, `RPUSH`. Returns the count actually accepted. Lua because check-then-push must be atomic across scheduler replicas
- `complete.lua` — `LREM` from inflight, `SREM` from the guard

**Scheduler loop:**

1. Reap stale leases — any `PROCESSING` row older than `LEASE_TIMEOUT_MS` returns to `WAITING`, Redis traces cleared
2. `capacity = EXECUTION_WINDOW_SIZE − occupancy`; if zero, sleep and continue
3. Select eligible: `status = PENDING` OR (`status = WAITING` AND `nextRetryAt <= now`), ordered by `nextRetryAt NULLS FIRST, createdAt`, `LIMIT capacity`, **`FOR UPDATE SKIP LOCKED`**
4. Mark `QUEUED`, push via `enqueue.lua`
5. Sleep `SCHEDULER_POLL_MS`

`SKIP LOCKED` is what makes multiple scheduler replicas safe — two schedulers never claim the same row. Prisma cannot express it, so this single query drops to `$queryRaw`.

The scheduler never delivers a webhook.

**Done when:** 10,000 eligible deliveries produce exactly 5,000 in Redis, and two scheduler instances against the same dataset produce zero duplicates.

---

## M4 — Worker pool

Goal: the delivery engine. Stateless, crash-safe, polite to failing endpoints.

Each worker loops:

1. `BLMOVE relay:window → relay:inflight` (blocking, short timeout so shutdown stays responsive). Atomic claim — a job is never in limbo between lists
2. Load delivery + event + webhook from Postgres
3. **Conditional update** `QUEUED → PROCESSING`, set `lockedAt`. Zero rows affected means someone else owns it — drop it and continue
4. Sign: `HMAC-SHA256(secret, "{timestamp}.{rawBody}")`, sent as `X-Relay-Signature`, `X-Relay-Timestamp`, `X-Relay-Event-Id`, `X-Relay-Delivery-Id`. The timestamp is inside the signed string, which is what stops replay
5. `POST` via `undici` with an `AbortSignal` timeout
6. `2xx` → `DELIVERED`. Otherwise `attempt++`; at `MAX_ATTEMPTS` → `FAILED`, else `WAITING` with `nextRetryAt = now + backoff`
7. `complete.lua` — **always**, in a `finally`

**Backoff:** exponential, base 5s, **full jitter**, capped at 1h. The jitter is not decoration: without it, 5,000 deliveries that failed together retry together and arrive at the recovering endpoint in lockstep.

**Shutdown:** `SIGTERM` → stop claiming new work, let in-flight deliveries finish, exit.

**Done when:** killing a worker mid-delivery leaves a row the reaper recovers, and a failed delivery leaves *nothing* in Redis and a correct `nextRetryAt` in Postgres.

---

## M5 — Observability & hardening

Goal: make the system inspectable, and prove the thesis.

- `GET /events`, `GET /events/:id`, `GET /events/:id/deliveries`
- `POST /deliveries/:id/replay`
- Swagger via `@fastify/swagger`
- Structured logs at every point `prompt.md` lists: login, webhook creation, event creation, scheduler execution, worker execution, delivery success, delivery failure, retry scheduling
- Integration tests against real Postgres and Redis

**The load test — the demonstration the whole project exists for:**

1. Local receiver on `:4000` with switchable behaviour (`200` / `500` / hang)
2. Set it to `500`
3. Publish 50,000 events
4. Start the scheduler and workers
5. Watch `redis-cli LLEN relay:window` in a loop

**Expected:** Redis never exceeds 5,000 while Postgres holds all 50,000, with climbing `attempt` counts and future `nextRetryAt`s. Flip the receiver to `200` and the backlog drains without restarting anything.

That single observation — 50,000 durable in Postgres, never more than 5,000 resident in Redis — is the product.

---

## M6 — Live execution-window monitor

Goal: make the architecture visible in ten seconds, to someone who will not read the code.

**Not started until M5 is complete.** There is no point building a display before the thing it displays exists.

### Why this exists

Relay's best property is also its least visible. "Redis memory stays flat regardless of backlog size" is, on a repository page, a sentence someone has to take on trust. The M5 load test proves it — but the proof is `redis-cli LLEN` in a terminal loop, which persuades only a reader who is already deep in the code.

One page fixes that:

```
Postgres    47,382 events stored     ████████████████████░   climbing
Redis        5,000 / 5,000 jobs      ██████████████████████  flat

WAITING 42,381 · QUEUED 5,000 · PROCESSING 10 · DELIVERED 1 · FAILED 0
```

Flip the receiver from failing to healthy and watch the backlog drain to zero without restarting anything.

### Deliberately narrow scope

**One screen.** No CRUD forms for projects, webhooks or API keys.

That admin surface is the bulk of the frontend work, demonstrates nothing unusual, and actively dilutes the project — "webhook platform with a React dashboard" reads like every other portfolio entry, while "bounded-memory webhook delivery, proven under a 50,000-event backlog" does not. Build the screen that shows the hard part; skip the rest.

### Backend work this forces

Three things the API needs before any browser can talk to it. They are backend tasks, listed here because the frontend is what creates the need.

- **CORS** (`@fastify/cors`) with an explicit origin allowlist. Never `*`, since requests carry credentials.
- **Refresh tokens.** Access tokens expire in an hour with no renewal path. Fine for a script; for a person using a dashboard it means being logged out mid-task, hourly, with no warning.
- **A decision on where the browser keeps its token.** `localStorage` is readable by any injected script, so one XSS bug surrenders every session. An httpOnly cookie is unreadable by JavaScript but brings CSRF into scope. There is no cost-free option; pick deliberately.

### Stack

Vite + React + TanStack Query. The page sits behind a login and has no public content, so server-side rendering buys nothing that would justify Next.js's additional machinery.

Live updates via polling on a short interval. Server-sent events would be tidier, and can replace polling later — it is not worth the extra moving part for the first version.

**Done when:** a single page shows Postgres and Redis counts updating live during the M5 load test, with the Redis gauge visibly pinned at its ceiling while the Postgres count climbs past it.

---

## M7 — Deploy

Goal: a URL, not a repository.

A running system is worth considerably more than source code — anyone can clone a repo; far fewer can point at something operating. This is also what gives M6's monitor somewhere to live.

- Host the API, scheduler, worker, Postgres and Redis (Railway or Fly.io; both handle the multi-process shape cheaply)
- Run migrations on deploy
- Real secrets from the platform's secret store, never from a committed file
- Public URL in the README, alongside the monitor

**Done when:** someone with the link can watch the execution window hold its ceiling, without installing anything.

---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection |
| `REDIS_URL` | — | Redis connection |
| `JWT_SECRET` | — | Management-token signing key |
| `EXECUTION_WINDOW_SIZE` | `5000` | Hard cap on jobs resident in Redis |
| `SCHEDULER_POLL_MS` | `2000` | Refill interval |
| `WORKER_CONCURRENCY` | `10` | Parallel deliveries per worker process |
| `MAX_ATTEMPTS` | `8` | Attempts before `FAILED` |
| `DELIVERY_TIMEOUT_MS` | `10000` | Per-request outbound timeout |
| `LEASE_TIMEOUT_MS` | `60000` | Age at which a `PROCESSING` row is considered abandoned |

---

## Deferred

Full admin dashboard (project, webhook and key management screens) · dynamic window sizing · priority queues · multi-region workers · event partitioning · Kafka · Kubernetes · Prometheus/Grafana · OpenTelemetry

Note that the *admin* dashboard stays deferred even after M6. M6 builds the observability screen only — the one that shows something worth seeing.
