import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../src/crypto-utils.js";
import {
  connectWorker,
  helloFor,
  MASTER_TOKEN,
  SESSION_TOKEN,
  TEAM_A_TOKEN,
} from "./helpers";

/**
 * Namespace-mode SessionDO interaction tests (namespace tokens bound, no JWT).
 */
describe("namespace sessions", () => {
  it("records the namespace of a namespace-hosted session", async () => {
    const sessionId = "team-a.namespace-meta";
    const host = await connectWorker(sessionId, {
      hostToken: TEAM_A_TOKEN,
      token: SESSION_TOKEN,
    });
    host.send(helloFor(sessionId, "host", "host-1"));
    await host.waitForType("welcome");

    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
    const meta = await runInDurableObject(stub, async (_instance, state) => {
      return state.storage.sql
        .exec<{ namespace_id: string | null }>("SELECT namespace_id FROM session_meta LIMIT 1")
        .toArray();
    });
    expect(meta[0]?.namespace_id).toBe("team-a");
    host.close();
  });

  it("does not let a namespace token claim a legacy (null namespace) session", async () => {
    const sessionId = "team-a.legacy-row";
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
    const tokenHash = await sha256Hex(SESSION_TOKEN);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(
        `CREATE TABLE session_meta (
           session_id TEXT PRIMARY KEY,
           created_at INTEGER NOT NULL,
           last_activity_at INTEGER NOT NULL,
           host_token_hash TEXT NOT NULL,
           session_ttl_seconds INTEGER NOT NULL,
           max_clients INTEGER NOT NULL,
           host_offline_deadline INTEGER,
           namespace_id TEXT
         )`,
      );
      sql.exec(
        `INSERT INTO session_meta
           (session_id, created_at, last_activity_at, host_token_hash,
            session_ttl_seconds, max_clients, host_offline_deadline, namespace_id)
         VALUES (?, 1, 2, ?, 30, 3, NULL, NULL)`,
        sessionId,
        tokenHash,
      );
    });

    const claimed = await connectWorker(sessionId, {
      hostToken: TEAM_A_TOKEN,
      token: SESSION_TOKEN,
    });
    claimed.send(helloFor(sessionId, "host", "host-1"));
    const error = await claimed.waitForType("error");
    expect(error.code).toBe("invalid_session");
    const closed = await claimed.waitForClose();
    expect(closed.code).toBe(4001);

    // The fallback credential is disabled while namespace tokens are active,
    // so a legacy row cannot be claimed by the master token either (the Worker
    // rejects it before the DO is reached).
    await expect(
      connectWorker(sessionId, {
        hostToken: MASTER_TOKEN,
        token: SESSION_TOKEN,
      }),
    ).rejects.toThrow("expected websocket 101, got 401");
  });

  it("rejects viewers when a session's prefix does not match its stored namespace", async () => {
    const sessionId = "team-a.viewer-guard";
    const host = await connectWorker(sessionId, {
      hostToken: TEAM_A_TOKEN,
      token: SESSION_TOKEN,
    });
    host.send(helloFor(sessionId, "host", "host-1"));
    await host.waitForType("welcome");

    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
    await runInDurableObject(stub, async (_instance, state) => {
      // Simulate inconsistent persisted metadata; the DO must refuse routing.
      state.storage.sql.exec("UPDATE session_meta SET namespace_id = 'team-b'");
    });

    const viewer = await connectWorker(sessionId, { token: SESSION_TOKEN });
    viewer.send(helloFor(sessionId, "viewer", "viewer-1"));
    const error = await viewer.waitForType("error");
    expect(error.code).toBe("invalid_session");
    const closed = await viewer.waitForClose();
    expect(closed.code).toBe(4001);

    host.close();
    viewer.close();
  });
});
