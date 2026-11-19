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
  it("reports minimal health without secrets", async () => {
    const response = await SELF.fetch("https://relay.test/healthz");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json<Record<string, unknown>>();
    // Public healthz must not expose TURN/JWT/namespace details.
    expect(body).toEqual({
      ok: true,
      service: "tokimeki-relay",
      protocolVersion: 1,
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain(MASTER_TOKEN);
    expect(text).not.toContain(SESSION_TOKEN);
    expect(text).not.toContain("test-coturn-secret");
    expect(text).not.toContain("test-turn-api-token");
  });

  it("reports authenticated ops details from /auth/whoami", async () => {
    const response = await SELF.fetch("https://relay.test/auth/whoami", {
      headers: { "x-tokimeki-token": MASTER_TOKEN },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json<Record<string, unknown>>();
    expect(body).toEqual({
      ok: true,
      service: "tokimeki-relay",
      protocolVersion: 1,
      authMode: "master",
      turn: { provider: "coturn", configured: true },
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain(MASTER_TOKEN);
    expect(text).not.toContain(SESSION_TOKEN);
    expect(text).not.toContain("test-coturn-secret");
    expect(text).not.toContain("test-turn-api-token");
    expect(text).not.toContain("turn:coturn.test.invalid");
  });

  it("rejects missing and wrong fallback tokens on /auth/whoami", async () => {
    const cases: Array<Record<string, string>> = [
      {},
      { "x-tokimeki-token": "wrong-master-token" },
      { "x-tokimeki-token": "" },
    ];
    for (const headers of cases) {
      const response = await SELF.fetch("https://relay.test/auth/whoami", { headers });
      expect(response.status).toBe(401);
      const body = await response.json<Record<string, unknown>>();
      expect(body).toMatchObject({ ok: false, error: "unauthorized" });
    }
  });

  it("fails closed on /auth/whoami when no master token is configured", async () => {
    const worker = (await import("../src/index")).default;
    const response = await worker.fetch(
      new Request("https://relay.test/auth/whoami", {
        headers: { "x-tokimeki-token": "any-token" },
      }),
      { ...env, TOKIMEKI_MASTER_TOKEN: undefined },
    );
    expect(response.status).toBe(401);
  });

  it("rejects non-GET /auth/whoami requests", async () => {
    const response = await SELF.fetch("https://relay.test/auth/whoami", {
      method: "POST",
      headers: { "x-tokimeki-token": MASTER_TOKEN },
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
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

  it("rejects an incorrect fallback token", async () => {
    const response = await SELF.fetch("https://relay.test/ws/session-1", {
      headers: {
        Upgrade: "websocket",
        "x-tokimeki-token": "wrong-master-token",
        "x-tokimeki-session": SESSION_TOKEN,
      },
    });
    expect(response.status).toBe(401);
  });

  it("rejects a fallback token that equals the session token", async () => {
    // Both headers carry the real master token: without the equality guard the
    // Worker would accept this as an authenticated host (101), so this asserts
    // the guard itself rather than master-token validation.
    const response = await SELF.fetch("https://relay.test/ws/equal-tokens", {
      headers: {
        Upgrade: "websocket",
        "x-tokimeki-token": MASTER_TOKEN,
        "x-tokimeki-session": MASTER_TOKEN,
      },
    });
    expect(response.status).toBe(401);
  });

  it("does not accept the renamed-away X-Tokimeki-Master header as a credential", async () => {
    // The old host header is not a credential: whoami sees no credential and
    // the session route treats the connection as a viewer.
    const whoami = await SELF.fetch("https://relay.test/auth/whoami", {
      headers: { "x-tokimeki-master": MASTER_TOKEN },
    });
    expect(whoami.status).toBe(401);

    const response = await SELF.fetch("https://relay.test/ws/old-header-viewer", {
      headers: {
        Upgrade: "websocket",
        "x-tokimeki-master": MASTER_TOKEN,
        "x-tokimeki-session": SESSION_TOKEN,
      },
    });
    expect(response.status).toBe(101);
    response.webSocket?.accept();
    response.webSocket?.close(1000, "test");
  });

  it("ignores Authorization when JWT mode is disabled", async () => {
    // JWT mode is off in this configuration: Authorization is neither parsed
    // nor treated as a host credential.
    const whoami = await SELF.fetch("https://relay.test/auth/whoami", {
      headers: { authorization: `Bearer ${MASTER_TOKEN}` },
    });
    expect(whoami.status).toBe(401);

    const worker = (await import("../src/index")).default;
    const forwarded = await worker.fetch(
      new Request("https://relay.test/ws/authz-forwarded", {
        headers: {
          Upgrade: "websocket",
          "x-tokimeki-session": SESSION_TOKEN,
          authorization: `Bearer ${MASTER_TOKEN}`,
        },
      }),
      env,
    );
    expect(forwarded.status).toBe(101);
    forwarded.webSocket?.accept();
    forwarded.webSocket?.close(1000, "test");
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

  it("rejects an invalid listener header value", async () => {
    const response = await SELF.fetch("https://relay.test/ws/listener-header", {
      headers: {
        Upgrade: "websocket",
        "x-tokimeki-session": SESSION_TOKEN,
        "x-tokimeki-listener": "yes",
      },
    });
    expect(response.status).toBe(400);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({ ok: false, error: "invalid_role" });
  });

  it("rejects hello.role listener without the listener header", async () => {
    const socket = await connectWorker("listener-role-worker", { token: SESSION_TOKEN });
    socket.send(helloFor("listener-role-worker", "listener", "listener-1"));
    const error = await socket.waitForType("error");
    expect(error.code).toBe("invalid_role");
    const closed = await socket.waitForClose();
    expect(closed.code).toBe(4003);
  });

  it("lets the master token win over the listener header", async () => {
    const sessionId = "listener-header-host";
    const socket = await connectWorker(sessionId, {
      hostToken: MASTER_TOKEN,
      token: SESSION_TOKEN,
      listener: true,
    });
    socket.send(helloFor(sessionId, "host", "host-1"));
    const welcome = await socket.waitForType("welcome");
    expect(welcome.hostOnline).toBe(true);
    socket.close();
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

  it("lets the fallback token host named and plain sessions (root takeover)", async () => {
    const named = await openHost("team-b.root-created");
    expect(named.controls.find((message) => message.type === "welcome")?.session).toBe(
      "team-b.root-created",
    );
    const plain = await openHost("plain-root-session");
    expect(plain.controls.find((message) => message.type === "welcome")?.session).toBe(
      "plain-root-session",
    );
    named.close();
    plain.close();
  });

  it("fails closed on an invalid namespace map while the fallback token still works", async () => {
    const worker = (await import("../src/index")).default;
    const invalidEnv = { ...env, TOKIMEKI_NAMESPACE_TOKENS: '{"team-a":"too-short"}' };
    const blocked = await worker.fetch(
      new Request("https://relay.test/ws/team-a.desk", {
        headers: {
          Upgrade: "websocket",
          "x-tokimeki-token": "test-namespace-token-team-a-0123456789",
          "x-tokimeki-session": SESSION_TOKEN,
        },
      }),
      invalidEnv,
    );
    expect(blocked.status).toBe(401);

    const root = await worker.fetch(
      new Request("https://relay.test/ws/root-still-works", {
        headers: {
          Upgrade: "websocket",
          "x-tokimeki-token": MASTER_TOKEN,
          "x-tokimeki-session": SESSION_TOKEN,
        },
      }),
      invalidEnv,
    );
    expect(root.status).toBe(101);
    root.webSocket?.accept();
    root.webSocket?.close(1000, "test");
  });

  it("compares a JWT-shaped token value as a fallback/namespace token when JWT is disabled", async () => {
    // JWT mode is off: a three-segment value is never sent to a JWKS and is
    // compared against the configured credentials (none match) -> 401.
    const response = await SELF.fetch("https://relay.test/ws/jwt-shape-disabled", {
      headers: {
        Upgrade: "websocket",
        "x-tokimeki-token":
          "eyJhbGciOiJFUzI1NiIsImtpZCI6ImtkMSJ9.eyJzdWIiOiJ1In0.AAAAAAAA",
        "x-tokimeki-session": SESSION_TOKEN,
      },
    });
    expect(response.status).toBe(401);
  });
});
