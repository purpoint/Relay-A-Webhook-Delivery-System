#!/usr/bin/env node
/**
 * A stand-in for a customer's webhook endpoint.
 *
 * Behaviour is read from a file on every request so it can be switched from
 * another shell while the load test runs — which is the point: the interesting
 * moment is a failing endpoint recovering, with nothing restarted.
 *
 *   node scripts/receiver.mjs
 *   echo ok   > /tmp/relay-receiver-mode     # start returning 200
 *   echo fail > /tmp/relay-receiver-mode     # back to 500
 *   echo hang > /tmp/relay-receiver-mode     # accept and never answer
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const PORT = Number(process.env.RECEIVER_PORT ?? 4000);
const MODE_FILE = process.env.RECEIVER_MODE_FILE ?? "/tmp/relay-receiver-mode";

if (!existsSync(MODE_FILE)) writeFileSync(MODE_FILE, "fail");

let delivered = 0;
let rejected = 0;
let hung = 0;

function mode() {
  try {
    return readFileSync(MODE_FILE, "utf8").trim();
  } catch {
    return "fail";
  }
}

createServer((req, res) => {
  req.resume();

  req.on("end", () => {
    switch (mode()) {
      case "ok":
        delivered += 1;
        res.writeHead(200, { "content-type": "text/plain" }).end("ok");
        return;

      case "hang":
        // Accept the connection and never answer, to exercise the worker's
        // request timeout.
        hung += 1;
        return;

      default:
        rejected += 1;
        res.writeHead(500, { "content-type": "text/plain" }).end("unavailable");
    }
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`receiver listening on http://127.0.0.1:${PORT}  mode=${mode()}`);
  console.log(`switch with:  echo ok > ${MODE_FILE}`);
});

setInterval(() => {
  console.log(
    `[receiver] mode=${mode()} delivered=${delivered} rejected=${rejected} hung=${hung}`,
  );
}, 5000).unref();
