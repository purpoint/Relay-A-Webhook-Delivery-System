#!/usr/bin/env node
/**
 * The demonstration the whole project exists for.
 *
 * Publishes a large backlog at an endpoint that is deliberately failing, then
 * samples Postgres and Redis while the scheduler and workers run. The claim
 * under test is one number:
 *
 *   Postgres holds every delivery. Redis never exceeds EXECUTION_WINDOW_SIZE.
 *
 * Run everything in separate shells:
 *
 *   node scripts/receiver.mjs
 *   npm run dev
 *   npm run dev:scheduler
 *   npm run dev:worker
 *   node scripts/load-test.mjs --events 50000
 *
 * Then, once the backlog has built:
 *
 *   echo ok > /tmp/relay-receiver-mode
 *
 * and watch it drain without anything being restarted.
 */
import { execSync } from "node:child_process";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const EVENTS = Number(args.get("events") ?? 50_000);
const BATCH = Number(args.get("batch") ?? 250);
const SAMPLES = Number(args.get("samples") ?? 40);
const INTERVAL_MS = Number(args.get("interval") ?? 2000);
const API = args.get("api") ?? `http://localhost:${process.env.PORT ?? 3100}`;
const WINDOW = Number(process.env.EXECUTION_WINDOW_SIZE ?? 5000);
const RECEIVER = args.get("receiver") ?? "http://127.0.0.1:4000/hook";

const sh = (c) => execSync(c, { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = "GET", token, apiKey, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok && res.status !== 202) {
    throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  }
  return json.data;
}

async function setUp() {
  const email = `load-${Date.now()}@relay.test`;

  const { token } = await api("/api/v1/auth/register", {
    method: "POST",
    body: { email, password: "correct-horse-battery-staple" },
  });

  const project = await api("/api/v1/projects", {
    method: "POST",
    token,
    body: { name: "Load test" },
  });

  const key = await api(`/api/v1/projects/${project.id}/api-keys`, {
    method: "POST",
    token,
    body: { name: "load" },
  });

  await api(`/api/v1/projects/${project.id}/webhooks`, {
    method: "POST",
    token,
    body: { url: RECEIVER },
  });

  return { token, projectId: project.id, apiKey: key.plaintext };
}

async function publish(apiKey) {
  console.log(`Publishing ${EVENTS.toLocaleString()} events...`);
  const startedAt = Date.now();
  let accepted = 0;
  let rejected = 0;

  for (let sent = 0; sent < EVENTS; sent += BATCH) {
    const size = Math.min(BATCH, EVENTS - sent);

    const responses = await Promise.all(
      Array.from({ length: size }, (_, i) =>
        fetch(`${API}/api/v1/events`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": apiKey },
          body: JSON.stringify({
            eventType: "load.test",
            payload: { index: sent + i, at: Date.now() },
          }),
        }),
      ),
    );

    for (const res of responses) res.status === 202 ? accepted++ : rejected++;

    if ((sent / BATCH) % 20 === 0) {
      process.stdout.write(`  ${accepted.toLocaleString()} accepted\r`);
    }
  }

  const seconds = (Date.now() - startedAt) / 1000;
  console.log(
    `  ${accepted.toLocaleString()} accepted, ${rejected.toLocaleString()} rejected ` +
      `in ${seconds.toFixed(1)}s (${Math.round(accepted / seconds).toLocaleString()}/s)\n`,
  );

  if (rejected > 0) {
    console.log(
      `  note: rejections are the ingest rate limit (INGEST_RATE_LIMIT_MAX).\n`,
    );
  }

  return accepted;
}

function sample() {
  const ready = Number(sh("redis-cli LLEN relay:window"));
  const inFlight = Number(sh("redis-cli LLEN relay:inflight"));

  const row = sh(
    `psql relay -tAF, -c "SELECT ` +
      `count(*) FILTER (WHERE status='PENDING'), ` +
      `count(*) FILTER (WHERE status='QUEUED'), ` +
      `count(*) FILTER (WHERE status='PROCESSING'), ` +
      `count(*) FILTER (WHERE status='WAITING'), ` +
      `count(*) FILTER (WHERE status='DELIVERED'), ` +
      `count(*) FILTER (WHERE status='FAILED'), ` +
      `count(*) FROM deliveries;"`,
  ).split(",");

  return {
    ready,
    inFlight,
    occupancy: ready + inFlight,
    pending: Number(row[0]),
    queued: Number(row[1]),
    processing: Number(row[2]),
    waiting: Number(row[3]),
    delivered: Number(row[4]),
    failed: Number(row[5]),
    total: Number(row[6]),
  };
}

async function monitor() {
  console.log(
    "elapsed |  postgres | redis  (ready+flight) | PENDING  WAITING   QUEUED DELIVERED  FAILED",
  );
  console.log("-".repeat(96));

  let peak = 0;
  let breached = false;
  const startedAt = Date.now();

  for (let i = 0; i < SAMPLES; i++) {
    const s = sample();
    peak = Math.max(peak, s.occupancy);
    if (s.occupancy > WINDOW) breached = true;

    const elapsed = `${((Date.now() - startedAt) / 1000).toFixed(0)}s`;

    console.log(
      `${elapsed.padEnd(7)} | ${String(s.total).padStart(9)} | ` +
        `${String(s.occupancy).padStart(5)} (${String(s.ready).padStart(5)}+${String(s.inFlight).padStart(3)}) | ` +
        `${String(s.pending).padStart(7)} ${String(s.waiting).padStart(8)} ${String(s.queued).padStart(8)} ` +
        `${String(s.delivered).padStart(9)} ${String(s.failed).padStart(7)}` +
        (s.occupancy > WINDOW ? "  <<< OVER CAP" : ""),
    );

    await sleep(INTERVAL_MS);
  }

  console.log("-".repeat(96));

  const final = sample();
  console.log(`\nWindow cap:            ${WINDOW.toLocaleString()}`);
  console.log(`Peak Redis occupancy:  ${peak.toLocaleString()}`);
  console.log(`Deliveries in Postgres: ${final.total.toLocaleString()}`);
  console.log(
    `\nQUEUED rows: ${final.queued}   Redis dedupe set: ${sh("redis-cli SCARD relay:enqueued")}`,
  );

  if (breached) {
    console.error(`\nFAILED — Redis exceeded the window cap of ${WINDOW}.`);
    process.exitCode = 1;
  } else {
    console.log(
      `\nPASSED — Postgres held ${final.total.toLocaleString()} deliveries; ` +
        `Redis never exceeded ${peak.toLocaleString()} of ${WINDOW.toLocaleString()}.`,
    );
  }
}

const { apiKey } = await setUp();
await publish(apiKey);
console.log("Now start the scheduler and workers if they are not already running.\n");
await monitor();
