import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  connectDirect,
  connectWorker,
  helloFor,
  MASTER_TOKEN,
  openHost,
  SESSION_TOKEN,
  sleep,
} from "./helpers";

describe("relay worker", () => {
  it("reports health without secrets", async () => {
    const response = await SELF.fetch("https://relay.test/healthz");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      ok: true,
      service: "tokimeki-relay",
      protocolVersion: 1,
      turnProvider: "coturn",
      turnConfigured: true,
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain(MASTER_TOKEN);
    expect(text).not.toContain("test-coturn-secret");
    expect(text).not.toContain("test-turn-api-token");
  });

  it("rejects non-websocket requests to the session route", async () => {
    const response = await SELF.fetch("https://relay.test/ws/session-1");
    expect(response.status).toBe(426);
  });

  it("rejects malformed session ids", async () => {
    const response = await SELF.fetch("https://relay.test/ws/bad!id", {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(400);
  });

  it("rejects an incorrect master token", async () => {
    const response = await SELF.fetch("https://relay.test/ws/session-1", {
      headers: {
        Upgrade: "websocket",
        "x-tokimeki-master": "wrong-master-token",
        "x-tokimeki-session": SESSION_TOKEN,
      },
    });
    expect(response.status).toBe(401);
  });

  it("rejects a master token that equals the session token", async () => {
    // Both headers carry the real master token: without the equality guard the
    // Worker would accept this as an authenticated host (101), so this asserts
    // the guard itself rather than master-token validation.
    const response = await SELF.fetch("https://relay.test/ws/equal-tokens", {
      headers: {
        Upgrade: "websocket",
        "x-tokimeki-master": MASTER_TOKEN,
        "x-tokimeki-session": MASTER_TOKEN,
      },
    });
    expect(response.status).toBe(401);
  });

  it("does not let a viewer create a session", async () => {
    const socket = await connectWorker("viewer-create", { token: SESSION_TOKEN });
    socket.send(helloFor("viewer-create", "viewer", "viewer-1"));
    const error = await socket.waitForType("error");
    expect(error.code).toBe("invalid_session");
    const closed = await socket.waitForClose();
    expect(closed.code).toBe(4001);
  });

  it("rejects a missing session token", async () => {
    const response = await SELF.fetch("https://relay.test/ws/missing-token", {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(401);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({ ok: false, error: "unauthorized" });
  });

  it("rejects an empty session token", async () => {
    const response = await SELF.fetch("https://relay.test/ws/missing-token", {
      headers: { Upgrade: "websocket", "x-tokimeki-session": "" },
    });
    expect(response.status).toBe(401);
  });

  it("rejects a wrong session token for viewers", async () => {
    const host = await openHost("wrong-viewer-token");
    const viewer = await connectWorker("wrong-viewer-token", {
      token: "wrong-session-token",
    });
    viewer.send(helloFor("wrong-viewer-token", "viewer", "viewer-1"));
    const error = await viewer.waitForType("error");
    expect(error.code).toBe("unauthorized");
    const closed = await viewer.waitForClose();
    expect(closed.code).toBe(4001);
    host.close();
  });

  it("serves protocol version 1 after a master-authenticated host hello", async () => {
    const host = await openHost("worker-host");
    const welcome = host.controls.find((message) => message.type === "welcome");
    if (welcome === undefined) {
      throw new Error("expected a welcome message");
    }
    expect(welcome.protocolVersion).toBe(1);
    expect(welcome.hostOnline).toBe(true);
    host.close();
  });

  it("does not create relay tables for an anonymous pending socket", async () => {
    const sessionId = "no-schema-pending";
    const socket = await connectDirect(sessionId, { role: "viewer" });
    socket.close();
    await sleep(50);
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
    const tables = await runInDurableObject(stub, async (_instance, state) => {
      return state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((row) => row.name);
    });
    expect(tables).not.toContain("session_meta");
  });
});
