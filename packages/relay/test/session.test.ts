import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { decodeFrame, encodeFrame, MAX_SIGNAL_PAYLOAD_BYTES } from "@limccn/tokimeki-protocol";
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
  type TestSocket,
} from "./helpers";

function outputFrame(seq: number, text: string): Uint8Array {
  return encodeFrame({ type: "output", seq, payload: new TextEncoder().encode(text) });
}

function outputFrameBytes(seq: number, payload: Uint8Array): Uint8Array {
  return encodeFrame({ type: "output", seq, payload });
}

async function waitForSnapshotTo(
  viewer: TestSocket,
  targetId: string,
  timeoutMs = 4_000,
): Promise<Uint8Array> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const bytes of viewer.binary) {
      const frame = decodeFrame(bytes);
      if (frame.type === "snapshot_to" && frame.targetId === targetId) {
        return bytes;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for snapshot_to ${targetId}`);
    }
    await sleep(20);
  }
}

describe("SessionDurableObject", () => {
  it("rejects a hello role that differs from the relay-assigned role", async () => {
    const socket = await connectDirect("role-mismatch", { role: "viewer" });
    socket.send(helloFor("role-mismatch", "host", "host-1"));
    const error = await socket.waitForType("error");
    expect(error.code).toBe("invalid_role");
    const closed = await socket.waitForClose();
    expect(closed.code).toBe(4003);
  });

  it("accepts unknown capabilities from newer clients", async () => {
    const socket = await connectWorker("unknown-capabilities", {
      hostToken: MASTER_TOKEN,
      token: SESSION_TOKEN,
    });
    socket.send(
      helloFor("unknown-capabilities", "host", "host-1", {
        capabilities: {
          protocolVersion: 1,
          futureFeature: { nested: true },
          tunnel: { version: 99, arq: "kcp", unknownKey: "value" },
        },
      }),
    );
    const welcome = await socket.waitForType("welcome");
    expect(welcome.session).toBe("unknown-capabilities");
    const serialized = JSON.stringify(welcome);
    expect(serialized).not.toContain(MASTER_TOKEN);
    expect(serialized).not.toContain(SESSION_TOKEN);
    expect(serialized).not.toContain("test-coturn-secret");
    expect(serialized).not.toContain("test-turn-api-token");
    socket.close();
  });

  it("echoes client identity and display capabilities in welcome and presence", async () => {
    const sessionId = "client-display-echo";
    const host = await connectWorker(sessionId, {
      hostToken: MASTER_TOKEN,
      token: SESSION_TOKEN,
    });
    host.send(
      helloFor(sessionId, "host", "host-1", {
        client: { name: "tokimeki-cli", version: "0.1.2", kind: "cli", platform: "win32" },
        capabilities: {
          display: {
            modes: ["fixed-grid", "viewport"],
            fixed: { cols: 120, rows: 40 },
            logPanel: true,
            terminalQueries: "host",
          },
        },
      }),
    );
    await host.waitForType("welcome");

    const viewer = await connectWorker(sessionId, { token: SESSION_TOKEN });
    viewer.send(
      helloFor(sessionId, "viewer", "viewer-1", {
        client: { name: "tokimeki-cli", version: "0.1.2", kind: "cli", platform: "darwin" },
        capabilities: { display: { modes: ["viewport"], logPanel: true } },
      }),
    );
    const viewerWelcome = await viewer.waitForType("welcome");
    const hostInfo = (viewerWelcome.clients as Array<Record<string, unknown>>).find(
      (client) => client.clientId === "host-1",
    );
    expect(hostInfo?.client).toMatchObject({ name: "tokimeki-cli", kind: "cli" });
    expect(hostInfo?.capabilities).toMatchObject({
      display: { modes: ["fixed-grid", "viewport"], fixed: { cols: 120, rows: 40 } },
    });

    const joined = await host.waitFor((message) => message.type === "peer-joined");
    expect(joined.capabilities).toMatchObject({
      display: { modes: ["viewport"], logPanel: true },
    });

    const secondViewer = await connectWorker(sessionId, { token: SESSION_TOKEN });
    secondViewer.send(helloFor(sessionId, "viewer", "viewer-2"));
    const secondWelcome = await secondViewer.waitForType("welcome");
    const viewerInfo = (secondWelcome.clients as Array<Record<string, unknown>>).find(
      (client) => client.clientId === "viewer-1",
    );
    expect(viewerInfo?.client).toMatchObject({ name: "tokimeki-cli", kind: "cli" });
    expect(viewerInfo?.capabilities).toMatchObject({ display: { modes: ["viewport"] } });

    host.close();
    viewer.close();
    secondViewer.close();
  });

  it("broadcasts display-size from the host only to supporting viewers/listeners", async () => {
    const sessionId = "display-size-update";
    const host = await connectWorker(sessionId, {
      hostToken: MASTER_TOKEN,
      token: SESSION_TOKEN,
    });
    host.send(
      helloFor(sessionId, "host", "host-1", {
        capabilities: {
          display: {
            modes: ["fixed-grid"],
            fixed: { cols: 120, rows: 40 },
            resize: 1,
          },
        },
      }),
    );
    await host.waitForType("welcome");
    // The test config caps clients at 3; this scenario needs a host plus a
    // supporting viewer/listener, a legacy viewer, an observer, and a late
    // joiner in the same session.
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
    await runInDurableObject(stub, (_instance: unknown, state: DurableObjectState) => {
      state.storage.sql.exec("UPDATE session_meta SET max_clients = 10");
    });

    const viewer = await connectWorker(sessionId, { token: SESSION_TOKEN });
    viewer.send(
      helloFor(sessionId, "viewer", "viewer-1", {
        capabilities: { display: { modes: ["viewport"], resize: 1 } },
      }),
    );
    const viewerWelcome = await viewer.waitForType("welcome");
    expect(
      (viewerWelcome.capabilities as { display?: { resize?: number } } | undefined)?.display
        ?.resize,
    ).toBe(1);
    const initialHost = (viewerWelcome.clients as Array<Record<string, unknown>>).find(
      (client) => client.clientId === "host-1",
    );
    expect(initialHost?.capabilities).toMatchObject({
      display: { fixed: { cols: 120, rows: 40 } },
    });

    const legacy = await connectWorker(sessionId, { token: SESSION_TOKEN });
    legacy.send(
      helloFor(sessionId, "viewer", "legacy-1", {
        capabilities: { display: { modes: ["viewport"] } },
      }),
    );
    await legacy.waitForType("welcome");

    const listener = await connectWorker(sessionId, { token: SESSION_TOKEN, listener: true });
    listener.send(
      helloFor(sessionId, "listener", "listener-1", {
        capabilities: { display: { modes: ["viewport"], resize: 1 } },
      }),
    );
    await listener.waitForType("welcome");

    const observer = await connectDirect(sessionId, { role: "observer" });
    observer.send(
      helloFor(sessionId, "observer", "observer-1", {
        capabilities: { display: { resize: 1 } },
      }),
    );
    await observer.waitForType("welcome");

    const tablesBefore = await runInDurableObject(stub, async (_instance: unknown, state) =>
      state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((row) => row.name)
        .sort(),
    );

    host.send({ v: 1, type: "display-size", cols: 132, rows: 43 });

    const viewerUpdate = await viewer.waitForType("display-size");
    expect(viewerUpdate).toMatchObject({ cols: 132, rows: 43 });
    const listenerUpdate = await listener.waitForType("display-size");
    expect(listenerUpdate).toMatchObject({ cols: 132, rows: 43 });
    await sleep(100);
    expect(legacy.controls.some((message) => message.type === "display-size")).toBe(false);
    expect(observer.controls.some((message) => message.type === "display-size")).toBe(false);
    expect(host.controls.some((message) => message.type === "display-size")).toBe(false);

    // The host attachment is rewritten so a hibernation wake keeps the new
    // size and `welcome.clients` reports it to late joiners.
    const storedFixed = await runInDurableObject(
      stub,
      async (_instance: unknown, state: DurableObjectState) => {
        for (const socket of state.getWebSockets()) {
          const attachment = socket.deserializeAttachment() as
            | {
                kind?: string;
                clientId?: string;
                capabilities?: { display?: { fixed?: { cols: number; rows: number } } };
              }
            | undefined;
          if (attachment?.kind === "active" && attachment.clientId === "host-1") {
            return attachment.capabilities?.display?.fixed ?? null;
          }
        }
        return null;
      },
    );
    expect(storedFixed).toEqual({ cols: 132, rows: 43 });

    const tablesAfter = await runInDurableObject(stub, async (_instance: unknown, state) =>
      state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((row) => row.name)
        .sort(),
    );
    expect(tablesAfter).toEqual(tablesBefore);

    const late = await openViewer(sessionId, "late-1");
    const lateWelcome = late.controls.find((message) => message.type === "welcome");
    const lateHost = (lateWelcome?.clients as Array<Record<string, unknown>> | undefined)?.find(
      (client) => client.clientId === "host-1",
    );
    expect(lateHost?.capabilities).toMatchObject({
      display: { fixed: { cols: 132, rows: 43 } },
    });

    host.close();
    viewer.close();
    legacy.close();
    listener.close();
    observer.close();
    late.close();
  });

  it("rejects display-size from viewers/listeners and invalid sizes", async () => {
    const sessionId = "display-size-role";
    const host = await openHost(sessionId);
    const viewer = await openViewer(sessionId, "viewer-1");
    viewer.send({ v: 1, type: "display-size", cols: 100, rows: 30 });
    const viewerError = await viewer.waitFor(
      (message) => message.type === "error" && String(message.message).includes("display-size"),
    );
    expect(viewerError.code).toBe("invalid_role");

    const listener = await openListener(sessionId, "listener-1");
    listener.send({ v: 1, type: "display-size", cols: 100, rows: 30 });
    const listenerError = await listener.waitFor(
      (message) => message.type === "error" && String(message.message).includes("display-size"),
    );
    expect(listenerError.code).toBe("invalid_role");

    // The schema rejects an over-limit grid before it reaches the routing code.
    host.send({ v: 1, type: "display-size", cols: 10_000, rows: 10_000 });
    const sizeError = await host.waitFor(
      (message) => message.type === "error" && message.code === "invalid_message",
    );
    expect(sizeError.code).toBe("invalid_message");
    await sleep(100);
    expect(viewer.controls.some((message) => message.type === "display-size")).toBe(false);

    host.close();
    viewer.close();
    listener.close();
  });

  it("rejects duplicate client ids", async () => {
    const host = await openHost("duplicate-client");
    const viewer = await openViewer("duplicate-client", "viewer-1");
    const duplicate = await connectWorker("duplicate-client", { token: SESSION_TOKEN });
    duplicate.send(helloFor("duplicate-client", "viewer", "viewer-1"));
    const error = await duplicate.waitForType("error");
    expect(error.code).toBe("duplicate_client_id");
    const closed = await duplicate.waitForClose();
    expect(closed.code).toBe(4003);
    host.close();
    viewer.close();
  });

  it("rejects a second host while the first is online", async () => {
    const host = await openHost("duplicate-host");
    const second = await connectWorker("duplicate-host", {
      hostToken: MASTER_TOKEN,
      token: SESSION_TOKEN,
    });
    second.send(helloFor("duplicate-host", "host", "host-2"));
    const error = await second.waitForType("error");
    expect(error.code).toBe("duplicate_client_id");
    const closed = await second.waitForClose();
    expect(closed.code).toBe(4003);
    host.close();
  });

  it("enforces the max clients limit", async () => {
    const host = await openHost("max-clients");
    const viewer1 = await openViewer("max-clients", "viewer-1");
    const viewer2 = await openViewer("max-clients", "viewer-2");
    const viewer3 = await connectWorker("max-clients", { token: SESSION_TOKEN });
    viewer3.send(helloFor("max-clients", "viewer", "viewer-3"));
    const error = await viewer3.waitForType("error");
    expect(error.code).toBe("session_full");
    const closed = await viewer3.waitForClose();
    expect(closed.code).toBe(4002);
    host.close();
    viewer1.close();
    viewer2.close();
  });

  it("accepts a listener, advertises snapshot-only, and announces its role", async () => {
    const sessionId = "listener-join";
    const host = await openHost(sessionId);
    const listener = await openListener(sessionId, "listener-1");

    const welcome = listener.controls.find((message) => message.type === "welcome");
    expect(welcome).toBeDefined();
    const capabilities = welcome?.capabilities as { listener?: { modes?: string[] } } | undefined;
    expect(capabilities?.listener?.modes).toEqual(["snapshot-only"]);

    const joined = await host.waitFor(
      (message) => message.type === "peer-joined" && message.clientId === "listener-1",
    );
    expect(joined.role).toBe("listener");

    // A listener hello must never synthesize a host-facing resize.
    const sized = await connectWorker(sessionId, { token: SESSION_TOKEN, listener: true });
    sized.send(helloFor(sessionId, "listener", "listener-sized", { cols: 120, rows: 40 }));
    await sized.waitForType("welcome");
    await sleep(100);
    expect(
      host.controls.some(
        (message) => message.type === "resize" && message.clientId === "listener-sized",
      ),
    ).toBe(false);

    host.close();
    listener.close();
    sized.close();
  });

  it("never issues TURN credentials to a listener", async () => {
    const sessionId = "listener-turn-gate";
    // The test env has coturn configured, so hosts/viewers get TURN.
    const host = await openHost(sessionId);
    expect(host.controls.find((message) => message.type === "welcome")?.iceProvider).toBe("coturn");
    const viewer = await openViewer(sessionId, "viewer-1");
    expect(viewer.controls.find((message) => message.type === "welcome")?.iceProvider).toBe(
      "coturn",
    );

    const listener = await openListener(sessionId, "listener-1");
    const welcome = listener.controls.find((message) => message.type === "welcome");
    expect(welcome?.iceProvider).toBe("stun");
    expect(welcome?.iceExpiresAt).toBeNull();
    // Control messages arrive as untyped JSON in this harness; narrow the
    // listener welcome's ICE server list for the TURN assertions.
    const servers = (welcome?.iceServers ?? []) as Array<{
      urls: string | string[];
      username?: string;
      credential?: string;
    }>;
    expect(servers.length).toBeGreaterThan(0);
    for (const server of servers) {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      expect(urls.every((url) => url.startsWith("stun:"))).toBe(true);
      expect(server.username).toBeUndefined();
      expect(server.credential).toBeUndefined();
    }
    const serialized = JSON.stringify(welcome);
    expect(serialized).not.toContain("test-coturn-secret");
    expect(serialized).not.toContain("turn:coturn.test.invalid");

    listener.send({ v: 1, type: "ice-refresh" });
    const error = await listener.waitFor(
      (message) => message.type === "error" && String(message.message).includes("TURN"),
    );
    expect(error.code).toBe("invalid_role");
    await sleep(100);
    expect(listener.controls.some((message) => message.type === "ice")).toBe(false);

    // Host/viewer ICE refresh behavior is unchanged.
    viewer.send({ v: 1, type: "ice-refresh" });
    const refreshed = await viewer.waitForType("ice");
    expect(refreshed.iceProvider).toBe("coturn");

    host.close();
    viewer.close();
    listener.close();
  });

  it("rejects a listener without a host session and does not create the schema", async () => {
    const sessionId = "listener-no-session";
    const listener = await connectWorker(sessionId, { token: SESSION_TOKEN, listener: true });
    listener.send(helloFor(sessionId, "listener", "listener-1"));
    // v1.7 R2: uniform unauthorized for an opaque token; no existence oracle.
    const error = await listener.waitForType("error");
    expect(error.code).toBe("unauthorized");
    const closed = await listener.waitForClose();
    expect(closed.code).toBe(4001);

    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
    const tables = await runInDurableObject(stub, async (_instance: unknown, state) => {
      return state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((row) => row.name);
    });
    expect(tables).not.toContain("session_meta");
  });

  it("enforces the independent listener limit", async () => {
    // The test config caps listeners at 2. Raise max clients first so the
    // listener cap, not the total client cap, is the failing check.
    const sessionId = "listener-limit";
    const host = await openHost(sessionId);
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
    await runInDurableObject(stub, (_instance: unknown, state) => {
      state.storage.sql.exec("UPDATE session_meta SET max_clients = 10");
    });

    const listener1 = await openListener(sessionId, "listener-1");
    const listener2 = await openListener(sessionId, "listener-2");
    const third = await connectWorker(sessionId, { token: SESSION_TOKEN, listener: true });
    third.send(helloFor(sessionId, "listener", "listener-3"));
    const error = await third.waitForType("error");
    expect(error.code).toBe("session_full");
    expect(String(error.message)).toContain("listener limit");
    const closed = await third.waitForClose();
    expect(closed.code).toBe(4002);

    host.close();
    listener1.close();
    listener2.close();
  });

  it("still counts listeners toward the total client limit", async () => {
    // Test config: maxClients=3, maxListeners=2. host+viewer+listener fills the
    // session, so a second listener fails the total cap even though only one
    // listener is active.
    const sessionId = "listener-total-limit";
    const host = await openHost(sessionId);
    const viewer = await openViewer(sessionId, "viewer-1");
    const listener = await openListener(sessionId, "listener-1");

    const extra = await connectWorker(sessionId, { token: SESSION_TOKEN, listener: true });
    extra.send(helloFor(sessionId, "listener", "listener-2"));
    const error = await extra.waitForType("error");
    expect(error.code).toBe("session_full");
    expect(String(error.message)).toContain("client limit");
    const closed = await extra.waitForClose();
    expect(closed.code).toBe(4002);

    host.close();
    viewer.close();
    listener.close();
  });

  it("keeps a listener read-only and off the terminal data path", async () => {
    const sessionId = "listener-readonly";
    const host = await openHost(sessionId);
    const viewer = await openViewer(sessionId, "viewer-1");
    const listener = await openListener(sessionId, "listener-1");

    host.sendBinary(outputFrame(1, "viewer-only"));
    const delivered = decodeFrame(await viewer.waitForBinary());
    expect(delivered.type).toBe("output");
    await sleep(100);
    expect(listener.binary).toHaveLength(0);

    listener.sendBinary(encodeFrame({ type: "input", payload: new TextEncoder().encode("x") }));
    listener.send({ v: 1, type: "resize", clientId: "listener-1", cols: 100, rows: 30 });
    listener.send({ v: 1, type: "resync" });
    listener.send({ v: 1, type: "ack", seq: "1" });
    listener.send({
      v: 1,
      type: "signal",
      to: "host-1",
      from: "listener-1",
      kind: "offer",
      payload: { sdp: "x" },
    });
    listener.send({
      v: 1,
      type: "transport",
      clientId: "listener-1",
      mode: "p2p-direct",
      state: "ready",
    });
    await sleep(200);

    const errors = listener.controls.filter((message) => message.type === "error");
    expect(errors.every((message) => message.code === "invalid_role")).toBe(true);
    const errorText = errors.map((message) => String(message.message)).join("\n");
    expect(errorText).toContain("terminal frames");
    expect(errorText).toContain("resize");
    expect(errorText).toContain("resync");
    expect(errorText).toContain("acknowledge");
    expect(errorText).toContain("signals");
    expect(errorText).toContain("transport");

    // Nothing was forwarded to the host as data, resize, signal, or transport.
    expect(host.binary).toHaveLength(0);
    expect(
      host.controls.some(
        (message) =>
          message.type === "resize" || message.type === "signal" || message.type === "transport",
      ),
    ).toBe(false);

    // Lifecycle events still reach the listener.
    host.send({ v: 1, type: "host-exited", exitCode: 0 });
    const exited = await listener.waitForType("host-exited");
    expect(exited.exitCode).toBe(0);

    host.close();
    viewer.close();
    listener.close();
  });

  it("delivers repeated listener snapshots without ACK or backpressure", async () => {
    const sessionId = "listener-snapshot";
    const host = await openHost(sessionId);
    const listener = await openListener(sessionId, "listener-1");

    // 2 x 600 KiB crosses the viewer high-water mark; listeners must not be
    // paused, ACK-tracked, or closed for this.
    const payload = new Uint8Array(600_000);
    host.sendBinary(encodeFrame({ type: "snapshot_to", targetId: "listener-1", seq: 1, payload }));
    host.sendBinary(encodeFrame({ type: "snapshot_to", targetId: "listener-1", seq: 2, payload }));
    await listener.waitForBinary();
    await sleep(300);
    const snapshots = listener.binary.filter((bytes) => decodeFrame(bytes).type === "snapshot_to");
    expect(snapshots.length).toBe(2);

    await sleep(150);
    expect(host.controls.some((message) => message.type === "pause")).toBe(false);
    expect(listener.closeInfo).toBeNull();

    host.close();
    listener.close();
  });

  it("does not let a listener ACK clear viewer backpressure", async () => {
    const sessionId = "listener-ack-isolation";
    const host = await openHost(sessionId);
    const viewer = await openViewer(sessionId, "viewer-1");
    const listener = await openListener(sessionId, "listener-1");

    const halfMiB = new Uint8Array(524_288);
    host.sendBinary(outputFrameBytes(1, halfMiB));
    host.sendBinary(outputFrameBytes(2, halfMiB));
    await host.waitFor((message) => message.type === "pause" && message.clientId === "viewer-1");

    // A recovery snapshot for the paused viewer must not be confused with the
    // listener delivery path, and a listener snapshot still arrives while the
    // viewer is paused.
    host.sendBinary(
      encodeFrame({
        type: "snapshot_to",
        targetId: "listener-1",
        seq: 3,
        payload: new TextEncoder().encode("listener screen"),
      }),
    );
    const received = decodeFrame(await listener.waitForBinary());
    expect(received.type).toBe("snapshot_to");

    listener.send({ v: 1, type: "ack", seq: "3" });
    await listener.waitFor(
      (message) => message.type === "error" && message.code === "invalid_role",
    );
    await sleep(150);
    expect(
      host.controls.some((message) => message.type === "resume" && message.clientId === "viewer-1"),
    ).toBe(false);

    viewer.send({ v: 1, type: "ack", seq: "3" });
    const resumed = await host.waitFor(
      (message) => message.type === "resume" && message.clientId === "viewer-1",
    );
    expect(resumed.type).toBe("resume");

    host.close();
    viewer.close();
    listener.close();
  });

  it("broadcasts host output to every relayed viewer", async () => {
    const host = await openHost("output-broadcast");
    const viewer1 = await openViewer("output-broadcast", "viewer-1");
    const viewer2 = await openViewer("output-broadcast", "viewer-2");
    host.sendBinary(outputFrame(1, "hello viewers"));
    for (const viewer of [viewer1, viewer2]) {
      const frame = decodeFrame(await viewer.waitForBinary());
      expect(frame.type).toBe("output");
      if (frame.type === "output") {
        expect(frame.seq).toBe(1);
        expect(new TextDecoder().decode(frame.payload)).toBe("hello viewers");
      }
    }
    host.close();
    viewer1.close();
    viewer2.close();
  });

  it("forwards viewer input only to the host", async () => {
    const host = await openHost("input-routing");
    const viewer1 = await openViewer("input-routing", "viewer-1");
    const viewer2 = await openViewer("input-routing", "viewer-2");
    const input = encodeFrame({
      type: "input",
      payload: new TextEncoder().encode("ls\n"),
    });
    viewer1.sendBinary(input);
    const received = decodeFrame(await host.waitForBinary());
    expect(received.type).toBe("input");
    if (received.type === "input") {
      expect(new TextDecoder().decode(received.payload)).toBe("ls\n");
    }
    await sleep(100);
    expect(viewer2.binary).toHaveLength(0);
    host.close();
    viewer1.close();
    viewer2.close();
  });

  it("relays host-exited from the host and rejects viewer spoofing", async () => {
    const host = await openHost("host-exited-route");
    const viewer1 = await openViewer("host-exited-route", "viewer-1");
    const viewer2 = await openViewer("host-exited-route", "viewer-2");

    host.send({ v: 1, type: "host-exited", exitCode: 0 });
    for (const viewer of [viewer1, viewer2]) {
      const exited = await viewer.waitForType("host-exited");
      expect(exited.exitCode).toBe(0);
    }

    viewer1.send({ v: 1, type: "host-exited", exitCode: 1 });
    const error = await viewer1.waitForType("error");
    expect(error.code).toBe("invalid_role");

    host.close();
    viewer1.close();
    viewer2.close();
  });

  it("replays host-exited to a viewer that joins after the host exit", async () => {
    const host = await openHost("host-exited-replay");
    const early = await openViewer("host-exited-replay", "viewer-early");

    host.send({ v: 1, type: "host-exited", exitCode: 7, signal: "SIGTERM" });
    const earlyExit = await early.waitForType("host-exited");
    expect(earlyExit.exitCode).toBe(7);
    expect(earlyExit.signal).toBe("SIGTERM");

    // The late viewer connects after the broadcast. It must still learn that
    // the PTY is gone instead of waiting for a host that will never return.
    const late = await openViewer("host-exited-replay", "viewer-late");
    const lateExit = await late.waitForType("host-exited");
    expect(lateExit.exitCode).toBe(7);
    expect(lateExit.signal).toBe("SIGTERM");

    host.close();
    early.close();
    late.close();
  });

  it("sends SNAPSHOT_TO only to the named viewer", async () => {
    const host = await openHost("snapshot-to");
    const viewer1 = await openViewer("snapshot-to", "viewer-1");
    const viewer2 = await openViewer("snapshot-to", "viewer-2");
    host.sendBinary(
      encodeFrame({
        type: "snapshot_to",
        targetId: "viewer-1",
        seq: 7,
        payload: new TextEncoder().encode("snapshot"),
      }),
    );
    const frame = decodeFrame(await viewer1.waitForBinary());
    expect(frame.type).toBe("snapshot_to");
    if (frame.type === "snapshot_to") {
      expect(frame.targetId).toBe("viewer-1");
      expect(frame.seq).toBe(7);
    }
    await sleep(100);
    expect(viewer2.binary).toHaveLength(0);
    host.close();
    viewer1.close();
    viewer2.close();
  });

  it("rejects a bare SNAPSHOT on the relay", async () => {
    const host = await openHost("bare-snapshot");
    const viewer = await openViewer("bare-snapshot", "viewer-1");
    host.sendBinary(
      encodeFrame({
        type: "snapshot",
        seq: 1,
        payload: new TextEncoder().encode("snapshot"),
      }),
    );
    const error = await host.waitForType("error");
    expect(error.code).toBe("invalid_frame");
    expect(viewer.binary).toHaveLength(0);
    host.close();
    viewer.close();
  });

  it("rejects FRAGMENT frames instead of forwarding them", async () => {
    const host = await openHost("fragment-frame");
    const viewer = await openViewer("fragment-frame", "viewer-1");
    const fragment = encodeFrame({
      type: "fragment",
      messageId: 1,
      fragmentIndex: 0,
      fragmentCount: 1,
      totalBytes: 5,
      payload: new TextEncoder().encode("hello"),
    });

    host.sendBinary(fragment);
    const hostError = await host.waitForType("error");
    expect(hostError.code).toBe("invalid_frame");
    expect(viewer.binary).toHaveLength(0);

    viewer.sendBinary(fragment);
    const viewerError = await viewer.waitForType("error");
    expect(viewerError.code).toBe("invalid_frame");
    expect(host.binary).toHaveLength(0);

    host.close();
    viewer.close();
  });

  it("answers reserved TUNNEL frames with not_implemented", async () => {
    const host = await openHost("tunnel-frame");
    const viewer = await openViewer("tunnel-frame", "viewer-1");
    viewer.sendBinary(encodeFrame({ type: "tunnel", payload: new TextEncoder().encode("tunnel") }));
    const error = await viewer.waitForType("error");
    expect(error.code).toBe("not_implemented");
    host.close();
    viewer.close();
  });

  it("skips relayed output for a viewer whose P2P transport is ready", async () => {
    const host = await openHost("p2p-skip");
    const viewer1 = await openViewer("p2p-skip", "viewer-1");
    const viewer2 = await openViewer("p2p-skip", "viewer-2");
    host.send({
      v: 1,
      type: "transport",
      clientId: "viewer-1",
      mode: "p2p-direct",
      state: "ready",
    });
    await viewer1.waitForType("transport");
    await viewer2.waitForType("transport");
    host.sendBinary(outputFrame(2, "only relayed"));
    const frame = decodeFrame(await viewer2.waitForBinary());
    expect(frame.type).toBe("output");
    await sleep(100);
    expect(viewer1.binary).toHaveLength(0);
    host.close();
    viewer1.close();
    viewer2.close();
  });

  it("announces peers with presence and peer-joined", async () => {
    const host = await openHost("presence");
    const viewer1 = await openViewer("presence", "viewer-1");
    const joined = await host.waitFor(
      (message) => message.type === "peer-joined" && message.clientId === "viewer-1",
    );
    expect(joined.clientId).toBe("viewer-1");
    const viewer2 = await openViewer("presence", "viewer-2");
    const presence = await viewer1.waitFor(
      (message) =>
        message.type === "presence" &&
        Array.isArray(message.clients) &&
        message.clients.length === 3,
    );
    const clients = presence.clients as Array<{ clientId: string }>;
    const ids = clients.map((client) => client.clientId).sort();
    expect(ids).toEqual(["host-1", "viewer-1", "viewer-2"]);
    host.close();
    viewer1.close();
    viewer2.close();
  });

  it("allows a host to reconnect with the same token after going offline", async () => {
    const host = await openHost("host-reconnect");
    const viewer = await openViewer("host-reconnect", "viewer-1");
    host.close();
    await viewer.waitFor((message) => message.type === "host" && message.online === false);
    const reconnected = await connectWorker("host-reconnect", {
      hostToken: MASTER_TOKEN,
      token: SESSION_TOKEN,
    });
    reconnected.send(helloFor("host-reconnect", "host", "host-1"));
    const welcome = await reconnected.waitForType("welcome");
    expect(welcome.hostOnline).toBe(true);
    await viewer.waitFor((message) => message.type === "host" && message.online === true);
    reconnected.close();
    viewer.close();
  });

  it("rejects a host reconnect with a different session token", async () => {
    const host = await openHost("host-token-change");
    const viewer = await openViewer("host-token-change", "viewer-1");
    host.close();
    await viewer.waitFor((message) => message.type === "host" && message.online === false);
    const reconnected = await connectWorker("host-token-change", {
      hostToken: MASTER_TOKEN,
      token: "different-session-token",
    });
    reconnected.send(helloFor("host-token-change", "host", "host-1"));
    const error = await reconnected.waitForType("error");
    expect(error.code).toBe("unauthorized");
    const closed = await reconnected.waitForClose();
    expect(closed.code).toBe(4001);
    viewer.close();
  });

  it("keeps observers on the control plane only", async () => {
    const host = await openHost("observer-role");
    const observer = await connectDirect("observer-role", {
      role: "observer",
      token: SESSION_TOKEN,
    });
    observer.send(helloFor("observer-role", "observer", "observer-1"));
    await observer.waitForType("welcome");
    const viewer = await openViewer("observer-role", "viewer-1");
    await observer.waitForType("presence");

    host.sendBinary(outputFrame(3, "not for observers"));
    await viewer.waitForBinary();
    await sleep(100);
    expect(observer.binary).toHaveLength(0);

    observer.sendBinary(encodeFrame({ type: "input", payload: new TextEncoder().encode("x") }));
    const inputError = await observer.waitForType("error");
    expect(inputError.code).toBe("invalid_role");

    observer.send({
      v: 1,
      type: "resize",
      clientId: "observer-1",
      cols: 100,
      rows: 30,
    });
    const resizeError = await observer.waitFor(
      (message) =>
        message.type === "error" &&
        message.code === "invalid_role" &&
        String(message.message).includes("resize"),
    );
    expect(resizeError.code).toBe("invalid_role");

    observer.send({ v: 1, type: "resync" });
    const resyncError = await observer.waitFor(
      (message) =>
        message.type === "error" &&
        message.code === "invalid_role" &&
        String(message.message).includes("resync"),
    );
    expect(resyncError.code).toBe("invalid_role");

    host.close();
    observer.close();
    viewer.close();
  });

  it("keeps agents on the reserved agent namespace only", async () => {
    const host = await openHost("agent-role");
    const agent = await connectDirect("agent-role", {
      role: "agent",
      token: SESSION_TOKEN,
    });
    agent.send(helloFor("agent-role", "agent", "agent-1"));
    await agent.waitForType("welcome");

    host.sendBinary(outputFrame(4, "not for agents"));
    await sleep(100);
    expect(agent.binary).toHaveLength(0);

    agent.send({ v: 1, type: "agent.ping", requestId: "req-7" });
    const notImplemented = await agent.waitFor(
      (message) => message.type === "error" && message.code === "not_implemented",
    );
    expect(notImplemented.requestId).toBe("req-7");

    agent.send({ v: 1, type: "ping", ts: 1 });
    const error = await agent.waitFor(
      (message) => message.type === "error" && message.code === "invalid_role",
    );
    expect(error.code).toBe("invalid_role");

    agent.sendBinary(encodeFrame({ type: "input", payload: new TextEncoder().encode("x") }));
    await agent.waitFor(
      (message) =>
        message.type === "error" &&
        message.code === "invalid_role" &&
        String(message.message).includes("terminal frames"),
    );

    host.close();
    agent.close();
  });

  it("pauses the host when a viewer falls behind and resumes it after an ack", async () => {
    const host = await openHost("flow-control");
    const viewer = await openViewer("flow-control", "viewer-1");
    const halfMiB = new Uint8Array(524_288);
    host.sendBinary(outputFrameBytes(1, halfMiB));
    host.sendBinary(outputFrameBytes(2, halfMiB));

    const paused = await host.waitFor(
      (message) => message.type === "pause" && message.clientId === "viewer-1",
    );
    expect(paused.type).toBe("pause");

    viewer.send({ v: 1, type: "ack", seq: "2" });
    const resumed = await host.waitFor(
      (message) => message.type === "resume" && message.clientId === "viewer-1",
    );
    expect(resumed.type).toBe("resume");

    host.close();
    viewer.close();
  });

  it("delivers a recovery snapshot while the viewer is paused", async () => {
    const host = await openHost("flow-control-snapshot");
    const viewer = await openViewer("flow-control-snapshot", "viewer-1");
    const halfMiB = new Uint8Array(524_288);
    host.sendBinary(outputFrameBytes(1, halfMiB));
    host.sendBinary(outputFrameBytes(2, halfMiB));
    await host.waitFor((message) => message.type === "pause" && message.clientId === "viewer-1");

    const payload = new TextEncoder().encode("recovered screen");
    host.sendBinary(encodeFrame({ type: "snapshot_to", targetId: "viewer-1", seq: 3, payload }));

    // The viewer has not ACKed the 1 MiB it already received, so the relay
    // still considers it paused. SNAPSHOT_TO is the recovery path and must
    // not be dropped with regular output; otherwise the viewer's sequence
    // stays gapped and the host has no later output to trigger another resync.
    const received = await waitForSnapshotTo(viewer, "viewer-1");
    const frame = decodeFrame(received);
    expect(frame.type).toBe("snapshot_to");
    if (frame.type === "snapshot_to") {
      expect(frame.seq).toBe(3);
      expect(new TextDecoder().decode(frame.payload)).toBe("recovered screen");
    }

    viewer.send({ v: 1, type: "ack", seq: "3" });
    const resumed = await host.waitFor(
      (message) => message.type === "resume" && message.clientId === "viewer-1",
    );
    expect(resumed.type).toBe("resume");

    host.close();
    viewer.close();
  });

  it("resumes a paused viewer when the host announces its P2P transport", async () => {
    const host = await openHost("flow-control-host-ready");
    const viewer = await openViewer("flow-control-host-ready", "viewer-1");
    const halfMiB = new Uint8Array(524_288);
    host.sendBinary(outputFrameBytes(1, halfMiB));
    host.sendBinary(outputFrameBytes(2, halfMiB));
    await host.waitFor((message) => message.type === "pause" && message.clientId === "viewer-1");

    host.send({
      v: 1,
      type: "transport",
      clientId: "viewer-1",
      mode: "p2p-direct",
      state: "ready",
    });
    const resumed = await host.waitFor(
      (message) => message.type === "resume" && message.clientId === "viewer-1",
    );
    expect(resumed.type).toBe("resume");

    host.close();
    viewer.close();
  });

  it("only relays signals between the host and a viewer", async () => {
    const host = await openHost("signal-role");
    const viewer1 = await openViewer("signal-role", "viewer-1");
    const viewer2 = await openViewer("signal-role", "viewer-2");

    viewer1.send({
      v: 1,
      type: "signal",
      to: "viewer-2",
      from: "viewer-1",
      kind: "offer",
      payload: { sdp: "x" },
    });
    const error = await viewer1.waitFor(
      (message) => message.type === "error" && message.code === "invalid_role",
    );
    expect(error.code).toBe("invalid_role");
    await sleep(100);
    expect(viewer2.controls.some((message) => message.type === "signal")).toBe(false);

    viewer1.send({
      v: 1,
      type: "signal",
      to: "host-1",
      from: "viewer-1",
      kind: "answer",
      payload: { sdp: "y" },
    });
    const relayed = await host.waitFor((message) => message.type === "signal");
    expect(relayed.from).toBe("viewer-1");
    expect(relayed.to).toBe("host-1");

    host.send({
      v: 1,
      type: "signal",
      to: "viewer-1",
      from: "host-1",
      kind: "ice",
      payload: { candidate: "z" },
    });
    const toViewer = await viewer1.waitFor((message) => message.type === "signal");
    expect(toViewer.from).toBe("host-1");

    host.close();
    viewer1.close();
    viewer2.close();
  });

  it("rejects an oversized signal without forwarding it", async () => {
    const host = await openHost("oversized-signal");
    const viewer = await openViewer("oversized-signal", "viewer-1");

    viewer.send({
      v: 1,
      type: "signal",
      to: "host-1",
      from: "viewer-1",
      kind: "ice",
      payload: { candidate: "x".repeat(MAX_SIGNAL_PAYLOAD_BYTES) },
    });
    const error = await viewer.waitFor(
      (message) => message.type === "error" && message.code === "invalid_message",
    );
    expect(error.code).toBe("invalid_message");
    await sleep(100);
    expect(host.controls.some((message) => message.type === "signal")).toBe(false);

    host.close();
    viewer.close();
  });

  it("survives a deeply nested signal without forwarding it", async () => {
    const host = await openHost("deep-signal");
    const viewer = await openViewer("deep-signal", "viewer-1");
    const depth = 5_000;
    const raw = `{"v":1,"type":"signal","to":"host-1","from":"viewer-1","kind":"ice","payload":${"[".repeat(depth)}0${"]".repeat(depth)}}`;

    viewer.ws.send(raw);
    const error = await viewer.waitFor(
      (message) => message.type === "error" && message.code === "invalid_message",
    );
    expect(error.code).toBe("invalid_message");
    await sleep(100);
    expect(host.controls.some((message) => message.type === "signal")).toBe(false);

    host.close();
    viewer.close();
  });

  it("does not echo the host's own hello size back as a resize", async () => {
    const host = await openHost("host-hello-resize");
    await sleep(100);
    expect(host.controls.some((message) => message.type === "resize")).toBe(false);
    host.close();
  });

  it("forwards only viewer hello sizes to the host", async () => {
    const host = await openHost("viewer-hello-resize");
    const viewer = await connectWorker("viewer-hello-resize", { token: SESSION_TOKEN });
    viewer.send(helloFor("viewer-hello-resize", "viewer", "viewer-1", { cols: 120, rows: 40 }));
    await viewer.waitForType("welcome");

    const resize = await host.waitFor(
      (message) => message.type === "resize" && message.clientId === "viewer-1",
    );
    expect(resize.cols).toBe(120);
    expect(resize.rows).toBe(40);

    const observer = await connectDirect("viewer-hello-resize", {
      role: "observer",
      token: SESSION_TOKEN,
    });
    observer.send(
      helloFor("viewer-hello-resize", "observer", "observer-1", { cols: 90, rows: 20 }),
    );
    await observer.waitForType("welcome");
    await sleep(100);
    const observerResize = host.controls.find(
      (message) => message.type === "resize" && message.clientId === "observer-1",
    );
    expect(observerResize).toBeUndefined();

    host.close();
    viewer.close();
    observer.close();
  });

  it("rejects a resize whose cell count exceeds the limit", async () => {
    const host = await openHost("resize-cell-limit");
    const viewer = await openViewer("resize-cell-limit", "viewer-1");

    viewer.send({ v: 1, type: "resize", clientId: "viewer-1", cols: 10_000, rows: 10_000 });
    const error = await viewer.waitFor(
      (message) => message.type === "error" && message.code === "invalid_message",
    );
    expect(error.code).toBe("invalid_message");
    await sleep(100);
    expect(host.controls.some((message) => message.type === "resize")).toBe(false);

    host.close();
    viewer.close();
  });

  it("throttles viewer resizes and forwards the trailing size", async () => {
    const host = await openHost("resize-throttle");
    const viewer = await openViewer("resize-throttle", "viewer-1");

    viewer.send({ v: 1, type: "resize", clientId: "viewer-1", cols: 100, rows: 30 });
    viewer.send({ v: 1, type: "resize", clientId: "viewer-1", cols: 120, rows: 40 });
    const first = await host.waitFor((message) => message.type === "resize");
    expect(first.cols).toBe(100);
    await sleep(100);
    expect(host.controls.filter((message) => message.type === "resize")).toHaveLength(1);

    const trailing = await host.waitFor(
      (message) => message.type === "resize" && message.cols === 120,
      2_000,
    );
    expect(trailing.rows).toBe(40);

    host.close();
    viewer.close();
  });

  it("throttles resync requests and forwards the requesting client id", async () => {
    const host = await openHost("resync-throttle");
    const viewer = await openViewer("resync-throttle", "viewer-1");

    viewer.send({ v: 1, type: "resync", fromSeq: "1" });
    viewer.send({ v: 1, type: "resync", fromSeq: "2" });
    const first = await host.waitFor((message) => message.type === "resync");
    expect(first.clientId).toBe("viewer-1");
    await sleep(100);
    expect(host.controls.filter((message) => message.type === "resync")).toHaveLength(1);

    host.close();
    viewer.close();
  });

  it("converts a binary resync request into a targeted JSON resync", async () => {
    const host = await openHost("resync-binary");
    const viewer = await openViewer("resync-binary", "viewer-1");

    viewer.sendBinary(encodeFrame({ type: "resync_req" }));
    const request = await host.waitFor((message) => message.type === "resync");
    expect(request.clientId).toBe("viewer-1");
    await sleep(100);
    expect(host.binary).toHaveLength(0);

    host.close();
    viewer.close();
  });

  it("expires the session after the host-offline TTL", async () => {
    const sessionId = "ttl-expiry";
    const host = await openHost(sessionId);
    const viewer = await openViewer(sessionId, "viewer-1");
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
    await runInDurableObject(stub, (_instance: unknown, state: DurableObjectState) => {
      state.storage.sql.exec("UPDATE session_meta SET session_ttl_seconds = 1");
    });
    host.close();
    await viewer.waitFor((message) => message.type === "host" && message.online === false);
    await sleep(1_100);
    await runDurableObjectAlarm(stub);
    const closed = await viewer.waitForClose(6_000);
    expect(closed.code).toBe(4004);

    const lateViewer = await connectWorker(sessionId, { token: SESSION_TOKEN });
    lateViewer.send(helloFor(sessionId, "viewer", "viewer-2"));
    const error = await lateViewer.waitForType("error");
    expect(error.code).toBe("unauthorized");
    const lateClosed = await lateViewer.waitForClose();
    expect(lateClosed.code).toBe(4001);
  });

  it("keeps exactly one of two concurrent hellos with the same viewer client id", async () => {
    const sessionId = "concurrent-duplicate-viewer";
    const host = await openHost(sessionId);
    const first = await connectWorker(sessionId, { token: SESSION_TOKEN });
    const second = await connectWorker(sessionId, { token: SESSION_TOKEN });
    const decide = (socket: TestSocket) =>
      socket.waitFor((message) => message.type === "welcome" || message.type === "error");

    first.send(helloFor(sessionId, "viewer", "viewer-1"));
    second.send(helloFor(sessionId, "viewer", "viewer-1"));
    const results = await Promise.all([decide(first), decide(second)]);

    expect(results.filter((message) => message.type === "welcome")).toHaveLength(1);
    const errors = results.filter((message) => message.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("duplicate_client_id");

    host.close();
    first.close();
    second.close();
  });

  it("does not exceed the client cap under two concurrent viewer hellos", async () => {
    const sessionId = "concurrent-capacity";
    const host = await openHost(sessionId);
    const viewer1 = await openViewer(sessionId, "viewer-1");
    const first = await connectWorker(sessionId, { token: SESSION_TOKEN });
    const second = await connectWorker(sessionId, { token: SESSION_TOKEN });
    const decide = (socket: TestSocket) =>
      socket.waitFor((message) => message.type === "welcome" || message.type === "error");

    first.send(helloFor(sessionId, "viewer", "viewer-2"));
    second.send(helloFor(sessionId, "viewer", "viewer-3"));
    const results = await Promise.all([decide(first), decide(second)]);

    expect(results.filter((message) => message.type === "welcome")).toHaveLength(1);
    const errors = results.filter((message) => message.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("session_full");

    host.close();
    viewer1.close();
    first.close();
    second.close();
  });

  it("lets an authenticated host take over a viewer that squatted its client id", async () => {
    const sessionId = "host-takeover-viewer";
    const host = await openHost(sessionId);
    const viewer = await openViewer(sessionId, "viewer-1");
    host.close();
    await viewer.waitFor((message) => message.type === "host" && message.online === false);

    // A viewer may claim the host's client id while the host is offline.
    const squatter = await openViewer(sessionId, "host-1");

    const replacement = await connectWorker(sessionId, {
      hostToken: MASTER_TOKEN,
      token: SESSION_TOKEN,
    });
    replacement.send(helloFor(sessionId, "host", "host-1"));
    const welcome = await replacement.waitForType("welcome");
    expect(welcome.hostOnline).toBe(true);
    expect(welcome.clients).toEqual(
      expect.arrayContaining([expect.objectContaining({ clientId: "viewer-1" })]),
    );

    const error = await squatter.waitForType("error");
    expect(error.code).toBe("duplicate_client_id");
    const closed = await squatter.waitForClose();
    expect(closed.code).toBe(4003);

    replacement.sendBinary(outputFrame(7, "after-host-takeover"));
    const frame = decodeFrame(await viewer.waitForBinary());
    expect(frame.type).toBe("output");
    if (frame.type === "output") {
      expect(new TextDecoder().decode(frame.payload)).toBe("after-host-takeover");
    }

    replacement.close();
    viewer.close();
  });

  it("derives a namespace for root-created <namespace>.<slug> sessions", async () => {
    const named = await openHost("team-a.root-derived");
    const plain = await openHost("plain-root");
    const namedStub = env.SESSIONS.get(env.SESSIONS.idFromName("team-a.root-derived"));
    const plainStub = env.SESSIONS.get(env.SESSIONS.idFromName("plain-root"));
    const namedMeta = await runInDurableObject(namedStub, async (_instance, state) => {
      return state.storage.sql
        .exec<{ namespace_id: string | null }>("SELECT namespace_id FROM session_meta LIMIT 1")
        .toArray();
    });
    const plainMeta = await runInDurableObject(plainStub, async (_instance, state) => {
      return state.storage.sql
        .exec<{ namespace_id: string | null }>("SELECT namespace_id FROM session_meta LIMIT 1")
        .toArray();
    });
    expect(namedMeta[0]?.namespace_id).toBe("team-a");
    expect(plainMeta[0]?.namespace_id).toBeNull();
    named.close();
    plain.close();
  });
});
