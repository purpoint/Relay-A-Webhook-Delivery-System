# Relay — M1 Walkthrough: Authentication & Tenancy

A complete, beginner-level explanation of the second milestone. Assumes you've read [walkthrough.md](walkthrough.md), but nothing beyond it.

Every example below uses **illustrative values** — tokens and keys are made up, never real ones.

---

# Part 1 — What this milestone is for

## Where we were

After M0, Relay could boot, connect to Postgres, and tell you honestly whether it was healthy. It had a database schema with seven tables.

But **anybody could call it**. There was no notion of a user, no way to say "this project is mine," no way for a customer's server to identify itself. That's what M1 adds.

## Two words that sound alike

| | The question | Example |
|---|---|---|
| **Authentication** | *Who are you?* | Logging in with a password |
| **Authorisation** | *Are you allowed to do this?* | Checking that the project you asked for is yours |

Both are needed, and they fail differently.

Get authentication wrong and strangers get in — loud, obvious, embarrassing.

Get **authorisation** wrong and something worse happens: legitimate, logged-in users can read each other's data. Nothing crashes. No error appears in any log. It works perfectly, for the wrong person.

## What multi-tenancy means

Relay is **multi-tenant**. One running system, one database, many separate customers.

Your projects and my projects are rows in the same `projects` table. The only thing separating them is a column:

```
 id        │ userId   │ name
───────────┼──────────┼──────────────────
 abc-123   │ ada-1    │ Ada's shop
 def-456   │ bob-2    │ Bob's newsletter   ← different owner, same table
 ghi-789   │ ada-1    │ Ada's other thing
```

The alternative — a separate database per customer — is how some enterprise software works. It's simpler to reason about and vastly more expensive to run. Multi-tenant is the normal choice for a SaaS product, and the price you pay is that **every single query must remember the boundary.**

One forgotten `WHERE userId = ...` and Bob sees Ada's data.

This is why M1 is mostly about being careful, and why a third of its code is tests.

---

# Part 2 — Who actually calls Relay?

Two very different callers, and recognising that shapes the whole design.

## Caller 1: a person

A developer at a customer company. They open a dashboard, log in with email and password, create a project, register their webhook URLs, and look at delivery history.

- Present at a keyboard
- Can be asked to log in again
- Does a wide variety of things
- Sessions are short — hours

## Caller 2: a machine

The customer's *backend server*. Every time a payment succeeds in their system, their code calls Relay saying "publish this event."

- No human present, ever
- Cannot be asked to log in
- Does exactly **one** thing, millions of times
- Runs for years without redeployment

Handing both the same credential would be a mistake. So they get different ones.

| | JWT | API key |
|---|---|---|
| Given to | a person | a machine |
| Obtained by | logging in | created once in the dashboard |
| Lives for | 1 hour | until revoked (years) |
| Stored where | browser memory | a config file or secrets manager |
| Can do | everything | publish events, **nothing else** |

### Why the split genuinely matters

Think about which one is more likely to leak.

A JWT lives in a browser for an hour, then it's worthless. An API key sits in a customer's server configuration, gets copied into a `.env` file, maybe pasted into a Slack message, possibly committed to a git repo by accident, and **stays valid for years**.

API keys leak. It's not a hypothetical — GitHub scans public repositories for them continuously.

So the design assumes a key will eventually leak, and asks: *what's the blast radius?* With this split, an attacker holding a leaked key can publish junk events into that one project. They **cannot**:

- Read the customer's delivery history
- See or change their webhook URLs
- Create new projects
- Mint further API keys
- Touch any other customer

That containment is the whole reason for two credential types.

---

# Part 3 — The four layers

Every feature from here follows the same chain. Understanding it now pays off in every later milestone.

```
   HTTP request arrives
          │
          ▼
   ┌──────────────┐
   │   ROUTE      │  Which URL? Which method? What auth is required?
   └──────────────┘
          │
          ▼
   ┌──────────────┐
   │  CONTROLLER  │  Read the request, call a service, send a response
   └──────────────┘
          │
          ▼
   ┌──────────────┐
   │   SERVICE    │  The actual rules. "Does this user own this project?"
   └──────────────┘
          │
          ▼
   ┌──────────────┐
   │  REPOSITORY  │  The ONLY code that talks to the database
   └──────────────┘
          │
          ▼
      PostgreSQL
```

Each layer only ever calls the one directly below it.

## Why bother? Three concrete reasons

### 1. The scheduler and workers will reuse the services

This is the big one, and it's the reason the docs insisted on this structure.

In M3 and M4 we build two background programs. They will need business logic — "load this delivery," "mark it delivered." **They have no HTTP request at all.** No headers, no response object, nothing.

If the rules lived inside the route handler, none of it could be reused. The background programs would need a duplicate copy, and the two copies would drift apart until they disagreed about something important.

With layers, both the web request and the background loop call the same service function.

### 2. Testing gets dramatically easier

A service function is just a function. Call it, check what it returns. No web server, no HTTP, no ports.

### 3. Swapping the database doesn't touch your logic

Every Prisma call lives in the repository layer. If Relay ever moved off Prisma, the services above wouldn't change by a single line — they don't know what a database *is*.

## A worked example

Let's follow one real request all the way down: **creating an API key.**

```
POST /api/v1/projects/abc-123/api-keys
Authorization: Bearer eyJhbGci...
{ "name": "production" }
```

**Route** (`routes/v1/project.routes.ts`)
> "This path exists. Before the handler runs, `requireUser` must pass." The JWT is verified; if it's missing or invalid, we stop here with a 401 and never touch the database.

**Controller** (the handler function itself)
> Pull `projectId` from the URL and validate it's a real UUID. Parse the body and validate `name`. Call the service. Wrap whatever comes back in the standard envelope.

**Service** (`services/project.service.ts`)
> First: **does this user own project `abc-123`?** If not, throw `NotFoundError`. Then generate a key, hash it, and ask the repository to save it. Log that a key was issued.

**Repository** (`repositories/api-key.repository.ts`)
> `INSERT INTO api_keys ...`. That's all. It doesn't know what an API key means, only how to store the row.

Notice the ownership check happened in the **service**, not the route. That's deliberate — it means it applies no matter who calls it.

---

# Part 4 — Passwords

## What hashing is, from scratch

We must never store your actual password. If our database leaked, every password would be exposed — and because people reuse passwords, we'd have handed away their email, bank, and everything else.

So we store a **hash**: the result of a one-way mathematical scramble.

```
"correct horse battery staple"  →  hash  →  "$argon2id$v=19$m=19456,t=2,p=1$Ky8x..."
```

The defining property: **you cannot reverse it.** Given the hash, there is no calculation that recovers the password.

Logging in works like this:

1. You type a password
2. We hash what you typed
3. We compare the two hashes

If they match, you knew the password. **We still never learn what it is.**

## Why not just SHA-256?

SHA-256 is a hash, it's one-way, so why not use it for passwords?

Because it's **fast** — and for passwords, fast is fatal.

A modern GPU computes billions of SHA-256 hashes per second. An attacker with a leaked database doesn't try to reverse the hash. They **guess**:

```
hash("password")   → compare → no
hash("123456")     → compare → no
hash("hunter2")    → compare → MATCH
```

Running through every common password takes minutes. Human-chosen passwords simply don't have enough possibilities to survive a billion guesses per second.

## Argon2: slow on purpose

Argon2 is designed to be **expensive**. Our settings:

| Setting | Value | Meaning |
|---|---|---|
| `memoryCost` | 19,456 KB (19 MB) | RAM required per hash |
| `timeCost` | 2 | Passes over that memory |
| `parallelism` | 1 | Threads used |

One hash takes ~50ms and 19MB.

**When you log in:** 50ms. You don't notice.

**For an attacker:** catastrophic. They wanted a billion guesses a second; now each guess costs 50ms *and 19MB of RAM*. The memory requirement is the clever part — GPUs get their speed from running thousands of tiny cores in parallel, and those cores have very little memory each. Demanding 19MB per hash takes their main advantage away.

### Why Argon2**id**?

There are three variants:

| Variant | Strength | Weakness |
|---|---|---|
| Argon2**d** | Strong against GPUs | Vulnerable to side-channel attacks |
| Argon2**i** | Strong against side-channels | Weaker against GPUs |
| Argon2**id** | Hybrid — uses `i` for the first pass, `d` after | Best all-round |

Argon2id is what OWASP recommends. Our cost parameters are their published minimum.

*(A **side-channel attack** means learning secrets by observing physical behaviour — timing, power draw, memory access patterns — rather than breaking the maths.)*

## Salt (which Argon2 handles for us)

If hashing were purely deterministic, two users with the same password would have identical hashes. An attacker could then precompute hashes of common passwords once and match them against every leaked database ever — a **rainbow table**.

A **salt** is random data mixed in per password:

```
Ada:  hash("hunter2" + "a8f3d2...")  →  $argon2id$...Ky8x...
Bob:  hash("hunter2" + "9c1e7b...")  →  $argon2id$...Pm4z...   ← different!
```

Same password, different hashes. Precomputation becomes useless — every password must be attacked individually.

Argon2 generates a salt automatically and stores it inside the hash string, which is why the output looks like `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`. Nothing extra to manage.

## Our password rule (and why it's not what you'd expect)

The only requirement is **12 characters minimum**, 72 maximum.

No "must contain a capital letter, a number, and a symbol."

That surprises people, so here's the reasoning. Composition rules **actively make passwords worse**:

- They push everyone toward the same predictable shapes. `Password1!` ticks every box and is among the first things any cracker tries.
- They block genuinely strong passphrases. `my dog ate three socks tuesday` is far harder to crack than `P@ssw0rd`, but fails a "must contain a symbol" rule.
- They cause people to write passwords down or reuse them.

Both NIST (US standards body) and OWASP have moved to recommending length minimums with no composition rules. We follow that.

*(The 72-character ceiling exists because several password hashes silently truncate beyond it. Rejecting it clearly beats accepting it and quietly ignoring the rest.)*

---

# Part 5 — API keys, and why they're hashed differently

Here's the part that surprises most people learning this.

**Passwords use Argon2. API keys use SHA-256.** Two different algorithms for two secrets in the same system — and using Argon2 for both would be *wrong*.

## Where the security comes from

The critical question for any secret: **what actually stops an attacker guessing it?**

### For a password: nothing much

Humans choose passwords. The realistic space is maybe a few million likely options. You cannot make that unguessable, so the only lever left is making **each guess expensive**. Hence Argon2.

### For an API key: mathematics

We generate keys ourselves, from the operating system's cryptographic random number generator:

```
rlk_live_ + 32 random bytes  =  256 bits of entropy
```

How many possibilities is 2²⁵⁶?

```
115,792,089,237,316,195,423,570,985,008,687,907,853,
269,984,665,640,564,039,457,584,007,913,129,639,936
```

Nobody guesses that. Not with every computer on Earth running until the sun burns out. There is **nothing to slow down** — the entropy has already won.

So slow hashing here buys **zero** additional security. And it costs a great deal:

## Cost 1 — it's on the hottest path in the system

Every published event validates an API key. At 10,000 events/hour that's 10,000 Argon2 hashes an hour — 50ms and 19MB each — purely to re-prove something mathematics already guaranteed.

## Cost 2 — you couldn't look the key up at all

This one is structural, and it's the real killer.

Argon2 salts randomly, so the **same key hashes differently every time**:

```
hash("rlk_live_abc...")  →  $argon2id$...Ky8x...
hash("rlk_live_abc...")  →  $argon2id$...Pm4z...   ← same key, different hash!
```

Excellent for passwords. Fatal here. To find which key a request used, you'd have to:

```
Load EVERY key in the database
For each one: run Argon2 verify (50ms)
Stop when one matches
```

With 10,000 keys stored, that's up to **500 seconds** to authenticate one request.

SHA-256 is deterministic — the same input always gives the same output:

```
sha256("rlk_live_abc...")  →  "3f7a2b..."   (always, every time)
```

So we store that hash with a unique index on it, and authentication becomes **one indexed lookup**. Sub-millisecond.

## The lesson

> "Always use the strongest hash" is wrong advice. The right algorithm depends on **where the security comes from**. Slowness protects low-entropy secrets. High-entropy secrets protect themselves, and slowness only costs you.

## Three more details about keys

### The `rlk_live_` prefix

Every key starts with it. Two reasons:

1. **Secret scanners** — GitHub, GitGuardian and others match known prefixes. A key accidentally pushed to a public repo gets detected, and we could be notified to revoke it.
2. **Fast rejection** — a value not starting with `rlk_live_` isn't one of ours, so we reject it without touching the database.

### Shown exactly once

The creation response contains the plaintext key. **No other response ever will.**

We store only the SHA-256 hash. That's one-way, so we genuinely *cannot* show it again — not "we choose not to," we *can't*.

Lose it, and you issue a new one. That's not an inconvenience; it's the property that makes a database breach survivable. An attacker who steals the whole `api_keys` table gets a list of hashes and no working credentials.

What we *do* keep in clear is the first 15 characters — `rlk_live_oLeRp4` — enough to tell keys apart in a list, useless as a credential.

### Revoked, never deleted

Revoking sets `revokedAt` to a timestamp rather than deleting the row.

- The audit trail of which key published which event stays intact
- Revocation is instant, because the lookup filters on `revokedAt: null`
- You can see *when* a key was retired

---

# Part 6 — JWTs

## The problem they solve

HTTP is **stateless** — every request is independent, and the server remembers nothing between them. So how does request #2 know you logged in during request #1?

### The old answer: sessions

1. You log in
2. Server generates a random session ID, stores `session-xyz → user Ada` in memory or a database
3. You send `session-xyz` with every request
4. Server looks it up each time

This works, but the server must **store and look up** every active session. Run twenty API servers behind a load balancer and they all need access to that shared store — which becomes a bottleneck and a single point of failure.

### The JWT answer: don't store anything

Instead of a random ID pointing at stored data, the token **contains** the data, with a signature proving we issued it.

## What one actually looks like

Three base64-encoded parts separated by dots:

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI3NGI2Ni...In0.8VNvRqbV-np063Le2yLC7zXK
└──────── header ────────┘ └───────── payload ─────────┘ └────── signature ──────┘
```

**Header** — which algorithm signed this:
```json
{ "alg": "HS256", "typ": "JWT" }
```

**Payload** — the claims:
```json
{
  "sub": "74b66714-c1fd-4303-a71b-a9801c60d9fb",
  "email": "demo@relay.dev",
  "iat": 1786210528,
  "exp": 1786214128
}
```

| Claim | Meaning |
|---|---|
| `sub` | **Subject** — who this token is about. The user id. |
| `iat` | **Issued at** — when it was created |
| `exp` | **Expires at** — after this, it's rejected |

**Signature** — `HMAC-SHA256(header + "." + payload, JWT_SECRET)`.

## Why this is safe

Base64 is **encoding, not encryption** — anyone can decode the payload and read it. Paste a JWT into [jwt.io](https://jwt.io) and you'll see its contents immediately.

So what stops someone editing `"sub"` to another user's id?

The **signature**. It's computed using a secret only our server knows. Change even one character of the payload and the signature no longer matches. Forging a valid signature means knowing `JWT_SECRET` — which is why our config refuses to boot if it's shorter than 32 characters.

> **The rule that follows:** a JWT is *signed*, not *encrypted*. **Never put a secret in one.** The signature prevents tampering, not reading.

## The trade-off nobody mentions

JWTs have a real downside: **you cannot easily revoke one.**

With sessions, logging someone out is a delete. With JWTs, the server keeps no record — so a stolen token stays valid until it expires, no matter what.

The mitigation is **short expiry**, which is why ours is one hour. A stolen token is useful for at most an hour, rather than forever.

This is exactly why API keys are the *opposite* design — stored in a database, checkable on every request, revocable instantly. Long-lived credentials need revocation; short-lived ones can do without it.

---

# Part 7 — Validation

## Never trust input

Everything arriving from the network is hostile until proven otherwise. Not because every caller is malicious — most are just buggy — but because you cannot tell them apart.

**Zod** describes the shape data must have, then enforces it:

```ts
export const registerSchema = z.object({
  email: z.email("A valid email address is required").toLowerCase().trim(),
  password: z.string().min(12).max(72),
});
```

Anything that doesn't fit is rejected with a clear `400` before it reaches any logic.

## Validation as normalisation

Notice `.toLowerCase().trim()`. Zod isn't only checking — it's **cleaning**.

Without it, `Ada@Example.com`, `ada@example.com`, and `  ada@example.com  ` would be three different accounts. Users would register once and be unable to log in because they capitalised differently. Normalising at the boundary means everything downstream sees one canonical form.

## Validating URL parameters too

```ts
export const projectIdParamSchema = z.object({
  projectId: z.uuid("Invalid project id"),
});
```

Path parameters arrive as strings — `/projects/banana` is a perfectly valid HTTP request. Without this check, `banana` reaches Postgres, which rejects it as a malformed UUID, and the user gets a confusing `500`.

With it, they get a clean `400 Invalid project id`. **Validation converts other people's mistakes into helpful messages instead of server errors.**

## One boundary, trusted thereafter

Past validation, the rest of the code can assume an email is shaped like an email. No defensive re-checking scattered through the services.

---

# Part 8 — Middleware, and Fastify's request lifecycle

## What middleware is

Code that runs **between** the request arriving and your handler, able to stop the request entirely.

Fastify calls these **hooks**. We use `preHandler` — after the body is parsed, before the route handler:

```
Request arrives
    ↓
Parse body, headers
    ↓
preHandler  ←  requireUser runs here. Fails? 401, handler never runs.
    ↓
Route handler
    ↓
Response
```

## `requireUser` — the JWT gate

```ts
export async function requireUser(request, _reply) {
  try {
    await request.jwtVerify();
  } catch {
    throw new UnauthorizedError("A valid access token is required");
  }
}
```

`jwtVerify()` checks the signature and expiry, then puts the payload on `request.user`.

The catch block is deliberately vague. Distinguishing *expired* from *malformed* from *wrong signature* would tell an attacker how close they are. One message for all failures.

## `requireApiKey` — the machine gate

Reads `X-API-Key`, rejects anything without our prefix, hashes it, one indexed lookup, attaches the key and its project to the request.

### The detail worth understanding

The middleware attaches `request.apiKey.projectId`. The ingest handler in M2 will use **that** to decide which project an event belongs to — never a `projectId` from the request body.

Why does this matter enormously? If the project came from the body, anyone with *any* valid key could publish events into *anyone else's* project just by changing a field. Deriving it from the credential makes that structurally impossible.

### Fire-and-forget bookkeeping

```ts
void touchApiKeyLastUsed(record.id).catch(...)
```

Updating "last used" is a dashboard convenience. It runs on the hottest path in the system, so we **don't wait for it**.

Two reasons. It would add a database round-trip to every published event. And worse — if that write failed transiently, an event we could otherwise have accepted would be rejected. Bookkeeping must never be able to fail the real work.

## Applying auth to a whole group

```ts
app.addHook("preHandler", requireUser);
```

One line inside `projectRoutes`, applying to **every** route in that plugin.

This is a safety property, not a convenience. If each route declared its own auth, a new endpoint added six months from now could omit it and be publicly accessible with nobody noticing. Here, a new route is authenticated **by default** — you'd have to actively work to expose it.

Fastify plugins are isolated scopes, so this hook can't leak into the auth routes, where demanding a token would make logging in impossible.

---

# Part 9 — Tenancy, in detail

The heart of the milestone.

## Enforcing it in the query

Compare two approaches.

**The dangerous one:**
```ts
const project = await prisma.project.findUnique({ where: { id: projectId } });
if (project.userId !== currentUserId) throw new ForbiddenError();
```

**The one we use:**
```ts
return prisma.project.findFirst({ where: { id: projectId, userId } });
```

Both work. The second is far safer, because of **how they fail**.

Forget the check in the first, and the code still runs perfectly — it just returns another customer's project. No error, no crash, nothing in the logs.

In the second, tenancy is part of the query itself. There's no separate step to forget. Wrong owner means zero rows.

> **Design principle:** prefer mistakes that fail loudly over mistakes that fail silently. Better still, prefer structures where the mistake can't be expressed.

## One funnel for ownership

```ts
export async function getOwnedProject(projectId, userId) {
  const project = await findProjectForUser(projectId, userId);
  if (!project) throw new NotFoundError("Project");
  return project;
}
```

Every project-scoped operation calls this first. Listing keys, creating keys, revoking keys — and in M2, everything to do with webhooks and events.

One function, one check, impossible to skip.

## Why 404 and not 403

Bob asks for Ada's project. Two possible replies:

| Response | Says |
|---|---|
| `403 Forbidden` | "This exists, but it isn't yours" |
| `404 Not Found` | "There's nothing here" |

`403` is more *accurate*. It's also a **leak**.

It confirms the ID is real. Someone probing IDs could map out which projects exist, how many customers you have, and roughly when they signed up. That's called **resource enumeration**.

`404` reveals nothing. Bob cannot distinguish "doesn't exist" from "not mine" — which is exactly right, because both mean the same thing *to him*.

---

# Part 10 — Timing attacks

The subtlest thing in this milestone.

## The leak

Consider the natural way to write login:

```
Look up the email
  Not found?  →  return "Invalid email or password"     ← instant
  Found?      →  verify password with Argon2 (~50ms)
                 wrong?  →  return "Invalid email or password"
```

Both paths return the identical message. Looks safe.

It isn't. Watch the **clock**:

| Situation | Response time |
|---|---|
| Email not registered | ~2ms |
| Email registered, wrong password | ~52ms |

That gap is enormous by computer standards and easily measurable across a network.

## The attack

An attacker scripts logins against a list of email addresses using a junk password, and times each one:

```
alice@gmail.com    2ms   →  no account
bob@company.com   51ms   →  ACCOUNT EXISTS
carol@yahoo.com    2ms   →  no account
```

They now know which of a million addresses have accounts here. That's valuable for targeted phishing ("we noticed unusual activity on your Relay account"), and it's a privacy breach on its own — the mere fact that someone uses your service can be sensitive.

This is called **account enumeration**, and here the messages were identical. The timing gave it away.

## The fix

When the email is unknown, do the work anyway:

```ts
if (!user) {
  await verifyPassword(await DUMMY_HASH_PROMISE, password);
  throw new UnauthorizedError("Invalid email or password");
}
```

`DUMMY_HASH_PROMISE` is a precomputed Argon2 hash of a value nobody knows. Verifying against it costs the same ~50ms as a real check. Both paths now take the same time, and the signal disappears.

The hash is computed **once**, when the module loads — not per request, which would itself be a cost difference.

## The general principle

> When comparing secrets, **take the same amount of time regardless of the answer.**

The same idea drives `secureCompare()` in `utils/crypto.ts`. A normal `a === b` returns as soon as it finds a differing byte, so a guess sharing a longer prefix takes measurably longer to reject — enough to recover a secret one byte at a time, given enough samples. `timingSafeEqual` always reads both values in full.

We'll need that in M4 for verifying webhook signatures.

---

# Part 11 — Rate limiting

## The attack it stops

**Credential stuffing.** Attackers hold billions of email/password pairs from past breaches of other companies. Since people reuse passwords, they replay them against every service they can find.

They don't need to be clever. They need to be allowed to try a lot.

## The second reason

There's a defensive irony here. Argon2 makes each login attempt cost **us** ~50ms of CPU and 19MB of RAM.

That's the point — but it also means an unthrottled login endpoint is a **denial-of-service amplifier**. An attacker firing thousands of login attempts per second could exhaust our CPU without ever guessing a password.

So the very thing protecting passwords needs protecting itself.

## Our limits

| Endpoints | Limit |
|---|---|
| Auth (`/register`, `/login`) | 10/minute |
| Everything else | 100/minute |

## Counting per key, not just per IP

```ts
keyGenerator: (request) => {
  const apiKey = request.headers["x-api-key"];
  return typeof apiKey === "string" ? `key:${apiKey}` : `ip:${request.ip}`;
}
```

Counting purely by IP address seems obvious but breaks badly in practice. An entire office shares one public IP. A mobile network shares one across thousands of users. One busy customer would exhaust the budget for everyone behind the same connection.

When a request carries an API key, we count against **that key**. Fair per customer, regardless of where they connect from.

## `trustProxy`, and why it's production-only

Rate limiting by IP requires knowing the real IP. Behind a load balancer, every request appears to come from the balancer — the true client sits in an `X-Forwarded-For` header.

`trustProxy` tells Fastify to believe that header. Correct behind a real proxy.

**Dangerous everywhere else.** With no proxy in front, anyone can just *send* that header and claim to be any IP they like — a different one per request, defeating rate limiting entirely. So it's enabled only in production, where a proxy genuinely exists.

---

# Part 12 — Every file in this milestone

| File | Responsibility |
|---|---|
| `utils/crypto.ts` | Password hashing, key generation, constant-time compare |
| `repositories/user.repository.ts` | Database access for users |
| `repositories/project.repository.ts` | Database access for projects, always scoped by owner |
| `repositories/api-key.repository.ts` | Database access for keys, filtering revoked ones |
| `services/auth.service.ts` | Register and login, including the timing defence |
| `services/project.service.ts` | Projects and keys, with the single ownership funnel |
| `middleware/authenticate.ts` | `requireUser` (JWT) and `requireApiKey` |
| `validators/auth.schema.ts` | Email and password rules |
| `validators/project.schema.ts` | Names and UUID parameters |
| `routes/v1/auth.routes.ts` | `/register`, `/login` |
| `routes/v1/project.routes.ts` | Projects and API keys |
| `routes/v1/index.ts` | Groups everything under `/api/v1` |
| `types/fastify.d.ts` | Teaches TypeScript what an authenticated request carries |

## A note on `types/fastify.d.ts`

Our middleware attaches `request.apiKey`. Fastify has no idea that exists, so TypeScript would reject reading it.

**Declaration merging** lets us extend a type from another library:

```ts
declare module "fastify" {
  interface FastifyRequest {
    apiKey?: { id: string; projectId: string; project: Project };
  }
}
```

It's marked **optional** (`?`) on purpose. Most routes use a JWT, not an API key, so a handler must check before using it. The type system now enforces that no endpoint assumes a credential it never required.

---

# Part 13 — The endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/auth/register` | — | Create an account |
| `POST` | `/api/v1/auth/login` | — | Get a token |
| `POST` | `/api/v1/projects` | JWT | Create a project |
| `GET` | `/api/v1/projects` | JWT | List **your** projects |
| `GET` | `/api/v1/projects/:projectId` | JWT | One project |
| `POST` | `/api/v1/projects/:projectId/api-keys` | JWT | Mint a key |
| `GET` | `/api/v1/projects/:projectId/api-keys` | JWT | List keys (no secrets) |
| `DELETE` | `/api/v1/projects/:projectId/api-keys/:keyId` | JWT | Revoke a key |

## Try it yourself

With the server running (`npm run dev`, port 3100):

```bash
curl -s -X POST http://localhost:3100/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"correct-horse-battery"}'
```

```json
{
  "success": true,
  "data": {
    "user": { "id": "74b6...", "email": "you@example.com", "createdAt": "..." },
    "token": "eyJhbGciOiJIUzI1NiIs..."
  },
  "error": null,
  "timestamp": "2026-08-08T17:35:28.891Z"
}
```

Note what is **absent**: no `passwordHash`, no trace of the password. That's tested for explicitly.

Then, with `TOKEN` set to that value:

```bash
curl -s -X POST http://localhost:3100/api/v1/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"My Project"}'
```

And minting a key returns, once only:

```json
{
  "id": "a800...",
  "name": "production",
  "prefix": "rlk_live_oLeRp4",
  "plaintext": "rlk_live_oLeRp4Crms...",
  "warning": "Store this key now. It cannot be retrieved again."
}
```

List the keys afterwards and `plaintext` is gone — only `prefix` remains.

---

# Part 14 — The tests

24 tests, run with `npm test`. They use `app.inject()`, which pushes a request through the **entire** stack — hooks, validation, error handler — without binding a network port. Fast, and genuinely end-to-end.

## What they prove

**Registration**
- Creates a user and returns a token
- The password hash never appears in the response *(checked against the raw response text, so a leak can't hide in a nested field)*
- Email is lowercased
- Duplicate email → 409
- Short password → 400
- Malformed email → 400

**Login**
- Correct credentials → token
- Wrong password → 401
- **Unknown email and wrong password return identical responses** — the enumeration defence

**Authentication required**
- No token → 401
- Garbage token → 401

**Tenancy isolation** *(the ones that matter most)*
- Bob's project list doesn't contain Ada's projects
- Bob requesting Ada's project gets **404, not 403**
- Bob cannot mint a key inside Ada's project

**API keys**
- Plaintext returned once, absent from later listings
- What's stored is a 64-character hash, not the key
- Revoking sets `revokedAt`

**Rate limiting**
- Repeated logins get throttled
- Even a `429` uses the standard response envelope

## Why tenancy gets the most attention

A bug in registration is loud — it throws, users complain, you fix it.

A bug in tenancy is **silent**. Everything returns 200. Nobody notices until a customer sees someone else's data and you have a disclosure incident. Silent failures need tests precisely because nothing else will catch them.

---

# Part 15 — The rate limit discovery

Worth recording, because the *reasoning* about the fix matters more than the fix.

## What happened

First run of the new tests: **6 of 22 failed**. The error:

```
TypeError: Cannot read properties of null (reading 'token')
```

Registration was returning `null` where a token should be.

## The cause

Not a bug. The **rate limiter working correctly**.

Auth endpoints allow 10 requests/minute. The test suite fired well past that in a couple of seconds, and every later registration got `429 Too Many Requests`. The tests that happened to run first passed; the rest didn't.

## Why the obvious fixes were wrong

**Raise the limit?** That weakens real protection to suit a test. Backwards.

**Add delays between tests?** Turns a one-second suite into a several-minute one. Slow tests get skipped, and skipped tests protect nothing.

**Give each test a different fake IP?** Works, but couples every test to a rate-limiting detail that has nothing to do with what it's checking.

## What we did

Rate limiting is now **off by default when `NODE_ENV=test`**, and `buildApp()` takes an option to switch it back on. A dedicated suite builds an app with `{ rateLimit: true }` and verifies throttling explicitly.

Two properties fall out:

- Other suites are **deterministic** — results don't depend on execution order
- Rate limiting stays **covered**, not quietly disabled

That second point is the important one. It's easy to turn something off for tests and slowly forget it exists. Keeping a test that exercises it deliberately means it can't rot unnoticed.

---

# Part 16 — Where we are

## Verified

| Check | Result |
|---|---|
| `npm run typecheck` | Clean |
| `npm run lint` | Clean |
| `npm test` | 24 passing |
| Manual flow | register → project → key → list → 401 without token |

## What's still missing

`requireApiKey` is written and tested at the unit level, but **nothing uses it yet** — there's no ingest endpoint for it to guard. That's M2's first job.

## Next: M2 — Webhooks & event ingest

- Webhook CRUD, each endpoint getting a generated signing secret
- `POST /api/v1/events` — the hot path, authenticated by **API key**, not JWT
- **Fan-out in a single transaction**: one `Event` row plus one `Delivery` row per active webhook, all-or-nothing so a crash can't leave an event with half its deliveries
- Returns `202 Accepted` — meaning *durably stored*, not *delivered*

That last point is where the architecture becomes visible. The API server makes **no outbound HTTP call at all**. It writes to Postgres and returns in single-digit milliseconds. Everything about actually sending the webhook happens later, in M3 and M4.

---

# Appendix — New terms from this milestone

| Term | Meaning |
|---|---|
| **Account enumeration** | Discovering which emails have accounts, via timing or differing responses |
| **Argon2id** | The recommended password hash; deliberately slow and memory-hungry |
| **Authentication** | Proving who you are |
| **Authorisation** | Checking what you're allowed to do |
| **Claim** | One field inside a JWT payload, e.g. `sub` |
| **Constant-time comparison** | Comparing secrets in the same time regardless of result |
| **Credential stuffing** | Replaying passwords leaked from other breaches |
| **Declaration merging** | Extending a TypeScript type defined in another library |
| **Entropy** | How genuinely unpredictable a secret is |
| **Hook / middleware** | Code running before a handler, able to stop the request |
| **JWT** | A signed token carrying its own claims; needs no server-side storage |
| **Multi-tenancy** | Many customers sharing one system and database |
| **Rainbow table** | Precomputed hashes of common passwords; defeated by salting |
| **Resource enumeration** | Discovering which IDs exist by probing responses |
| **Salt** | Random data mixed into a hash so identical inputs hash differently |
| **Side-channel attack** | Learning secrets from timing or power rather than breaking the maths |
| **Stateless** | Storing nothing between requests, so any server can handle any request |
| **Timing attack** | Deducing secrets from how long an operation takes |
