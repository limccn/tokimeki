import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  AUTH_FAILURE_MAX_ROWS,
  cleanupAuthFailures,
  clearAuthFailure,
  ensureAuthFailureSchema,
  ensureRelaySchema,
  insertSessionMetadata,
  loadAuthFailure,
  loadSessionMetadata,
  recordAuthFailure,
  setAbsoluteDeadline,
  setRelayBytes,
} from "../src/storage.js";

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
        absoluteDeadline: 1_000,
        relayBytes: 42,
      });
      return loadSessionMetadata(sql);
    });
    expect(result?.namespaceId).toBe("team-a");
    expect(result?.sessionId).toBe("team-a.desk");
    expect(result?.absoluteDeadline).toBe(1_000);
    expect(result?.relayBytes).toBe(42);
  });

  it("adds quota columns to a namespaced table and defaults legacy values", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName("storage-quota-migration"));
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      // Table shape after the namespace migration but before quota support.
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
         VALUES ('team-a.legacy-quota', 1, 2, 'hash', 30, 3, NULL, 'team-a')`,
      );

      ensureRelaySchema(sql);
      ensureRelaySchema(sql);

      const meta = loadSessionMetadata(sql);
      const columns = sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('session_meta')")
        .toArray()
        .map((row) => row.name);
      return { meta, columns };
    });

    expect(result.columns).toEqual(
      expect.arrayContaining(["absolute_deadline", "relay_bytes", "namespace_id"]),
    );
    expect(result.meta).toMatchObject({
      sessionId: "team-a.legacy-quota",
      namespaceId: "team-a",
      absoluteDeadline: null,
      relayBytes: 0,
    });
  });

  it("loads a pre-quota table without running the migration", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName("storage-quota-fallback"));
    const result = await runInDurableObject(stub, async (_instance, state) => {
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
         VALUES ('pre-quota', 1, 2, 'hash', 30, 3, NULL, 'team-b')`,
      );
      return loadSessionMetadata(sql);
    });

    expect(result).toMatchObject({
      sessionId: "pre-quota",
      namespaceId: "team-b",
      absoluteDeadline: null,
      relayBytes: 0,
    });
  });

  it("updates the absolute deadline and relay byte total in place", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName("storage-quota-helpers"));
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      ensureRelaySchema(sql);
      insertSessionMetadata(sql, {
        sessionId: "helpers",
        createdAt: 10,
        lastActivityAt: 20,
        hostTokenHash: "hash",
        sessionTtlSeconds: 30,
        maxClients: 3,
        hostOfflineDeadline: null,
        namespaceId: null,
        absoluteDeadline: null,
        relayBytes: 0,
      });
      setAbsoluteDeadline(sql, 5_000);
      setRelayBytes(sql, 1_048_576);
      const updated = loadSessionMetadata(sql);
      setAbsoluteDeadline(sql, null);
      const cleared = loadSessionMetadata(sql);
      return { updated, cleared };
    });

    expect(result.updated?.absoluteDeadline).toBe(5_000);
    expect(result.updated?.relayBytes).toBe(1_048_576);
    expect(result.cleared?.absoluteDeadline).toBeNull();
  });
});

describe("session_auth_failures", () => {
  it("is created idempotently by both schema entry points", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName("auth-failure-schema"));
    const result = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      ensureAuthFailureSchema(sql);
      ensureAuthFailureSchema(sql);
      ensureRelaySchema(sql);
      ensureRelaySchema(sql);
      return sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_auth_failures'",
        )
        .toArray()
        .map((row) => row.name);
    });
    expect(result).toEqual(["session_auth_failures"]);
  });

  it("round-trips a per-IP counter and clears it", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName("auth-failure-roundtrip"));
    const result = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      ensureRelaySchema(sql);
      expect(loadAuthFailure(sql, "s", "opaque_token", "hash-a")).toBeNull();
      recordAuthFailure(sql, {
        sessionId: "s",
        kind: "opaque_token",
        ipHash: "hash-a",
        failedAttempts: 3,
        windowStartedAt: 1_000,
        lockedUntil: null,
        updatedAt: 1_500,
      });
      const loaded = loadAuthFailure(sql, "s", "opaque_token", "hash-a");
      // A different kind and a different IP are independent rows.
      expect(loadAuthFailure(sql, "s", "passcode", "hash-a")).toBeNull();
      expect(loadAuthFailure(sql, "s", "opaque_token", "hash-b")).toBeNull();
      clearAuthFailure(sql, "s", "opaque_token", "hash-a");
      const cleared = loadAuthFailure(sql, "s", "opaque_token", "hash-a");
      return { loaded, cleared };
    });

    expect(result.loaded).toEqual({
      failedAttempts: 3,
      windowStartedAt: 1_000,
      lockedUntil: null,
      updatedAt: 1_500,
    });
    expect(result.cleared).toBeNull();
  });

  it("prunes stale unlocked rows and caps rows per session/kind", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName("auth-failure-prune"));
    const result = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      ensureRelaySchema(sql);
      const now = 1_000_000;
      // One row that has been idle past the window and one active row.
      recordAuthFailure(sql, {
        sessionId: "s",
        kind: "opaque_token",
        ipHash: "stale",
        failedAttempts: 1,
        windowStartedAt: now - 500_000,
        lockedUntil: null,
        updatedAt: now - 500_000,
      });
      recordAuthFailure(sql, {
        sessionId: "s",
        kind: "opaque_token",
        ipHash: "active",
        failedAttempts: 1,
        windowStartedAt: now,
        lockedUntil: null,
        updatedAt: now,
      });
      // An active lock must survive the stale-row cleanup.
      recordAuthFailure(sql, {
        sessionId: "s",
        kind: "opaque_token",
        ipHash: "locked",
        failedAttempts: 10,
        windowStartedAt: now,
        lockedUntil: now + 60_000,
        updatedAt: now - 500_000,
      });
      cleanupAuthFailures(sql, "s", "opaque_token", now, 60_000);
      const afterStale = sql
        .exec<{ ip_hash: string }>(
          "SELECT ip_hash FROM session_auth_failures WHERE kind = 'opaque_token' ORDER BY ip_hash",
        )
        .toArray()
        .map((row) => row.ip_hash);

      // Cap: write more distinct IPs than the per-kind row limit.
      for (let index = 0; index <= AUTH_FAILURE_MAX_ROWS; index += 1) {
        recordAuthFailure(sql, {
          sessionId: "s",
          kind: "passcode",
          ipHash: `ip-${index}`,
          failedAttempts: 1,
          windowStartedAt: now,
          lockedUntil: null,
          updatedAt: now + index,
        });
      }
      cleanupAuthFailures(sql, "s", "passcode", now + 1_000, 60_000);
      const capped = sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM session_auth_failures WHERE kind = 'passcode'",
        )
        .toArray();
      return { afterStale, capped: capped[0]?.count ?? -1 };
    });

    expect(result.afterStale).toEqual(["active", "locked"]);
    expect(result.capped).toBe(AUTH_FAILURE_MAX_ROWS);
  });
});
