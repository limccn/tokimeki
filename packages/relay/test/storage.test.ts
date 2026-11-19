import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { ensureRelaySchema, insertSessionMetadata, loadSessionMetadata } from "../src/storage.js";

describe("session_meta namespace migration", () => {
  it("adds namespace_id to a pre-namespace table and keeps legacy rows null", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName("storage-migration"));
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      // Old table shape, created before namespace support.
      sql.exec(
        `CREATE TABLE session_meta (
           session_id TEXT PRIMARY KEY,
           created_at INTEGER NOT NULL,
           last_activity_at INTEGER NOT NULL,
           host_token_hash TEXT NOT NULL,
           session_ttl_seconds INTEGER NOT NULL,
           max_clients INTEGER NOT NULL,
           host_offline_deadline INTEGER
         )`,
      );
      sql.exec(
        `INSERT INTO session_meta
           (session_id, created_at, last_activity_at, host_token_hash,
            session_ttl_seconds, max_clients, host_offline_deadline)
         VALUES ('legacy-session', 1, 2, 'hash', 30, 3, NULL)`,
      );

      ensureRelaySchema(sql);
      // The additive ALTER must be idempotent across repeated calls.
      ensureRelaySchema(sql);

      const meta = loadSessionMetadata(sql);
      const columnValues = sql
        .exec<{ namespace_id: string | null }>("SELECT namespace_id FROM session_meta LIMIT 1")
        .toArray();
      const row = columnValues[0];
      return {
        meta,
        namespaceColumn: row === undefined ? "no-row" : row.namespace_id,
      };
    });

    expect(result.namespaceColumn).toBeNull();
    expect(result.meta).toMatchObject({
      sessionId: "legacy-session",
      hostTokenHash: "hash",
      namespaceId: null,
    });
  });

  it("falls back to the legacy column list before the migration runs", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName("storage-legacy-fallback"));
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      // Old table shape and no `ensureRelaySchema` call: the DO woke on an old
      // database before its next host hello migrated it.
      sql.exec(
        `CREATE TABLE session_meta (
           session_id TEXT PRIMARY KEY,
           created_at INTEGER NOT NULL,
           last_activity_at INTEGER NOT NULL,
           host_token_hash TEXT NOT NULL,
           session_ttl_seconds INTEGER NOT NULL,
           max_clients INTEGER NOT NULL,
           host_offline_deadline INTEGER
         )`,
      );
      sql.exec(
        `INSERT INTO session_meta
           (session_id, created_at, last_activity_at, host_token_hash,
            session_ttl_seconds, max_clients, host_offline_deadline)
         VALUES ('legacy-fallback', 1, 2, 'hash', 30, 3, NULL)`,
      );
      return loadSessionMetadata(sql);
    });

    expect(result).toMatchObject({
      sessionId: "legacy-fallback",
      hostTokenHash: "hash",
      namespaceId: null,
    });
  });

  it("round-trips a namespace id through insert and load", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName("storage-roundtrip"));
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      ensureRelaySchema(sql);
      insertSessionMetadata(sql, {
        sessionId: "team-a.desk",
        createdAt: 10,
        lastActivityAt: 20,
        hostTokenHash: "hash",
        sessionTtlSeconds: 30,
        maxClients: 4,
        hostOfflineDeadline: null,
        namespaceId: "team-a",
      });
      return loadSessionMetadata(sql);
    });
    expect(result?.namespaceId).toBe("team-a");
    expect(result?.sessionId).toBe("team-a.desk");
  });
});
