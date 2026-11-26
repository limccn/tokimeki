import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  connectWorker,
  helloFor,
  type JsonRecord,
  MASTER_TOKEN,
  openHost,
  SESSION_TOKEN,
  type TestSocket,
} from "./helpers";

/**
 * v1.7 R2: opaque viewer/listener token failure lockout and uniform
 * `unauthorized` semantics. Every test uses fake client IPs (the Worker trusts
 * `cf-connecting-ip`; a real deployment gets it from the Cloudflare edge).
 */

interface Rejection {
  readonly error: JsonRecord;
  readonly closeCode: number;
}

async function rejectViewer(
  sessionId: string,
  clientId: string,
  token: string,
  ip: string,
): Promise<Rejection> {
  const socket = await connectWorker(sessionId, {
    token,
    headers: { "cf-connecting-ip": ip },
  });
  socket.send(helloFor(sessionId, "viewer", clientId));
  const error = await socket.waitForType("error");
  const close = await socket.waitForClose();
  return { error, closeCode: close.code };
}

function rejectionShape(rejection: Rejection): string {
  return JSON.stringify({
    code: rejection.error.code,
    message: rejection.error.message,
    closeCode: rejection.closeCode,
  });
}

async function openViewerAt(
  sessionId: string,
  clientId: string,
  token: string,
  ip: string,
): Promise<TestSocket> {
  const socket = await connectWorker(sessionId, {
    token,
    headers: { "cf-connecting-ip": ip },
  });
  socket.send(helloFor(sessionId, "viewer", clientId));
  return socket;
}

async function readFailureRows(
  sessionId: string,
): Promise<Array<{ attempts: number; lockedUntil: number | null }>> {
  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
  return runInDurableObject(stub, (_instance, state) => {
    return state.storage.sql
      .exec<{ failed_attempts: number; locked_until: number | null }>(
        "SELECT failed_attempts, locked_until FROM session_auth_failures WHERE kind = 'opaque_token'",
      )
      .toArray()
      .map((row) => ({ attempts: row.failed_attempts, lockedUntil: row.locked_until }));
  });
}

async function listTables(sessionId: string): Promise<string[]> {
  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
  return runInDurableObject(stub, (_instance, state) => {
    return state.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((row) => row.name);
  });
}

describe("opaque session token failures", () => {
  it("returns the same unauthorized rejection for a nonexistent session and a wrong token", async () => {
    const ip = "198.51.100.40";
    const missing = await rejectViewer(
      "auth-oracle-missing",
      "viewer-missing",
      "opaque-token-x",
      ip,
    );

    const sessionId = "auth-oracle-existing";
    const host = await openHost(sessionId);
    const wrong = await rejectViewer(sessionId, "viewer-wrong", "opaque-token-x", ip);

    expect(rejectionShape(missing)).toBe(rejectionShape(wrong));
    expect(wrong.error.code).toBe("unauthorized");
    expect(wrong.closeCode).toBe(4001);
    host.close();
  });

  it("locks one IP after ten failures while another IP still connects", async () => {
    const sessionId = "auth-token-lock";
    const host = await openHost(sessionId);
    const ipA = "198.51.100.41";
    const ipB = "198.51.100.42";

    const shapes = new Set<string>();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const rejection = await rejectViewer(
        sessionId,
        `viewer-${attempt}`,
        "wrong-opaque-token",
        ipA,
      );
      shapes.add(rejectionShape(rejection));
    }
    // All ten failures (and the lock below) look byte-identical to a
    // nonexistent session / wrong token.
    expect(shapes.size).toBe(1);

    const locked = await rejectViewer(sessionId, "viewer-locked", SESSION_TOKEN, ipA);
    expect(rejectionShape(locked)).toBe([...shapes][0]);
    expect(locked.error.code).toBe("unauthorized");

    const rows = await readFailureRows(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attempts).toBe(10);
    expect(rows[0]?.lockedUntil).toBeGreaterThan(Date.now() - 1_000);

    // Another IP with the correct token is unaffected by the lock.
    const other = await openViewerAt(sessionId, "viewer-other", SESSION_TOKEN, ipB);
    const welcome = await other.waitForType("welcome");
    expect(welcome.session).toBe(sessionId);
    other.close();
    host.close();
  });

  it("clears the failure row after a successful token", async () => {
    const sessionId = "auth-token-clear";
    const host = await openHost(sessionId);
    const ip = "198.51.100.43";

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rejection = await rejectViewer(sessionId, `viewer-${attempt}`, "wrong-token", ip);
      expect(rejection.error.code).toBe("unauthorized");
    }
    expect(await readFailureRows(sessionId)).toEqual([expect.objectContaining({ attempts: 3 })]);

    const viewer = await openViewerAt(sessionId, "viewer-ok", SESSION_TOKEN, ip);
    await viewer.waitForType("welcome");
    expect(await readFailureRows(sessionId)).toHaveLength(0);
    viewer.close();
    host.close();
  });

  it("allows a retry after the lock window expires and restarts the count", async () => {
    const sessionId = "auth-token-lock-expiry";
    const host = await openHost(sessionId);
    const ip = "198.51.100.44";
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await rejectViewer(sessionId, `viewer-${attempt}`, "wrong-token", ip);
    }

    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE session_auth_failures SET locked_until = 0, window_started_at = ?",
        Date.now() - 120_000,
      );
    });

    const afterExpiry = await rejectViewer(sessionId, "viewer-after", "wrong-token", ip);
    expect(afterExpiry.error.code).toBe("unauthorized");
    expect(await readFailureRows(sessionId)).toEqual([expect.objectContaining({ attempts: 1 })]);

    const viewer = await openViewerAt(sessionId, "viewer-ok", SESSION_TOKEN, ip);
    await viewer.waitForType("welcome");
    viewer.close();
    host.close();
  });

  it("never creates schema for a nonexistent session", async () => {
    const sessionId = "auth-no-schema";
    const rejection = await rejectViewer(sessionId, "viewer-1", "wrong-token", "198.51.100.45");
    expect(rejection.error.code).toBe("unauthorized");
    const tables = await listTables(sessionId);
    expect(tables).not.toContain("session_meta");
    expect(tables).not.toContain("session_auth_failures");
  });

  it("treats 6/8/16/32-char and alphanumeric opaque tokens identically", async () => {
    const shapes = [
      "123456",
      "12345678",
      "1234abcd5678efgh",
      "0123456789abcdef0123456789abcdef",
      "a1b2c3d4e5f6",
    ];
    const ip = "198.51.100.46";

    for (const [index, token] of shapes.entries()) {
      const sessionId = `auth-token-shape-${index}`;

      // Nonexistent session: any non-empty opaque token is rejected uniformly.
      const missing = await rejectViewer(sessionId, "viewer-missing", token, "198.51.100.47");
      expect(missing.error.code).toBe("unauthorized");
      expect(missing.closeCode).toBe(4001);

      // Existing session created with the same token shape: no length or
      // charset gate — the host and viewer both authenticate.
      const host = await connectWorker(sessionId, {
        hostToken: MASTER_TOKEN,
        token,
        headers: { "cf-connecting-ip": ip },
      });
      host.send(helloFor(sessionId, "host", "host-1", { cols: 80, rows: 24 }));
      await host.waitForType("welcome");

      const viewer = await openViewerAt(sessionId, "viewer-1", token, ip);
      await viewer.waitForType("welcome");

      const wrong = await rejectViewer(sessionId, "viewer-wrong", `${token}wrong`, ip);
      expect(wrong.error.code).toBe("unauthorized");

      viewer.close();
      host.close();
    }
  });

  it("fails open for locking only when the failure store is unavailable", async () => {
    const sessionId = "auth-store-failure";
    const host = await openHost(sessionId);
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
    await runInDurableObject(stub, (_instance, state) => {
      // Keep the table/columns readable but make every counter write fail.
      state.storage.sql.exec("DROP TABLE session_auth_failures");
      state.storage.sql.exec(
        `CREATE TABLE session_auth_failures (
           session_id TEXT,
           kind TEXT,
           ip_hash TEXT,
           failed_attempts INTEGER NOT NULL CHECK (failed_attempts < 0),
           window_started_at INTEGER,
           locked_until INTEGER,
           updated_at INTEGER
         )`,
      );
    });

    const ip = "198.51.100.48";
    // A wrong token must still be rejected (only the lock is disabled).
    const wrong = await rejectViewer(sessionId, "viewer-wrong", "wrong-token", ip);
    expect(wrong.error.code).toBe("unauthorized");
    expect(wrong.closeCode).toBe(4001);

    // A correct token still connects even though counters cannot be written.
    const viewer = await openViewerAt(sessionId, "viewer-ok", SESSION_TOKEN, ip);
    await viewer.waitForType("welcome");
    viewer.close();
    host.close();
  });
});
