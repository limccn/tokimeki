import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";
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
    const headers = { "X-Tokimeki-Session": "s", "X-Tokimeki-Master": "m" };
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
