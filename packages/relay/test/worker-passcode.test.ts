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
 * Session passcode integration tests (v1.2-D).
 *
 * The host stores a PBKDF2 verifier in `hello.passcode`; viewers/listeners
 * submit the plaintext in `X-Tokimeki-Passcode`. Five failures lock all
 * verification for 30 s. The verifier/plaintext never leaves this process.
 */

const PASSCODE = "123456";
const SALT_TEXT = "tokimeki-salt-16"; // exactly 16 bytes

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
): Promise<TestSocket> {
  const socket = await connectWorker(sessionId, {
    token: SESSION_TOKEN,
    ...(passcode === undefined ? {} : { headers: { "x-tokimeki-passcode": passcode } }),
  });
  socket.send(helloFor(sessionId, "viewer", clientId));
  return socket;
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

  it("rejects a wrong passcode and locks after five failures", async () => {
    const host = await openPasscodeHost("passcode-lock");
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const viewer = await openViewer("passcode-lock", `viewer-${attempt}`, "000000");
      const error = await viewer.waitForType("error");
      expect(error.code).toBe("passcode_invalid");
      await viewer.waitForClose();
    }
    const fifth = await openViewer("passcode-lock", "viewer-5", "000000");
    const lockError = await fifth.waitForType("error");
    expect(lockError.code).toBe("passcode_locked");

    // Even the correct passcode is rejected while the lockout is active.
    const locked = await openViewer("passcode-lock", "viewer-6", PASSCODE);
    const stillLocked = await locked.waitForType("error");
    expect(stillLocked.code).toBe("passcode_locked");
    locked.close();
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

  it("serializes concurrent wrong passcodes so a burst cannot bypass lockout", async () => {
    const host = await openPasscodeHost("passcode-race");
    const viewers = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        openViewer("passcode-race", `race-${index}`, "000000"),
      ),
    );
    const codes = await Promise.all(
      viewers.map(async (viewer) => (await viewer.waitForType("error")).code),
    );
    expect(codes.filter((code) => code === "passcode_locked").length).toBeGreaterThan(0);
    expect(codes.filter((code) => code === "passcode_invalid").length).toBeLessThanOrEqual(5);
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
