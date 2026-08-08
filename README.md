# Relay

A webhook delivery platform built around one constraint: **Postgres stores every event forever, Redis holds only the next 5,000 executable jobs.**

## The problem

A customer's endpoint goes down for a week. At 10,000 events/hour that's 1.68 million pending deliveries. Platforms that keep pending retries in their queue hold all 1.68 million in Redis, and memory becomes the bottleneck long before the endpoint recovers.

## The approach

Storage and execution are separate responsibilities.

```
POST /api/v1/events ──> Postgres: 1 Event + N Delivery rows (one txn)
                              │
                        Scheduler
                              │  reads PENDING + due WAITING
                              │  refills up to the cap, never past it
                              ▼
                    Redis: bounded execution window (≤ 5,000)
                              │
                        Worker Pool
                              │
                        HTTP POST + HMAC ──> customer endpoint
                              │
                    2xx → DELIVERED   │   else → WAITING + nextRetryAt
                              └──────────┴──> Redis entry deleted immediately
```

A failed delivery is **removed** from Redis and marked `WAITING` in Postgres with a `nextRetryAt`. The scheduler brings it back only when the retry falls due. Redis never accumulates a retry backlog, so its memory stays flat whether there are 5,000 pending deliveries or 5 million.

That single property — **50,000 durable in Postgres, never more than 5,000 resident in Redis** — is what the project exists to demonstrate.

## Status

Under construction, milestone by milestone. See [docs/milestone.md](docs/milestone.md).

- [x] **M0** — Scaffold: config, logging, health probes, Prisma schema
- [x] **M1** — Auth & tenancy: users, projects, API keys
- [ ] **M2** — Webhooks & event ingest
- [ ] **M3** — Execution window & scheduler
- [ ] **M4** — Worker pool
- [ ] **M5** — Observability & hardening

## Running locally

Requires Node 20+, Postgres and Redis.

```bash
npm install
cp .env.example .env      # then fill in DATABASE_URL and JWT_SECRET
createdb relay
npm run db:migrate
npm run dev
```

Verify it's up:

```bash
curl -s localhost:3000/readyz
```

`/readyz` genuinely reaches both datastores and returns 503 if either is unavailable, so a red response here means a real dependency is down.

### With Docker

```bash
JWT_SECRET=$(openssl rand -base64 36) docker compose up --build
```

Brings up Postgres, Redis, migrations, the API, a scheduler and two workers. Add workers with `--scale worker=5`.

## Design notes

**Event vs Delivery.** An `Event` is the immutable fact that something happened. A `Delivery` is one attempt-stream against one webhook. An event fanned out to three endpoints has three independent outcomes, so delivery status lives on `Delivery` — a single column on `Event` could not represent "delivered to two, still retrying the third". The execution window schedules delivery IDs.

**No queue library.** The window is built directly on Redis list commands. Retries live in Postgres by design, which is exactly the feature a queue library would provide, so adopting one would mean switching off its main purpose. Hand-writing it also makes the cap directly observable: occupancy is one `LLEN`.

**Crash recovery in Postgres.** A worker that dies mid-delivery leaves a row in `PROCESSING`. The scheduler's reaper returns any row whose lease has expired to `WAITING`. Postgres is the source of truth, so Postgres decides what is stale.

## Documentation

| | |
|---|---|
| [Overview](docs/Overview.md) | Vision and the problem being solved |
| [Architecture](docs/Architecture.md) | Components and data flow |
| [Tech stack & design](docs/Documentation_techstack_desgin.md) | Stack, principles, event lifecycle |
| [Milestones](docs/milestone.md) | Build plan, M0 through M5 |

## Licence

MIT
