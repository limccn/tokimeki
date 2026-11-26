import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { Logger } from "../logger.js";
import { RelayClient, relayHandshakeHeaders } from "./relay-client.js";
import type { RelayFatalError } from "./relay-types.js";

describe("relayHandshakeHeaders", () => {
  it("marks listener connections with the internal listener header", () => {
    expect(relayHandshakeHeaders("listener", { "X-Tokimeki-Session": "s" })).toEqual({
      "X-Tokimeki-Session": "s",
      "X-Tokimeki-Listener": "1",
    });
  });

  it("leaves viewer and host headers untouched", () => {
    const headers = { "X-Tokimeki-Session": "s", "X-Tokimeki-Token": "t" };
    expect(relayHandshakeHeaders("viewer", headers)).toEqual(headers);
    expect(relayHandshakeHeaders("host", headers)).toEqual(headers);
  });
});

describe("RelayClient hello", () => {
  it("sends the optional client descriptor", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const helloReceived = new Promise<Record<string, unknown>>((resolve) => {
      server.on("connection", (socket) => {
        socket.once("message", (data) => {
          resolve(
            JSON.parse(Buffer.from(data as Buffer).toString("utf8")) as Record<string, unknown>,
          );
        });
      });
    });

    const logger = new Logger({ level: "silent", write: () => {} });
    const client = new RelayClient({
      url: `ws://127.0.0.1:${port}/ws/sess-1`,
      headers: { "X-Tokimeki-Session": "session-token" },
      role: "viewer",
      session: "sess-1",
      clientId: "viewer-1",
      heartbeatSeconds: 0,
      client: { name: "tokimeki-cli", version: "0.1.2", kind: "cli", platform: "linux" },
      capabilities: {},
      logger,
    });

    try {
      client.start();
      const hello = await helloReceived;
      expect(hello.client).toEqual({
        name: "tokimeki-cli",
        version: "0.1.2",
        kind: "cli",
        platform: "linux",
      });
    } finally {
      client.stop();
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("RelayClient listener compatibility", () => {
  it("fails with an actionable error when the relay rejects listener mode", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const { port } = server.address() as AddressInfo;

    server.on("connection", (socket) => {
      socket.once("message", () => {
        socket.send(
          JSON.stringify({
            v: 1,
            type: "error",
            code: "not_implemented",
            message: "feature is not implemented in protocol v1: listener role",
            retryable: false,
          }),
        );
        socket.close(4005, "not_implemented");
      });
    });

    const logger = new Logger({ level: "silent", write: () => {} });
    const client = new RelayClient({
      url: `ws://127.0.0.1:${port}/ws/sess-1`,
      headers: { "X-Tokimeki-Session": "session-token" },
      role: "listener",
      session: "sess-1",
      clientId: "listener-1",
      heartbeatSeconds: 0,
      capabilities: {},
      logger,
    });
    const fatal = new Promise<RelayFatalError>((resolve) => client.onFatal(resolve));

    try {
      client.start();
      const error = await fatal;
      expect(error.code).toBe("not_implemented");
      expect(error.message).toContain("--listen");
    } finally {
      client.stop();
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("RelayClient session passcode", () => {
  it("includes the host verifier in hello and accepts an advertised capability", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const helloReceived = new Promise<Record<string, unknown>>((resolve) => {
      server.on("connection", (socket) => {
        socket.once("message", (data) => {
          resolve(
            JSON.parse(Buffer.from(data as Buffer).toString("utf8")) as Record<string, unknown>,
          );
          socket.send(
            JSON.stringify({
              v: 1,
              type: "welcome",
              session: "sess-1",
              protocolVersion: 1,
              hostOnline: true,
              clients: [],
              iceServers: [],
              iceProvider: "stun",
              transportPolicy: "all",
              sessionTtlSeconds: 3600,
              capabilities: { sessionSecurity: { passcode: 1 } },
            }),
          );
        });
      });
    });

    const logger = new Logger({ level: "silent", write: () => {} });
    const client = new RelayClient({
      url: `ws://127.0.0.1:${port}/ws/sess-1`,
      headers: { "X-Tokimeki-Session": "session-token" },
      role: "host",
      session: "sess-1",
      clientId: "host-1",
      heartbeatSeconds: 0,
      capabilities: { sessionSecurity: { passcode: 1 } },
      passcodeVerifier: {
        v: 1,
        kdf: "pbkdf2-sha256",
        salt: "c2FsdHNhbHRzYWx0c2FsdA",
        iterations: 10_000,
        hash: "a".repeat(43),
      },
      requireSessionSecurityPasscode: true,
      logger,
    });

    try {
      client.start();
      const hello = await helloReceived;
      expect(hello.passcode).toEqual({
        v: 1,
        kdf: "pbkdf2-sha256",
        salt: "c2FsdHNhbHRzYWx0c2FsdA",
        iterations: 10_000,
        hash: "a".repeat(43),
      });
    } finally {
      client.stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails closed when the welcome does not advertise passcode support", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const { port } = server.address() as AddressInfo;
    server.on("connection", (socket) => {
      socket.once("message", () => {
        socket.send(
          JSON.stringify({
            v: 1,
            type: "welcome",
            session: "sess-1",
            protocolVersion: 1,
            hostOnline: true,
            clients: [],
            iceServers: [],
            iceProvider: "stun",
            transportPolicy: "all",
            sessionTtlSeconds: 3600,
          }),
        );
      });
    });

    const logger = new Logger({ level: "silent", write: () => {} });
    const client = new RelayClient({
      url: `ws://127.0.0.1:${port}/ws/sess-1`,
      headers: { "X-Tokimeki-Session": "session-token" },
      role: "host",
      session: "sess-1",
      clientId: "host-1",
      heartbeatSeconds: 0,
      capabilities: {},
      passcodeVerifier: {
        v: 1,
        kdf: "pbkdf2-sha256",
        salt: "c2FsdHNhbHRzYWx0c2FsdA",
        iterations: 10_000,
        hash: "a".repeat(43),
      },
      requireSessionSecurityPasscode: true,
      logger,
    });
    const fatal = new Promise<RelayFatalError>((resolve) => client.onFatal(resolve));

    try {
      client.start();
      const error = await fatal;
      expect(error.code).toBe("not_implemented");
      expect(error.message).toContain("session passcode");
    } finally {
      client.stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/** One scripted response per `/ws` upgrade; the last entry repeats. */
type UpgradeAction = "reject429" | "reject503" | "reject401" | "accept";

function welcomePayload(session: string): Record<string, unknown> {
  return {
    v: 1,
    type: "welcome",
    session,
    protocolVersion: 1,
    hostOnline: true,
    clients: [],
    iceServers: [],
    iceProvider: "stun",
    transportPolicy: "all",
    sessionTtlSeconds: 3600,
  };
}

/**
 * Minimal relay double for upgrade-status tests.
 *
 * 429/503/401 rejections are written as raw HTTP responses (the `ws` client
 * emits `unexpected-response`); `accept` completes a real WebSocket handshake
 * and immediately sends a welcome so the client reaches the ready state.
 */
class ScriptedRelay {
  readonly #script: UpgradeAction[];
  readonly #server: Server;
  readonly #wss: WebSocketServer;
  #index = 0;
  #arrivals: Array<() => void> = [];
  #lastSocket: import("ws").WebSocket | null = null;
  #port = 0;

  constructor(script: UpgradeAction[]) {
    this.#script = script;
    this.#server = createServer();
    this.#wss = new WebSocketServer({ noServer: true });
    this.#wss.on("connection", (ws) => {
      this.#lastSocket = ws;
      ws.send(JSON.stringify(welcomePayload("sess-1")));
    });
    this.#server.on("upgrade", (request, socket, head) => {
      this.#handleUpgrade(request, socket, head);
    });
    this.#server.on("clientError", (_error, socket) => socket.destroy());
  }

  get upgrades(): number {
    return this.#index;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.listen(0, "127.0.0.1", () => resolve());
    });
    this.#port = (this.#server.address() as AddressInfo).port;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.#port}/ws/sess-1`;
  }

  waitUpgrade(): Promise<void> {
    return new Promise((resolve) => this.#arrivals.push(resolve));
  }

  terminateClient(): void {
    this.#lastSocket?.terminate();
  }

  async close(): Promise<void> {
    for (const ws of this.#wss.clients) ws.terminate();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
  }

  #handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const action = this.#script[Math.min(this.#index, this.#script.length - 1)] ?? "reject429";
    this.#index += 1;
    for (const resolve of this.#arrivals.splice(0)) resolve();

    socket.on("error", () => {
      // The client may abort the upgrade; nothing to clean up here.
    });

    if (action === "accept") {
      this.#wss.handleUpgrade(request, socket, head, (ws) => {
        this.#wss.emit("connection", ws, request);
      });
      return;
    }
    const status = action === "reject429" ? 429 : action === "reject503" ? 503 : 401;
    const reason =
      action === "reject429"
        ? "Too Many Requests"
        : action === "reject503"
          ? "Service Unavailable"
          : "Unauthorized";
    const extra = action === "reject429" ? "Retry-After: 60\r\n" : "";
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`,
    );
    socket.destroy();
  }
}

function makeRateLimitClient(url: string): RelayClient {
  const logger = new Logger({ level: "silent", write: () => {} });
  return new RelayClient({
    url,
    headers: { "X-Tokimeki-Session": "session-token" },
    role: "viewer",
    session: "sess-1",
    clientId: "viewer-1",
    heartbeatSeconds: 0,
    capabilities: {},
    logger,
  });
}

/** Wait (on real macrotasks) until the client has scheduled its reconnect. */
async function waitForReconnectScheduled(client: RelayClient): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (client.state === "reconnecting") return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`client did not schedule a reconnect (state=${client.state})`);
}

/** Advance the fake reconnect timer to the next upgrade attempt. */
async function advanceToNextUpgrade(relay: ScriptedRelay, client: RelayClient): Promise<void> {
  await waitForReconnectScheduled(client);
  const next = relay.waitUpgrade();
  await vi.advanceTimersToNextTimerAsync();
  await next;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RelayClient HTTP 429 retry cap", () => {
  it("gives up with session_full after six consecutive 429 rejections", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const relay = new ScriptedRelay(["reject429"]);
    await relay.start();
    const client = makeRateLimitClient(relay.url);
    const fatal = new Promise<RelayFatalError>((resolve) => client.onFatal(resolve));
    try {
      const first = relay.waitUpgrade();
      client.start();
      await first;
      for (let attempt = 1; attempt < 6; attempt += 1) {
        await advanceToNextUpgrade(relay, client);
      }
      const error = await fatal;
      expect(error.code).toBe("session_full");
      expect(error.message).toContain("HTTP 429");
      expect(relay.upgrades).toBe(6);
      expect(client.state).toBe("failed");
      // The fatal path must not schedule another reconnect.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(relay.upgrades).toBe(6);
    } finally {
      client.stop();
      await relay.close();
    }
  });

  it("resets the streak on a non-429 response and still retries 503", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const relay = new ScriptedRelay([
      "reject429",
      "reject429",
      "reject429",
      "reject429",
      "reject429",
      "reject503",
      "reject429",
    ]);
    await relay.start();
    const client = makeRateLimitClient(relay.url);
    const fatal = new Promise<RelayFatalError>((resolve) => client.onFatal(resolve));
    try {
      const first = relay.waitUpgrade();
      client.start();
      await first;
      for (let attempt = 1; attempt < 5; attempt += 1) {
        await advanceToNextUpgrade(relay, client);
      }
      // Fifth consecutive 429: still retrying.
      expect(client.state).not.toBe("failed");
      // 503 breaks the streak (and is retried, as before).
      await advanceToNextUpgrade(relay, client);
      expect(client.state).not.toBe("failed");
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await advanceToNextUpgrade(relay, client);
      }
      // Five consecutive 429s after the reset: still not fatal.
      expect(client.state).not.toBe("failed");
      await advanceToNextUpgrade(relay, client);
      const error = await fatal;
      expect(error.code).toBe("session_full");
      expect(relay.upgrades).toBe(12);
    } finally {
      client.stop();
      await relay.close();
    }
  });

  it("resets the streak after a successful welcome", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const relay = new ScriptedRelay([
      "reject429",
      "reject429",
      "reject429",
      "reject429",
      "reject429",
      "accept",
      "reject429",
    ]);
    await relay.start();
    const client = makeRateLimitClient(relay.url);
    const fatal = new Promise<RelayFatalError>((resolve) => client.onFatal(resolve));
    try {
      const first = relay.waitUpgrade();
      client.start();
      await first;
      for (let attempt = 1; attempt < 5; attempt += 1) {
        await advanceToNextUpgrade(relay, client);
      }
      const welcomed = new Promise<void>((resolve) => client.onWelcome(() => resolve()));
      await advanceToNextUpgrade(relay, client);
      await welcomed;
      expect(client.isReady).toBe(true);

      // Drop the socket: the client reconnects with a fresh 429 count.
      relay.terminateClient();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await advanceToNextUpgrade(relay, client);
      }
      expect(client.state).not.toBe("failed");
      await advanceToNextUpgrade(relay, client);
      const error = await fatal;
      expect(error.code).toBe("session_full");
      expect(relay.upgrades).toBe(12);
    } finally {
      client.stop();
      await relay.close();
    }
  });

  it("keeps 401 fatal without retrying", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const relay = new ScriptedRelay(["reject401"]);
    await relay.start();
    const client = makeRateLimitClient(relay.url);
    const fatal = new Promise<RelayFatalError>((resolve) => client.onFatal(resolve));
    try {
      const first = relay.waitUpgrade();
      client.start();
      await first;
      const error = await fatal;
      expect(error.code).toBe("unauthorized");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(relay.upgrades).toBe(1);
      expect(client.state).toBe("failed");
    } finally {
      client.stop();
      await relay.close();
    }
  });
});
