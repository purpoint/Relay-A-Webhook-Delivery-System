import { createServer, type Server } from "node:http";

/**
 * A stand-in for a customer's webhook endpoint.
 *
 * Deliveries are tested against a real HTTP server rather than a mocked fetch,
 * because most of what can go wrong in delivery is not in our code: timeouts,
 * connection resets, redirects, unread response bodies. A mock would assert
 * that we call a function; this asserts that a real request goes out over a
 * socket and comes back.
 */

export interface ReceivedRequest {
  headers: Record<string, string | string[] | undefined>;
  body: string;
  receivedAt: number;
}

export type ReceiverBehaviour =
  | { kind: "ok"; status?: number }
  | { kind: "status"; status: number }
  /** Accepts the connection and never answers, to exercise the timeout. */
  | { kind: "hang" }
  /** Closes the socket mid-request, as a crashing server would. */
  | { kind: "reset" }
  | { kind: "redirect"; location: string };

export class TestReceiver {
  private server?: Server;
  private port = 0;
  readonly requests: ReceivedRequest[] = [];
  behaviour: ReceiverBehaviour = { kind: "ok" };

  async start(): Promise<number> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));

      req.on("end", () => {
        this.requests.push({
          headers: req.headers,
          body,
          receivedAt: Date.now(),
        });

        switch (this.behaviour.kind) {
          case "ok":
            res.writeHead(this.behaviour.status ?? 200).end("ok");
            return;

          case "status":
            res.writeHead(this.behaviour.status).end(`status ${this.behaviour.status}`);
            return;

          case "redirect":
            res.writeHead(302, { location: this.behaviour.location }).end();
            return;

          case "reset":
            req.socket.destroy();
            return;

          case "hang":
            // Deliberately no response. The worker's timeout must fire.
            return;
        }
      });
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(0, "127.0.0.1", resolve);
    });

    const address = this.server.address();
    this.port = typeof address === "object" && address ? address.port : 0;
    return this.port;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/hook`;
  }

  reset(): void {
    this.requests.length = 0;
    this.behaviour = { kind: "ok" };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    // closeAllConnections is required: a hanging request would otherwise keep
    // the server open and the test process alive.
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
