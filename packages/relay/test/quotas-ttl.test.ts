import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { encodeFrame } from "@limccn/tokimeki-protocol";
import { describe, expect, it } from "vitest";

import {
  connectWorker,
  helloFor,
  MASTER_TOKEN,
  openHost,
  openViewer,
  SESSION_TOKEN,
  setDoEnv,
  sleep,
} from "./helpers";

const DEFAULT_MAX_TTL_SECONDS = 86_400;

function outputFrame(seq: number, payloadBytes: number): Uint8Array {
  return encodeFrame({ type: "output", seq, payload: new Uint8Array(payloadBytes) });
}

// A type alias (not an interface) so it satisfies SqlStorage's row-record
// constraint through the implicit index signature.
type MetaRow = {
  absolute_deadline: number | null;
  relay_bytes: number;
  last_activity_at: number;
};

function stubFor(sessionId: string) {
  return env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
}

async function readMeta(sessionId: string): Promise<MetaRow | null> {
  return runInDurableObject(stubFor(sessionId), (_instance, state) => {
    const rows = state.storage.sql
      .exec<MetaRow>(
        "SELECT absolute_deadline, relay_bytes, last_activity_at FROM session_meta LIMIT 1",
      )
      .toArray();
    return rows[0] ?? null;
  });
}

async function execInDo(
  sessionId: string,
  query: string,
  ...bindings: Array<string | number | null>
): Promise<void> {
  await runInDurableObject(stubFor(sessionId), (_instance, state) => {
    state.storage.sql.exec(query, ...bindings);
  });
}

async function expectSessionGone(sessionId: string): Promise<void> {
  const late = await connectWorker(sessionId, { token: SESSION_TOKEN });
  late.send(helloFor(sessionId, "viewer", "viewer-late"));
  const error = await late.waitForType("error");
  expect(error.code).toBe("invalid_session");
  expect((await late.waitForClose()).code).toBe(4001);
}

describe("session absolute TTL", () => {
  it("records an absolute deadline when the host creates the session", async () => {
    const sessionId = "ttl-absolute-create";
    const before = Date.now();
    const host = await openHost(sessionId);
    const meta = await readMeta(sessionId);
    expect(meta?.absolute_deadline).not.toBeNull();
    expect(meta?.absolute_deadline).toBeGreaterThanOrEqual(
      before + DEFAULT_MAX_TTL_SECONDS * 1000 - 1_000,
    );
    expect(meta?.absolute_deadline).toBeLessThanOrEqual(
      Date.now() + DEFAULT_MAX_TTL_SECONDS * 1000 + 5_000,
    );
    host.close();
  });

  it("closes the session at the absolute deadline even while the host is online", async () => {
    const sessionId = "ttl-absolute-expiry";
    const host = await openHost(sessionId);
    const viewer = await openViewer(sessionId, "viewer-1");
    await execInDo(sessionId, "UPDATE session_meta SET absolute_deadline = ?", Date.now() - 1_000);

    await runDurableObjectAlarm(stubFor(sessionId));

    expect((await viewer.waitForClose()).code).toBe(4004);
    expect((await host.waitForClose()).code).toBe(4004);
    expect(
      host.controls.some((message) => message.type === "error" && message.code === "host_exited"),
    ).toBe(true);
    await sleep(100);
    await expectSessionGone(sessionId);
  });

  it("gives a legacy row one full window on its next host hello", async () => {
    const sessionId = "ttl-absolute-legacy";
    const host = await openHost(sessionId);
    await execInDo(sessionId, "UPDATE session_meta SET absolute_deadline = NULL");
    host.close();

    const before = Date.now();
    const reconnected = await connectWorker(sessionId, {
      hostToken: MASTER_TOKEN,
      token: SESSION_TOKEN,
    });
    reconnected.send(helloFor(sessionId, "host", "host-1"));
    await reconnected.waitForType("welcome");
    const meta = await readMeta(sessionId);
    expect(meta?.absolute_deadline).toBeGreaterThanOrEqual(
      before + DEFAULT_MAX_TTL_SECONDS * 1000 - 1_000,
    );
    reconnected.close();
  });

  it("does not set a deadline for legacy rows when the cap is disabled", async () => {
    const sessionId = "ttl-absolute-off";
    const host = await openHost(sessionId);
    await setDoEnv(sessionId, { TOKIMEKI_SESSION_MAX_TTL_SECONDS: "0" });
    await execInDo(sessionId, "UPDATE session_meta SET absolute_deadline = NULL");
    host.close();

    const reconnected = await connectWorker(sessionId, {
      hostToken: MASTER_TOKEN,
      token: SESSION_TOKEN,
    });
    reconnected.send(helloFor(sessionId, "host", "host-1"));
    await reconnected.waitForType("welcome");
    expect((await readMeta(sessionId))?.absolute_deadline).toBeNull();
    reconnected.close();
  });

  it("ignores a persisted absolute deadline when the cap is disabled", async () => {
    const sessionId = "ttl-absolute-disabled";
    const host = await openHost(sessionId);
    const viewer = await openViewer(sessionId, "viewer-1");
    await setDoEnv(sessionId, { TOKIMEKI_SESSION_MAX_TTL_SECONDS: "0" });
    await execInDo(sessionId, "UPDATE session_meta SET absolute_deadline = ?", Date.now() - 1_000);

    await runDurableObjectAlarm(stubFor(sessionId));
    await sleep(200);
    expect(viewer.closeInfo).toBeNull();
    expect(host.closeInfo).toBeNull();

    host.send({ v: 1, type: "ping" });
    await host.waitForType("pong");
    host.close();
    viewer.close();
  });
});

describe("session idle TTL", () => {
  it("expires an inactive session when the idle TTL is enabled", async () => {
    const sessionId = "ttl-idle-expiry";
    const host = await openHost(sessionId);
    const viewer = await openViewer(sessionId, "viewer-1");
    await setDoEnv(sessionId, { TOKIMEKI_SESSION_IDLE_TTL_SECONDS: "60" });
    await execInDo(
      sessionId,
      "UPDATE session_meta SET last_activity_at = ?, absolute_deadline = ?",
      Date.now() - 120_000,
      Date.now() + DEFAULT_MAX_TTL_SECONDS * 1000,
    );

    await runDurableObjectAlarm(stubFor(sessionId));
    expect((await viewer.waitForClose()).code).toBe(4004);
    expect((await host.waitForClose()).code).toBe(4004);
    await sleep(100);
    await expectSessionGone(sessionId);
  });

  it("does not expire inactive sessions while the idle TTL is disabled", async () => {
    const sessionId = "ttl-idle-disabled";
    const host = await openHost(sessionId);
    const viewer = await openViewer(sessionId, "viewer-1");
    await execInDo(
      sessionId,
      "UPDATE session_meta SET last_activity_at = ?",
      Date.now() - 90 * 24 * 60 * 60 * 1000,
    );

    await runDurableObjectAlarm(stubFor(sessionId));
    await sleep(200);
    expect(viewer.closeInfo).toBeNull();
    host.send({ v: 1, type: "ping" });
    await host.waitForType("pong");
    host.close();
    viewer.close();
  });
});

describe("session hard quotas", () => {
  it("closes the session when relayed bytes reach the cap, counting each frame once", async () => {
    const sessionId = "quota-bytes-close";
    await setDoEnv(sessionId, { TOKIMEKI_SESSION_MAX_BYTES: "1000" });
    const host = await openHost(sessionId);
    const viewer1 = await openViewer(sessionId, "viewer-1");
    const viewer2 = await openViewer(sessionId, "viewer-2");

    // 609 bytes with the frame header. Two viewers must not double-count it,
    // so the session stays open after the first frame.
    host.sendBinary(outputFrame(1, 600));
    await viewer1.waitForBinary();
    await viewer2.waitForBinary();
    await sleep(100);
    expect(viewer1.closeInfo).toBeNull();
    expect(
      host.controls.some((message) => message.type === "error" && message.code === "session_full"),
    ).toBe(false);

    host.sendBinary(outputFrame(2, 600));
    const error = await host.waitFor(
      (message) => message.type === "error" && message.code === "session_full",
    );
    expect(error.code).toBe("session_full");
    expect((await host.waitForClose()).code).toBe(4002);
    expect((await viewer1.waitForClose()).code).toBe(4002);
    expect((await viewer2.waitForClose()).code).toBe(4002);
    await sleep(100);
    await expectSessionGone(sessionId);
  });

  it("resumes counting from the persisted relay byte total", async () => {
    const sessionId = "quota-bytes-persisted";
    await setDoEnv(sessionId, { TOKIMEKI_SESSION_MAX_BYTES: "1000" });
    const host = await openHost(sessionId);
    const viewer = await openViewer(sessionId, "viewer-1");
    await execInDo(sessionId, "UPDATE session_meta SET relay_bytes = 900");

    // 309 bytes with the header crosses the remaining 100-byte budget.
    host.sendBinary(outputFrame(1, 300));
    const error = await host.waitFor(
      (message) => message.type === "error" && message.code === "session_full",
    );
    expect(error.code).toBe("session_full");
    expect((await viewer.waitForClose()).code).toBe(4002);
    await sleep(100);
    await expectSessionGone(sessionId);
  });

  it("closes the session when the inbound message rate exceeds the cap", async () => {
    const sessionId = "quota-rate-close";
    await setDoEnv(sessionId, { TOKIMEKI_SESSION_MAX_MESSAGES_PER_SECOND: "5" });
    const host = await openHost(sessionId);
    const viewer = await openViewer(sessionId, "viewer-1");
    for (let index = 0; index < 6; index += 1) {
      host.send({ v: 1, type: "ping" });
    }
    const error = await host.waitFor(
      (message) => message.type === "error" && message.code === "session_full",
    );
    expect(error.code).toBe("session_full");
    expect((await host.waitForClose()).code).toBe(4002);
    expect((await viewer.waitForClose()).code).toBe(4002);
    await sleep(100);
    await expectSessionGone(sessionId);
  });

  it("starts a recreated session with a fresh message-rate window", async () => {
    const sessionId = "quota-rate-reset";
    await setDoEnv(sessionId, { TOKIMEKI_SESSION_MAX_MESSAGES_PER_SECOND: "5" });
    const host = await openHost(sessionId);
    for (let index = 0; index < 6; index += 1) {
      host.send({ v: 1, type: "ping" });
    }
    expect((await host.waitForClose()).code).toBe(4002);

    // Recreate the same session on the same DO instance immediately. The old
    // session's rate timestamps must not leak into the new one.
    const reconnected = await openHost(sessionId);
    for (let index = 0; index < 3; index += 1) {
      reconnected.send({ v: 1, type: "ping" });
    }
    await reconnected.waitForType("pong");
    expect(
      reconnected.controls.some(
        (message) => message.type === "error" && message.code === "session_full",
      ),
    ).toBe(false);
    expect(reconnected.closeInfo).toBeNull();
    reconnected.close();
  });

  it("does not count or close anything when the quotas are disabled", async () => {
    const sessionId = "quota-disabled";
    const host = await openHost(sessionId);
    const viewer = await openViewer(sessionId, "viewer-1");

    for (let index = 0; index < 10; index += 1) {
      host.send({ v: 1, type: "ping" });
      host.sendBinary(outputFrame(index + 1, 8));
    }
    await sleep(300);

    expect(
      host.controls.some((message) => message.type === "error" && message.code === "session_full"),
    ).toBe(false);
    expect(viewer.closeInfo).toBeNull();
    expect(viewer.binary.length).toBeGreaterThanOrEqual(10);
    expect((await readMeta(sessionId))?.relay_bytes).toBe(0);
    host.close();
    viewer.close();
  });
});
