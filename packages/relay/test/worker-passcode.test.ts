import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  connectWorker,
  helloFor,
  MASTER_TOKEN,
  SESSION_TOKEN,
  sleep,
  type TestSocket,
} from "./helpers";

/**
 * Session passcode integration tests (v1.2-D, v1.7 R6).
 *
 * The host stores a PBKDF2 verifier in `hello.passcode`; viewers/listeners
 * submit the plaintext in `X-Tokimeki-Passcode`. v1.7 keeps a per-IP primary
 * lock (5 failures / 60 s -> 60 s) and a per-session high threshold (50 / 60 s
 * -> 60 s) as the distributed-guess backstop. The verifier/plaintext never
 * leaves this process; tests use fake client IPs.
 */

const PASSCODE = "123456";
const SALT_TEXT = "tokimeki-salt-16"; // exactly 16 bytes
const IP_A = "198.51.100.10";
const IP_B = "198.51.100.11";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makeVerifier(
  passcode = PASSCODE,
  iterations = 10_000,
): Promise<Record<string, unknown>> {
  const salt = new TextEncoder().encode(SALT_TEXT);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passcode),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return {
    v: 1,
    kdf: "pbkdf2-sha256",
    salt: base64Url(salt),
    iterations,
    hash: base64Url(new Uint8Array(bits)),
  };
}

async function openPasscodeHost(sessionId: string, passcode = PASSCODE): Promise<TestSocket> {
  const socket = await connectWorker(sessionId, {
    hostToken: MASTER_TOKEN,
    token: SESSION_TOKEN,
  });
  socket.send(
    helloFor(sessionId, "host", "host-1", {
      cols: 80,
      rows: 24,
      passcode: await makeVerifier(passcode),
    }),
  );
  await socket.waitForType("welcome");
  return socket;
}

async function openViewer(
  sessionId: string,
  clientId: string,
  passcode?: string,
  ip?: string,
): Promise<TestSocket> {
  const headers: Record<string, string> = {
    ...(ip === undefined ? {} : { "cf-connecting-ip": ip }),
    ...(passcode === undefined ? {} : { "x-tokimeki-passcode": passcode }),
  };
  const socket = await connectWorker(sessionId, {
    token: SESSION_TOKEN,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  });
  socket.send(helloFor(sessionId, "viewer", clientId));
  return socket;
}

async function readFailureState(
  sessionId: string,
): Promise<{ passcodeFailures: number; ipRows: number }> {
  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
  return runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    const passcodeRows = sql
      .exec<{ failed_attempts: number }>("SELECT failed_attempts FROM session_passcode LIMIT 1")
      .toArray();
    const ipRows = sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM session_auth_failures WHERE kind = 'passcode'",
      )
      .toArray();
    return {
      passcodeFailures: passcodeRows[0]?.failed_attempts ?? 0,
      ipRows: ipRows[0]?.count ?? 0,
    };
  });
}

describe("worker session passcode", () => {
  it("advertises passcode support in welcome and accepts the correct passcode", async () => {
    const host = await openPasscodeHost("passcode-ok");
    const viewer = await openViewer("passcode-ok", "viewer-1", PASSCODE);
    const welcome = await viewer.waitForType("welcome");
    expect(welcome.session).toBe("passcode-ok");
    expect((welcome.capabilities as Record<string, unknown>).sessionSecurity).toEqual({
      passcode: 1,
    });
    viewer.close();
    host.close();
  });

  it("requires the passcode when the host configured one", async () => {
    const host = await openPasscodeHost("passcode-required");
    const viewer = await openViewer("passcode-required", "viewer-1");
    const error = await viewer.waitForType("error");
    expect(error.code).toBe("passcode_required");
    await viewer.waitForClose();
    viewer.close();
    host.close();
  });

  it("locks only the failing IP after five failures and lets another IP in", async () => {
    const sessionId = "passcode-ip-lock";
    const host = await openPasscodeHost(sessionId);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const viewer = await openViewer(sessionId, `viewer-${attempt}`, "000000", IP_A);
      const error = await viewer.waitForType("error");
      expect(error.code).toBe("passcode_invalid");
      await viewer.waitForClose();
    }
    const fifth = await openViewer(sessionId, "viewer-5", "000000", IP_A);
    const lockError = await fifth.waitForType("error");
    expect(lockError.code).toBe("passcode_locked");
    await fifth.waitForClose();

    // The locked IP is rejected even with the correct passcode...
    const locked = await openViewer(sessionId, "viewer-6", PASSCODE, IP_A);
    const stillLocked = await locked.waitForType("error");
    expect(stillLocked.code).toBe("passcode_locked");
    await locked.waitForClose();

    // ...while another IP with the correct passcode still connects.
    const other = await openViewer(sessionId, "viewer-7", PASSCODE, IP_B);
    const welcome = await other.waitForType("welcome");
    expect(welcome.session).toBe(sessionId);
    other.close();
    host.close();
  });

  it("enforces the high per-session threshold across many IPs", async () => {
    const sessionId = "passcode-global-lock";
    const host = await openPasscodeHost(sessionId);
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE session_passcode SET failed_attempts = 49, updated_at = ?",
        Date.now(),
      );
    });

    const failure = await openViewer(sessionId, "viewer-global", "000000", IP_A);
    const error = await failure.waitForType("error");
    expect(error.code).toBe("passcode_locked");
    await failure.waitForClose();

    // The session-wide lock also rejects a different IP with the real passcode.
    const locked = await openViewer(sessionId, "viewer-global-2", PASSCODE, IP_B);
    const stillLocked = await locked.waitForType("error");
    expect(stillLocked.code).toBe("passcode_locked");
    await locked.waitForClose();
    host.close();
  });

  it("clears both per-IP and per-session counters after a success", async () => {
    const sessionId = "passcode-clear";
    const host = await openPasscodeHost(sessionId);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const viewer = await openViewer(sessionId, `viewer-${attempt}`, "000000", IP_A);
      expect((await viewer.waitForType("error")).code).toBe("passcode_invalid");
      await viewer.waitForClose();
    }
    const before = await readFailureState(sessionId);
    expect(before.passcodeFailures).toBe(4);
    expect(before.ipRows).toBe(1);

    const correct = await openViewer(sessionId, "viewer-ok", PASSCODE, IP_A);
    await correct.waitForType("welcome");
    correct.close();

    const after = await readFailureState(sessionId);
    expect(after.passcodeFailures).toBe(0);
    expect(after.ipRows).toBe(0);

    // A fresh failure window starts at 1 again: four more failures are invalid,
    // not locked (the previous four were cleared, not accumulated).
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const viewer = await openViewer(sessionId, `viewer-again-${attempt}`, "000000", IP_A);
      expect((await viewer.waitForType("error")).code).toBe("passcode_invalid");
      await viewer.waitForClose();
    }
    host.close();
  });

  it("requires the passcode for listeners too", async () => {
    const host = await openPasscodeHost("passcode-listener");
    const listener = await connectWorker("passcode-listener", {
      token: SESSION_TOKEN,
      listener: true,
    });
    listener.send(helloFor("passcode-listener", "listener", "listener-1"));
    const error = await listener.waitForType("error");
    expect(error.code).toBe("passcode_required");
    listener.close();
    host.close();
  });

  it("accepts a host reconnect with the same verifier and rejects a different one", async () => {
    const host = await openPasscodeHost("passcode-host-reconnect");
    host.close();
    const reconnect = await connectWorker("passcode-host-reconnect", {
      hostToken: MASTER_TOKEN,
      token: SESSION_TOKEN,
    });
    reconnect.send(
      helloFor("passcode-host-reconnect", "host", "host-2", {
        cols: 80,
        rows: 24,
        passcode: await makeVerifier(PASSCODE),
      }),
    );
    await reconnect.waitForType("welcome");
    reconnect.close();

    const rotated = await connectWorker("passcode-host-reconnect", {
      hostToken: MASTER_TOKEN,
      token: SESSION_TOKEN,
    });
    rotated.send(
      helloFor("passcode-host-reconnect", "host", "host-3", {
        cols: 80,
        rows: 24,
        passcode: await makeVerifier("654321"),
      }),
    );
    const mismatch = await rotated.waitForType("error");
    expect(mismatch.code).toBe("passcode_mismatch");
    rotated.close();
  });

  it("serializes concurrent wrong passcodes so a burst cannot bypass the per-IP lock", async () => {
    const sessionId = "passcode-race";
    const host = await openPasscodeHost(sessionId);
    const raceIp = "198.51.100.12";
    const viewers = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        openViewer(sessionId, `race-${index}`, "000000", raceIp),
      ),
    );
    const codes = await Promise.all(
      viewers.map(async (viewer) => (await viewer.waitForType("error")).code),
    );
    // The queue serializes counter updates: the fifth concurrent failure sees
    // the previous four and locks that IP.
    expect(codes.filter((code) => code === "passcode_locked")).toHaveLength(1);
    expect(codes.filter((code) => code === "passcode_invalid")).toHaveLength(4);
    for (const viewer of viewers) viewer.close();
    host.close();
    await sleep(100);
  });

  it("rejects a competing first-host hello that raced past the pre-passcode check", async () => {
    const session = "passcode-first-host-race";
    const verifier = await makeVerifier();
    const a = await connectWorker(session, { hostToken: MASTER_TOKEN, token: "token-a" });
    const b = await connectWorker(session, { hostToken: MASTER_TOKEN, token: "token-b" });
    a.send(helloFor(session, "host", "host-a", { cols: 80, rows: 24, passcode: verifier }));
    b.send(helloFor(session, "host", "host-b", { cols: 80, rows: 24, passcode: verifier }));
    const results = await Promise.allSettled([
      a.waitForType("welcome", 5_000),
      b.waitForType("welcome", 5_000),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    a.close();
    b.close();
    await sleep(100);
  });

  it("keeps sessions without a passcode unchanged", async () => {
    const host = await connectWorker("passcode-none", {
      hostToken: MASTER_TOKEN,
      token: SESSION_TOKEN,
    });
    host.send(helloFor("passcode-none", "host", "host-1", { cols: 80, rows: 24 }));
    await host.waitForType("welcome");
    const viewer = await openViewer("passcode-none", "viewer-1");
    await viewer.waitForType("welcome");
    viewer.close();
    host.close();
  });
});
