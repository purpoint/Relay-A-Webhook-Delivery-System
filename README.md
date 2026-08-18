# Relay

[![CI](https://github.com/purpoint/Relay-A-Webhook-Delivery-System/actions/workflows/ci.yml/badge.svg)](https://github.com/purpoint/Relay-A-Webhook-Delivery-System/actions/workflows/ci.yml)

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

## The proof

`npm run load-test` publishes 50,000 events at an endpoint returning `500`, then samples both datastores. A real run:

```
elapsed |  postgres | redis (ready+flight) | PENDING  WAITING  DELIVERED
0s      |     50000 |  2949 ( 2924+ 25)    |    1076    46070          0
24s     |     50000 |     0 (    0+  0)    |       0    50000          0   ← 50k pending, Redis empty
40s     |     50000 |   737 (  718+ 19)    |       0    49316          0

Peak Redis occupancy: 3,035 of 5,000
```

Then flip the endpoint healthy — nothing restarted:

```
final: delivered=50000 failed=0
redis: window=0 inflight=0 dedupe=0
```

The receiver logged **192,808 rejected attempts** during the outage. Every one was tracked, backed off and rescheduled through Postgres while Redis never exceeded 3,035.

## Status

Under construction, milestone by milestone. See [docs/milestone.md](docs/milestone.md).

- [x] **M0** — Scaffold: config, logging, health probes, Prisma schema
- [x] **M1** — Auth & tenancy: users, projects, API keys
- [x] **M2** — Webhooks & event ingest: fan-out, idempotency, SSRF guard
- [x] **M3** — Execution window & scheduler: bounded Redis, Lua atomicity, SKIP LOCKED
- [x] **M4** — Worker pool: HMAC signing, jittered backoff, lease recovery
- [x] **M5** — Observability & hardening: delivery history, replay, Swagger, load test
- [ ] **M6** — Live execution-window monitor (single screen)
- [ ] **M7** — Deploy, with a public URL

## Running locally

Requires Node 20+, Postgres and Redis.

```bash
npm install
cp .env.example .env      # then fill in DATABASE_URL and JWT_SECRET
createdb relay
npm run db:migrate
npm run build:web
npm run dev
```

That's everything — API, scheduler and workers in one process. Open **http://localhost:3000**, and the API docs at **/docs**.

```bash
curl -s localhost:3000/readyz
```

`/readyz` genuinely reaches both datastores and returns 503 if either is down, so a red response means a real dependency is unavailable.

### One process or three

`RELAY_ROLE` selects which tier a process runs:

| | |
|---|---|
| `npm run dev` | all three — development, and small deployments |
| `npm run dev:api` | HTTP server only |
| `npm run dev:scheduler` | execution-window manager only |
| `npm run dev:worker` | delivery pool only |

The tiers are genuinely independent either way: they share no state and communicate only through Postgres and Redis, exactly as they would across machines. `all` simply co-locates them, which is the right call until one machine stops coping.

### Watching it work

Four terminals, or two if you use the combined role:

```bash
npm run receiver     # a fake customer endpoint on :4000, returning 500
npm run dev          # api + scheduler + workers
```

Then publish a backlog into the account you're signed in as:

```bash
npm run load-test -- --email you@example.com --password your-password --events 20000
```

Watch the monitor. To see the cap hold, run `npm run dev:api` and `npm run dev:scheduler` **without** a worker — nothing drains, so Redis fills to 5,000 and stops while Postgres keeps climbing.

Then repair the endpoint, with nothing restarted:

```bash
echo ok > /tmp/relay-receiver-mode
```

### With Docker

```bash
JWT_SECRET=$(openssl rand -base64 36) docker compose up --build
```

Brings up Postgres, Redis, migrations, and the three tiers as separate services from the same image. Add workers with `--scale worker=5`.

## Design notes

**Event vs Delivery.** An `Event` is the immutable fact that something happened. A `Delivery` is one attempt-stream against one webhook. An event fanned out to three endpoints has three independent outcomes, so delivery status lives on `Delivery` — a single column on `Event` could not represent "delivered to two, still retrying the third". The execution window schedules delivery IDs.

**No queue library.** The window is built directly on Redis list commands. Retries live in Postgres by design, which is exactly the feature a queue library would provide, so adopting one would mean switching off its main purpose. Hand-writing it also makes the cap directly observable: occupancy is one `LLEN`.

**Crash recovery in Postgres.** A worker that dies mid-delivery leaves a row in `PROCESSING`. The scheduler's reaper returns any row whose lease has expired to `WAITING`. Postgres is the source of truth, so Postgres decides what is stale.

## Documentation

**Learning the codebase?** Start with the walkthroughs — they assume no prior knowledge and explain the reasoning, not just the code.

| | |
|---|---|
| [Walkthrough](docs/walkthrough.md) | The project from first principles, plus M0 |
| [Walkthrough — M1](docs/walkthrough-m1.md) | Authentication, hashing, JWTs, tenancy |
| [Walkthrough — M2](docs/walkthrough-m2.md) | SSRF, fan-out transactions, idempotency |
| [Walkthrough — M3](docs/walkthrough-m3.md) | The bounded window, Lua atomicity, SKIP LOCKED |
| [Walkthrough — M4](docs/walkthrough-m4.md) | HMAC signing, thundering herds, claiming without locks |
| [Walkthrough — M5](docs/walkthrough-m5.md) | Delivery history, keyset pagination, and the proof |

Reference:

| | |
|---|---|
| [Overview](docs/Overview.md) | Vision and the problem being solved |
| [Architecture](docs/Architecture.md) | Components and data flow |
| [Tech stack & design](docs/Documentation_techstack_desgin.md) | Stack, principles, event lifecycle |
| [Milestones](docs/milestone.md) | Build plan, M0 through M7 |

## Licence

MIT
