import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  connectDirect,
  connectWorker,
  helloFor,
  MASTER_TOKEN,
  openHost,
  openListener,
  openViewer,
  SESSION_TOKEN,
  sleep,
  TEAM_A_TOKEN,
  TEAM_B_TOKEN,
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
      headers: { "x-tokimeki-master": MASTER_TOKEN },
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

  it("rejects missing and wrong master tokens on /auth/whoami", async () => {
    const cases: Array<Record<string, string>> = [
      {},
      { "x-tokimeki-master": "wrong-master-token" },
      { "x-tokimeki-master": "" },
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
        headers: { "x-tokimeki-master": "any-token" },
      }),
      { ...env, TOKIMEKI_MASTER_TOKEN: undefined },
    );
    expect(response.status).toBe(401);
  });

  it("rejects non-GET /auth/whoami requests", async () => {
    const response = await SELF.fetch("https://relay.test/auth/whoami", {
      method: "POST",
      headers: { "x-tokimeki-master": MASTER_TOKEN },
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
      master: MASTER_TOKEN,
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
});

describe("namespace host authentication", () => {
  it("admits a namespace token only for its own <namespace>.<slug> session", async () => {
    const sessionId = "team-a.desk";
    const host = await connectWorker(sessionId, {
      master: TEAM_A_TOKEN,
      token: SESSION_TOKEN,
    });
    host.send(helloFor(sessionId, "host", "host-1"));
    const welcome = await host.waitForType("welcome");
    expect(welcome.session).toBe(sessionId);
    expect(welcome.hostOnline).toBe(true);
    host.close();
  });

  it("rejects a namespace token without the matching session prefix", async () => {
    for (const sessionId of ["desk", "team-b.desk", "team-a", "team-a.", "team-ab.desk"]) {
      const response = await SELF.fetch(`https://relay.test/ws/${sessionId}`, {
        headers: {
          Upgrade: "websocket",
          "x-tokimeki-master": TEAM_A_TOKEN,
          "x-tokimeki-session": SESSION_TOKEN,
        },
      });
      expect(response.status).toBe(401);
      const body = await response.json<Record<string, unknown>>();
      expect(body).toMatchObject({ ok: false, error: "unauthorized" });
    }
  });

  it("lets the root master host named and plain sessions", async () => {
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

  it("rejects a namespace token that equals the session token", async () => {
    const response = await SELF.fetch("https://relay.test/ws/team-a.equal", {
      headers: {
        Upgrade: "websocket",
        "x-tokimeki-master": TEAM_A_TOKEN,
        "x-tokimeki-session": TEAM_A_TOKEN,
      },
    });
    expect(response.status).toBe(401);
  });

  it("fails closed on an invalid namespace map while the root master still works", async () => {
    const worker = (await import("../src/index")).default;
    const invalidEnv = { ...env, TOKIMEKI_NAMESPACE_TOKENS: '{"team-a":"too-short"}' };
    const blocked = await worker.fetch(
      new Request("https://relay.test/ws/team-a.desk", {
        headers: {
          Upgrade: "websocket",
          "x-tokimeki-master": TEAM_A_TOKEN,
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
          "x-tokimeki-master": MASTER_TOKEN,
          "x-tokimeki-session": SESSION_TOKEN,
        },
      }),
      invalidEnv,
    );
    expect(root.status).toBe(101);
    root.webSocket?.accept();
    root.webSocket?.close(1000, "test");
  });

  it("ignores and strips a client-supplied namespace header", async () => {
    const sessionId = "team-a.forged";
    const host = await connectWorker(sessionId, {
      master: TEAM_A_TOKEN,
      token: SESSION_TOKEN,
      // A team-a host must not be able to claim team-b (or a client-chosen ns).
      namespaceHeader: "team-b",
    });
    host.send(helloFor(sessionId, "host", "host-1"));
    await host.waitForType("welcome");

    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
    const stored = await runInDurableObject(stub, async (_instance, state) => {
      return state.storage.sql
        .exec<{ namespace_id: string | null }>("SELECT namespace_id FROM session_meta LIMIT 1")
        .toArray();
    });
    expect(stored[0]?.namespace_id).toBe("team-a");
    host.close();
  });

  it("lets viewers and listeners attach to a namespace session with the session token", async () => {
    const sessionId = "team-a.with-viewers";
    const host = await connectWorker(sessionId, {
      master: TEAM_A_TOKEN,
      token: SESSION_TOKEN,
    });
    host.send(helloFor(sessionId, "host", "host-1"));
    await host.waitForType("welcome");

    const viewer = await openViewer(sessionId, "viewer-1");
    expect(viewer.controls.find((message) => message.type === "welcome")?.session).toBe(sessionId);

    const listener = await openListener(sessionId, "listener-1");
    expect(listener.controls.find((message) => message.type === "welcome")?.session).toBe(
      sessionId,
    );

    host.close();
    viewer.close();
    listener.close();
  });

  it("lets a namespace host reconnect to the session it created", async () => {
    const sessionId = "team-a.reconnect";
    const first = await connectWorker(sessionId, {
      master: TEAM_A_TOKEN,
      token: SESSION_TOKEN,
    });
    first.send(helloFor(sessionId, "host", "host-1"));
    await first.waitForType("welcome");
    first.close();
    await sleep(100);

    const second = await connectWorker(sessionId, {
      master: TEAM_A_TOKEN,
      token: SESSION_TOKEN,
    });
    // Same client id exercises the stale-socket replacement path too.
    second.send(helloFor(sessionId, "host", "host-1"));
    const welcome = await second.waitForType("welcome");
    expect(welcome.hostOnline).toBe(true);
    second.close();
  });

  it("keeps the same slug in two namespaces independent", async () => {
    const a = await connectWorker("team-a.shared", {
      master: TEAM_A_TOKEN,
      token: SESSION_TOKEN,
    });
    a.send(helloFor("team-a.shared", "host", "host-1"));
    const aWelcome = await a.waitForType("welcome");

    const b = await connectWorker("team-b.shared", {
      master: TEAM_B_TOKEN,
      token: SESSION_TOKEN,
    });
    b.send(helloFor("team-b.shared", "host", "host-1"));
    const bWelcome = await b.waitForType("welcome");

    expect(aWelcome.session).toBe("team-a.shared");
    expect(bWelcome.session).toBe("team-b.shared");
    a.close();
    b.close();
  });
});
