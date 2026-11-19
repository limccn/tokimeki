import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  connectWorker,
  helloFor,
  MASTER_TOKEN,
  openListener,
  openViewer,
  SESSION_TOKEN,
  sleep,
  TEAM_A_TOKEN,
  TEAM_B_TOKEN,
} from "./helpers";

/**
 * Static namespace-token mode (no JWT bindings in this configuration).
 *
 * `TOKIMEKI_NAMESPACE_TOKENS` is bound, so the fallback master token is
 * disabled even when its value matches.
 */
describe("namespace host authentication", () => {
  it("admits a namespace token only for its own <namespace>.<slug> session", async () => {
    const sessionId = "team-a.desk";
    const host = await connectWorker(sessionId, {
      hostToken: TEAM_A_TOKEN,
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
          "x-tokimeki-token": TEAM_A_TOKEN,
          "x-tokimeki-session": SESSION_TOKEN,
        },
      });
      expect(response.status).toBe(401);
      const body = await response.json<Record<string, unknown>>();
      expect(body).toMatchObject({ ok: false, error: "unauthorized" });
    }
  });

  it("rejects a namespace token that equals the session token", async () => {
    const response = await SELF.fetch("https://relay.test/ws/team-a.equal", {
      headers: {
        Upgrade: "websocket",
        "x-tokimeki-token": TEAM_A_TOKEN,
        "x-tokimeki-session": TEAM_A_TOKEN,
      },
    });
    expect(response.status).toBe(401);
  });

  it("rejects the fallback token once namespace tokens are active (even when matching)", async () => {
    const whoami = await SELF.fetch("https://relay.test/auth/whoami", {
      headers: { "x-tokimeki-token": MASTER_TOKEN },
    });
    expect(whoami.status).toBe(401);

    const response = await SELF.fetch("https://relay.test/ws/fallback-disabled", {
      headers: {
        Upgrade: "websocket",
        "x-tokimeki-token": MASTER_TOKEN,
        "x-tokimeki-session": SESSION_TOKEN,
      },
    });
    expect(response.status).toBe(401);
  });

  it("reports authMode=namespace from /auth/whoami", async () => {
    const response = await SELF.fetch("https://relay.test/auth/whoami", {
      headers: { "x-tokimeki-token": TEAM_A_TOKEN },
    });
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      ok: true,
      service: "tokimeki-relay",
      protocolVersion: 1,
      authMode: "namespace",
      namespace: "team-a",
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain(TEAM_A_TOKEN);
    expect(text).not.toContain(MASTER_TOKEN);
    expect(text).not.toContain("sub");
    expect(text).not.toContain("tokenUse");
  });

  it("compares a JWT-shaped token value as a static token (401) when JWT mode is off", async () => {
    const response = await SELF.fetch("https://relay.test/ws/jwt-shape-namespace", {
      headers: {
        Upgrade: "websocket",
        "x-tokimeki-token":
          "eyJhbGciOiJFUzI1NiIsImtpZCI6ImtkMSJ9.eyJzdWIiOiJ1In0.AAAAAAAA",
        "x-tokimeki-session": SESSION_TOKEN,
      },
    });
    expect(response.status).toBe(401);
  });

  it("ignores Authorization when JWT mode is disabled", async () => {
    const response = await SELF.fetch("https://relay.test/auth/whoami", {
      headers: { authorization: `Bearer ${TEAM_A_TOKEN}` },
    });
    expect(response.status).toBe(401);
  });

  it("fails closed on an invalid namespace map", async () => {
    const worker = (await import("../src/index")).default;
    const invalidEnv = { ...env, TOKIMEKI_NAMESPACE_TOKENS: '{"team-a":"too-short"}' };
    const blocked = await worker.fetch(
      new Request("https://relay.test/ws/team-a.desk", {
        headers: {
          Upgrade: "websocket",
          "x-tokimeki-token": TEAM_A_TOKEN,
          "x-tokimeki-session": SESSION_TOKEN,
        },
      }),
      invalidEnv,
    );
    expect(blocked.status).toBe(401);
  });

  it("ignores and strips a client-supplied namespace header", async () => {
    const sessionId = "team-a.forged";
    const host = await connectWorker(sessionId, {
      hostToken: TEAM_A_TOKEN,
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
      hostToken: TEAM_A_TOKEN,
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
      hostToken: TEAM_A_TOKEN,
      token: SESSION_TOKEN,
    });
    first.send(helloFor(sessionId, "host", "host-1"));
    await first.waitForType("welcome");
    first.close();
    await sleep(100);

    const second = await connectWorker(sessionId, {
      hostToken: TEAM_A_TOKEN,
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
      hostToken: TEAM_A_TOKEN,
      token: SESSION_TOKEN,
    });
    a.send(helloFor("team-a.shared", "host", "host-1"));
    const aWelcome = await a.waitForType("welcome");

    const b = await connectWorker("team-b.shared", {
      hostToken: TEAM_B_TOKEN,
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
