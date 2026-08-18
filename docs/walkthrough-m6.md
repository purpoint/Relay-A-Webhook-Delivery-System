# Relay — M6 Walkthrough: The Monitor, Sessions & CI

A complete, beginner-level explanation of the sixth milestone. Assumes you've read [walkthrough.md](walkthrough.md) and [M1](walkthrough-m1.md)–[M5](walkthrough-m5.md).

M5 finished the backend. M6 makes it **visible** — and, as it turned out, produced more backend work than frontend work.

---

# Part 1 — Why a backend project has a frontend at all

The honest answer: **it doesn't need one.**

The architecture was complete at M5. An engineer evaluating this project would read the code, the README and the commit history, and form their view without ever seeing a page.

But there's a step before that engineer. Someone opens the link first and decides whether to pass it on. Without a page they see a README and move on; the load-test table convinces a reader who studies it, and a gauge pinned below its ceiling convinces in about ten seconds. **The page doesn't evaluate you — it gets you evaluated.**

There's a risk too, and it shaped the scope. *"Webhook platform with a React dashboard"* sounds like every other portfolio project. *"Bounded-memory webhook delivery, proven under a 50,000-event backlog"* does not. So the page is deliberately **one screen** — no project management, no webhook forms, no event browser. Those are the boring 80% of frontend work and they'd bury the one screen worth showing.

## The thing that actually came out of it

The most substantial work in M6 isn't the page. It's the **session handling** the page forced: refresh tokens, rotation, and reuse detection. That's real backend security work, and it exists only because of one decision.

---

# Part 2 — The decision that shaped everything

Before writing anything, one question: **should the monitor require a login?**

| | Public | Behind a login |
|---|---|---|
| Recruiter clicking the link | sees the gauges | sees a login form |
| Backend work needed | almost none | refresh tokens, token storage, login screen |
| Correct for a real product | no — leaks tenant totals | yes |

Public was the cheaper answer, and I recommended it. **You chose login**, which is the right call if Relay ever served real customers — combined totals across tenants would reveal their traffic volumes.

That choice pulled in everything in Parts 3 and 4. Worth noting: it also produced the most interview-worthy code in the milestone. The cheaper path would have skipped it entirely.

---

# Part 3 — Two tokens, and why

## The problem with what we had

M1's access token lasted **one hour** with no way to renew it.

Fine for a script publishing events. Miserable for a person watching a dashboard: they get signed out mid-session, with no warning, every hour.

## The problem with the obvious fix

"Just make it last a week."

A JWT is verified by its **signature alone** — the server stores nothing. That's what makes it stateless and scalable, and it's also its weakness: **you cannot revoke one.** There's no record to delete. A stolen token works until it expires, and nothing you do can stop it.

A one-hour token that can't be revoked is an acceptable risk. A one-week token that can't be revoked is not.

## The split

| | Access token | Refresh token |
|---|---|---|
| What it is | a signed JWT | an opaque random string |
| Lives | **15 minutes** | 7 days |
| Stored server-side | nothing | a database row (hashed) |
| Revocable | no | **yes** |
| Lives in the browser | **JavaScript memory only** | an **httpOnly cookie** |

The access token got *shorter* — from an hour to fifteen minutes — because the refresh token now covers the gap. A stolen access token is worth fifteen minutes instead of sixty.

## Where the browser keeps them

This is a real security decision with no cost-free option.

**`localStorage`** is the easy answer and the wrong one. Any injected script can read it, so a single XSS bug hands over a working credential.

So:

- **Access token → a JavaScript variable.** Not `localStorage`, not `sessionStorage`, not a readable cookie. It dies with the tab.
- **Refresh token → an httpOnly cookie.** The browser sends it automatically; JavaScript literally cannot read it.

An XSS bug can now steal at most fifteen minutes of access, and cannot steal the thing that would grant a week of it.

You can see this yourself: **reload the monitor page.** The access token is gone — but you stay signed in, because the cookie silently obtained a new one. The credential was never readable by script at any point.

## The CSRF question

Cookies normally introduce **Cross-Site Request Forgery**: a malicious site makes your browser send a request to ours, and the browser helpfully attaches your cookie.

The cookie is marked `SameSite=Strict`, which tells the browser never to send it on requests originating from another site. That closes CSRF without a separate token — and it's only workable because the frontend is served from the **same origin** as the API. A separately hosted frontend would need `SameSite=Lax` or `None` plus explicit CSRF tokens.

That's the first of several payoffs from a decision in Part 7.

---

# Part 4 — Rotation, and catching a stolen cookie

The most interesting code in M6.

## The problem

A refresh token lives a week. If someone copies it — from a stolen laptop, a shared machine, a browser exploit — they have your session for a week and **nothing in the system notices.**

Revocability doesn't help if nobody knows to revoke.

## Rotation

Every refresh does two things: issues a **new** token, and **revokes the one presented**.

A well-behaved client discards the old token the instant it swaps it. So presenting an already-exchanged token is something a legitimate client *never does*.

## What that gives you

Follow a theft:

```
1. Attacker copies the cookie. Both parties now hold token A.
2. You refresh.        A is exchanged for B. A is now revoked.
3. Attacker refreshes.  They present A.
```

Step 3 is impossible for a correct client. It is proof that **two parties hold the same token** — the cookie was copied.

## What we do about it

We cannot tell which party is legitimate. The attacker's request looks exactly like yours.

So **every session for that account is revoked.** You sign in again, mildly annoyed. The attacker is left with nothing.

That's the right trade: a minor inconvenience for the owner, total loss for the thief. And crucially, the alternative — doing nothing — means the thief keeps access for a week and nobody ever finds out.

There's a test walking that exact sequence, and another confirming the damage stops at one account: Ada's incident doesn't touch Bob's session.

## And signing out

Logout revokes **only the presented token**. Signing out on a laptop doesn't sign you out on your phone — those are separate rows.

---

# Part 5 — A bug you found by clicking

Worth recording, because of *how* it was found.

I built Swagger UI in M5, tested that `/docs` returned `200`, confirmed the OpenAPI document listed 20 paths, and called it done.

Then you opened it and hit **Try it out** on `POST /auth/register`:

```
Parameters:  No parameters
```

No request body. Nothing to edit. Every endpoint dumped under `default`, and the tag groups I'd declared — `auth`, `projects`, `webhooks` — all empty.

**The page was useless.** I'd told you to edit a request body that didn't exist.

## Why

Fastify builds its OpenAPI document from **route schemas**. Our routes had none — validation ran with Zod *inside* each handler, which the generator cannot see. It reported no parameters because, as far as it knew, there were none.

## The fix, and the one I avoided

The quick fix is to hand-write JSON Schema on each route. That works, and it creates **two definitions of every request shape**, which start disagreeing the first time someone changes one and forgets the other.

Instead, `fastify-type-provider-zod` converts the Zod schemas we already have into the JSON Schema OpenAPI wants. Same object validates the request and documents it. They cannot drift, because they are the same object.

It also moved validation to the framework boundary, so malformed input is rejected before a handler runs.

## The lesson

Same shape as the SSRF bug in M2: **I tested the property I could measure, not the one that mattered.** `200 OK` and "20 paths documented" were both true, and both irrelevant to whether the page worked. You found it in ten seconds by using it.

---

# Part 6 — The page

One screen. Two bars.

```
POSTGRES — DURABLE          6,400          REDIS — EXECUTION WINDOW   5,000 / 5,000
████████████████████░                      ██████████████████████  (amber)
6,400 events · unbounded, on disk          5,000 ready · 0 in flight · peak 5,000

PENDING 1,000 · QUEUED 5,000 · PROCESSING 0 · WAITING 0 · DELIVERED 0 · FAILED 0
```

Read across: 6,400 deliveries exist, Redis holds exactly 5,000, and 1,000 wait on disk. The bar turns **amber at capacity** so "at the cap" is visible without reading a number.

## The peak counter

The most useful thing on the page, and the least obvious.

A live reading shows the cap holding **now**. The peak shows it held **throughout** — including the moments between one-second polls that were never rendered. Without it you'd be trusting that nothing spiked while you blinked.

## Polling, not streaming

The page asks the server for a fresh snapshot every second. Server-sent events would be tidier and push updates instantly, but they're another moving part — a long-lived connection with its own reconnection logic — for a page where one second of latency is imperceptible.

The endpoint behind it is deliberately cheap: **two Redis `LLEN`s and two grouped counts.** No joins, no scans. Anything expensive belongs on the history endpoints, which a human triggers deliberately.

## Why the window numbers are system-wide

Delivery counts are per-project. The window figures aren't — because **the window isn't**. It's one bounded pool that every project's deliveries pass through. A per-project slice of it would say nothing about whether the cap holds.

---

# Part 7 — Serving the page from the API

The built React app is served by Fastify itself, from the same origin.

The alternative — deploying the frontend to Vercel and keeping the API separate — is more conventional at larger scale. Same origin wins here for three specific reasons:

**No CORS.** No origin allowlist, no preflight requests, no `Access-Control-*` headers to get subtly wrong.

**`SameSite=Strict` works.** As in Part 3, that's what removes CSRF without a separate token. A separate host would need weaker settings plus more machinery.

**One service to deploy** instead of two, which makes M7 meaningfully simpler and cheaper.

## A crash while wiring it up

Registering the static plugin blew up at startup:

```
Not found handler already set for Fastify instance with prefix: '/'
```

Fastify allows exactly one not-found handler per prefix, and the error handler from M0 already owned it.

The fix put the single-page fallback **inside** the error handler, which also keeps one rule in one place:

| Request | Response |
|---|---|
| `GET /some/route` | the app — its routes live in the browser |
| `GET /api/v1/nope` | JSON `404` |
| `GET /docs/nope` | JSON `404` |

That exclusion matters. An API typo answering with a page of HTML is genuinely painful to debug against — you get a parse error somewhere unrelated instead of a clear `404`.

---

# Part 8 — Four terminals was too many

Not a bug, but the friction was real. Testing the system meant running the API, the scheduler, the workers and a receiver — four servers, and remembering which tab was which. It produced repeated `EADDRINUSE` errors from starting the API twice.

## `RELAY_ROLE`

One entrypoint, four modes:

```
RELAY_ROLE=api        just the HTTP server
RELAY_ROLE=scheduler  just the execution-window manager
RELAY_ROLE=worker     just the delivery pool
RELAY_ROLE=all        all three in one process
```

Local development became two terminals. `docker-compose` still runs three separate services — the same image three times, differing only by role.

## Why this strengthens the architecture rather than weakening it

The tiers stay genuinely independent under `all`: they share no state and communicate only through Postgres and Redis, exactly as they would across machines. Co-locating them is a **deployment decision, not an architectural one**.

And it's the more interesting position to defend. Splitting processes is easy; knowing *when not to* is the harder judgement. At this load one machine copes comfortably, and three services would be cost and supervision for nothing.

## A shutdown detail

Components stop in start order: API first, so no new events arrive, then the scheduler and workers finish what they already hold. Sequential rather than parallel — closing shared connections underneath an in-flight delivery would strand it in `PROCESSING` until its lease expired.

---

# Part 9 — CI, and the bug it caught immediately

Until now, "248 tests pass" was verifiable only on the machine that ran them.

## What CI is

Every push, GitHub starts a **fresh Ubuntu machine**, boots real Postgres and Redis containers, installs from the lockfile, and runs typecheck, lint and the full suite. Three jobs:

| Job | Proves |
|---|---|
| **test** | the suite passes from zero, with real datastores |
| **build** | the production bundle compiles |
| **docker** | the image builds |

`build` is separate on purpose: tests run through `tsx`, which transpiles **without typechecking its output**, so a green suite doesn't mean `npm run build` succeeds.

## It found a real bug on the first run

`test` and `build` passed. **`docker` failed.**

Two defects, both from the Dockerfile going stale when this milestone added a frontend:

**The build failed.** M6 redefined `npm run build` as `build:web && tsc`, and `build:web` starts with `cd web`. The Dockerfile never copied `web/`.

**The second wouldn't have failed anything.** The runtime stage copied `dist/` and not `public/` — so a successfully built image would have served the API and returned `404` for the monitor page. A green build producing a container quietly missing half of what it should serve.

That second one is exactly what CI is for. It wasn't a clever bug; it was **two parts of the project quietly disagreeing** after a change. Nothing would have reported it until deployment, as "why is my URL blank".

## The honest limitation

CI would not have caught the SSRF hole, the timezone bug, or the orphaned deliveries. Those needed the real system running under load. CI runs your tests; it doesn't invent new ones.

What it catches is **regressions and drift** — and it caught one within two minutes of existing.

---

# Part 10 — Where we are

| Check | Result |
|---|---|
| `npm run typecheck` | Clean |
| `npm run lint` | Clean |
| `npm test` | 248 passing |
| CI | 3 jobs green |
| Session restore on reload | Works — cookie recovers it |
| Window cap, live | 5,000 / 5,000, amber, peak 5,000 |
| Full cycle | 6,400 published → all failed → all recovered → 6,400 delivered |

## Something the demo proved by accident

While testing, a sequencing mistake — forcing 3,861 waiting deliveries to be due immediately while the endpoint was **still failing** — caused all 5,982 to exhaust their retries in about twenty seconds and land in `FAILED`.

Two useful things came out of it.

**Backoff was the only thing protecting them.** Left alone they'd have retried over minutes and survived. Overriding it killed them in seconds. That's a real operational lesson: *never force-retry a backlog before confirming the downstream is healthy.*

**`FAILED` is recoverable.** Nothing was lost. All 6,400 still held their full attempt history, and a bulk replay brought every one back and delivered it. That's a better thing to be able to say about a delivery system than "the happy path works".

## Files

| File | |
|---|---|
| `services/session.service.ts` | Rotation, reuse detection, cookie policy |
| `repositories/refresh-token.repository.ts` | Hashed token storage |
| `services/monitor.service.ts` | The cheap snapshot the page polls |
| `config/swagger.ts` | OpenAPI generated from the Zod schemas |
| `config/static.ts` | Serving the built page same-origin |
| `src/main.ts` | One entrypoint, four roles |
| `web/` | The React app — about 950 lines |
| `.github/workflows/ci.yml` | Three jobs |

## What's left

**M7 — deploy.** The last real gap. Everything needed is in place: the image builds and CI proves it, `RELAY_ROLE=all` collapses three services into one, and same-origin serving means there's only one thing to host.

After that the project stops being source code that claims something and becomes a URL where you can watch it happen.

---

# Appendix — New terms

| Term | Meaning |
|---|---|
| **Access token** | Short-lived credential proving who you are; here a JWT, held only in memory |
| **CI** | Continuous integration — tests run automatically on a clean machine, every push |
| **CSRF** | Tricking a browser into sending an authenticated request to another site |
| **httpOnly** | A cookie flag making it unreadable by JavaScript |
| **OpenAPI** | The specification format Swagger UI renders |
| **Refresh token** | Long-lived, revocable credential used to obtain new access tokens |
| **Rotation** | Replacing a refresh token on every use, so reuse becomes detectable |
| **SameSite=Strict** | A cookie flag stopping the browser sending it on cross-site requests |
| **Service container** | A database or cache started alongside a CI job |
| **SPA fallback** | Serving the app shell for unmatched routes, since routing happens in the browser |
| **XSS** | Injecting script into a page, which can then read anything JavaScript can |
