import {
  decodeFrame,
  encodeFrame,
  TUNNEL_INPUT_PAYLOAD_MAX_BYTES,
  type TunnelKeyMode,
} from "@limccn/tokimeki-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Logger } from "../../logger.js";
import { TunnelTransport } from "./tunnel-transport.js";

const logger = new Logger({ level: "silent", write: () => {} });
const SESSION_ID = "demo-session";
const SESSION_TOKEN = "session-token-1234";
const SHARED_SECRET = "0123456789abcdef";

let nowMs = 0;
const now = (): number => nowMs;

function advance(ms: number): void {
  nowMs += ms;
  vi.advanceTimersByTime(ms);
}

function counterNonce(start: number): (size: number) => Uint8Array {
  let counter = start;
  return (size) => {
    const nonce = new Uint8Array(size);
    nonce[0] = counter & 0xff;
    nonce[1] = (counter >>> 8) & 0xff;
    counter += 1;
    return nonce;
  };
}

interface Harness {
  readonly host: TunnelTransport;
  readonly viewer: TunnelTransport;
  readonly hostToViewer: Uint8Array[];
  readonly viewerToHost: Uint8Array[];
  readonly hostFrames: Uint8Array[];
  readonly viewerFrames: Uint8Array[];
  readonly hostFailures: string[];
  readonly viewerFailures: string[];
  pump(): void;
}

function payloadOf(frame: Uint8Array): Uint8Array {
  const decoded = decodeFrame(frame);
  if (decoded.type !== "tunnel") throw new Error("expected a tunnel frame");
  return decoded.payload;
}

function makeHarness(
  options: {
    hostKeyMode?: TunnelKeyMode;
    viewerKeyMode?: TunnelKeyMode;
    viewerMaxOutboundBytes?: number;
  } = {},
): Harness {
  const hostToViewer: Uint8Array[] = [];
  const viewerToHost: Uint8Array[] = [];
  const hostFrames: Uint8Array[] = [];
  const viewerFrames: Uint8Array[] = [];
  const hostFailures: string[] = [];
  const viewerFailures: string[] = [];

  const host = new TunnelTransport({
    role: "host",
    sessionId: SESSION_ID,
    sessionToken: SESSION_TOKEN,
    keyMode: options.hostKeyMode ?? "session-token",
    logger,
    sendFrame: (bytes) => {
      hostToViewer.push(payloadOf(bytes));
      return true;
    },
    onFrame: (bytes) => hostFrames.push(bytes),
    onFailure: (reason) => hostFailures.push(reason),
    nonceSource: counterNonce(1),
    now,
  });
  const viewer = new TunnelTransport({
    role: "viewer",
    sessionId: SESSION_ID,
    sessionToken: SESSION_TOKEN,
    keyMode: options.viewerKeyMode ?? "session-token",
    secret:
      (options.viewerKeyMode ?? "session-token") === "shared-secret" ? SHARED_SECRET : undefined,
    logger,
    sendFrame: (bytes) => {
      viewerToHost.push(payloadOf(bytes));
      return true;
    },
    onFrame: (bytes) => viewerFrames.push(bytes),
    onFailure: (reason) => viewerFailures.push(reason),
    nonceSource: counterNonce(1000),
    now,
    maxOutboundBytes: options.viewerMaxOutboundBytes,
  });

  const pump = (): void => {
    for (let passes = 0; passes < 10; passes += 1) {
      let moved = false;
      while (hostToViewer.length > 0) {
        const record = hostToViewer.shift();
        if (record !== undefined) {
          viewer.receive(record);
          moved = true;
        }
      }
      while (viewerToHost.length > 0) {
        const record = viewerToHost.shift();
        if (record !== undefined) {
          host.receive(record);
          moved = true;
        }
      }
      if (!moved) return;
    }
  };

  return {
    host,
    viewer,
    hostToViewer,
    viewerToHost,
    hostFrames,
    viewerFrames,
    hostFailures,
    viewerFailures,
    pump,
  };
}

function outputFrame(seq: number, payload = `frame-${seq}`): Uint8Array {
  return encodeFrame({ type: "output", seq, payload: new TextEncoder().encode(payload) });
}

beforeEach(() => {
  vi.useFakeTimers();
  nowMs = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TunnelTransport", () => {
  it("delivers host output frames in order", () => {
    const harness = makeHarness();
    expect(harness.host.send(outputFrame(0))).toBe(true);
    expect(harness.host.send(outputFrame(1))).toBe(true);
    harness.pump();

    expect(harness.viewerFrames.map((frame) => decodeFrame(frame).type)).toEqual([
      "output",
      "output",
    ]);
    expect(harness.host.pendingCount).toBe(0);
    expect(harness.viewerFailures).toEqual([]);
    expect(harness.hostFailures).toEqual([]);
  });

  it("delivers viewer input frames in order", () => {
    const harness = makeHarness();
    expect(
      harness.viewer.send(encodeFrame({ type: "input", payload: new TextEncoder().encode("abc") })),
    ).toBe(true);
    harness.pump();
    expect(harness.hostFrames).toHaveLength(1);
    const decoded = decodeFrame(harness.hostFrames[0] ?? new Uint8Array());
    expect(decoded.type).toBe("input");
    expect(new TextDecoder().decode(decoded.type === "input" ? decoded.payload : undefined)).toBe(
      "abc",
    );
  });

  it("reorders out-of-order records before delivery", () => {
    const harness = makeHarness();
    harness.host.send(outputFrame(0));
    harness.host.send(outputFrame(1));
    const [first, second] = harness.hostToViewer.splice(0);
    if (first === undefined || second === undefined) throw new Error("expected two records");
    harness.viewer.receive(second);
    expect(harness.viewerFrames).toEqual([]);
    harness.viewer.receive(first);
    harness.pump();
    expect(harness.viewerFrames).toHaveLength(2);
    expect(harness.viewerFrames.map((frame) => decodeFrame(frame).type)).toEqual([
      "output",
      "output",
    ]);
  });

  it("retransmits a lost record after the RTO", () => {
    const harness = makeHarness();
    harness.host.send(outputFrame(0));
    harness.host.send(outputFrame(1));
    // Drop the first record, deliver the second, then let the sender time out.
    harness.hostToViewer.splice(0, 1);
    harness.pump();
    expect(harness.viewerFrames).toHaveLength(0);
    advance(200);
    expect(harness.hostToViewer.length).toBeGreaterThan(0);
    harness.pump();
    expect(harness.viewerFrames).toHaveLength(2);
    expect(harness.host.pendingCount).toBe(0);
  });

  it("re-ACKs a duplicate after a lost ACK", () => {
    const harness = makeHarness();
    harness.host.send(outputFrame(0));
    harness.pump();
    expect(harness.viewerFrames).toHaveLength(1);
    expect(harness.host.pendingCount).toBe(0);

    // Replay the original record: the receiver must ACK it again without
    // delivering it twice.
    harness.host.send(outputFrame(1));
    const duplicate = harness.hostToViewer[0];
    if (duplicate === undefined) throw new Error("expected a record");
    harness.viewer.receive(duplicate);
    expect(harness.viewerFrames).toHaveLength(2);
    harness.viewer.receive(duplicate);
    expect(harness.viewerFrames).toHaveLength(2);
    harness.pump();
    expect(harness.host.pendingCount).toBe(0);
  });

  it("fails closed when the peer uses a different key mode", () => {
    const harness = makeHarness({ hostKeyMode: "session-token", viewerKeyMode: "shared-secret" });
    for (let index = 0; index < 16; index += 1) {
      harness.host.send(outputFrame(index));
      harness.pump();
    }
    expect(harness.viewerFailures).toEqual(["decrypt_failed"]);
    expect(harness.viewerFrames).toEqual([]);
  });

  it("rejects frames larger than one tunnel record", () => {
    const harness = makeHarness();
    expect(harness.host.send(new Uint8Array(16_340))).toBe(false);
    expect(harness.hostFailures).toEqual(["frame_too_large"]);
  });

  it("splits large terminal input into tunnel-sized INPUT frames", () => {
    const harness = makeHarness();
    const input = new Uint8Array(TUNNEL_INPUT_PAYLOAD_MAX_BYTES * 2 + 10).fill(0x41);
    expect(harness.viewer.sendTerminalInput(input)).toBe(true);
    harness.pump();
    expect(harness.hostFrames).toHaveLength(3);
    const payload = Buffer.concat(
      harness.hostFrames.map((frame) => {
        const decoded = decodeFrame(frame);
        if (decoded.type !== "input") throw new Error("expected input");
        return Buffer.from(decoded.payload);
      }),
    );
    expect(payload).toEqual(Buffer.from(input));
  });

  it("fails oversized terminal input before any chunk is handed to the tunnel", () => {
    const harness = makeHarness({ viewerMaxOutboundBytes: 4_096 });
    const input = new Uint8Array(8_192).fill(0x41);
    expect(harness.viewer.sendTerminalInput(input)).toBe(false);
    expect(harness.viewerFailures).toEqual(["outbound_queue_full"]);
    // Nothing may be transmitted: the caller resends the whole payload over the
    // relay, so a partial tunnel send would duplicate the input.
    expect(harness.viewerToHost).toHaveLength(0);
  });

  it("queues frames beyond the ARQ window and drains them in order", () => {
    const harness = makeHarness();
    const count = 100;
    for (let seq = 0; seq < count; seq += 1) {
      expect(harness.host.send(outputFrame(seq))).toBe(true);
    }
    harness.pump();
    expect(harness.viewerFrames).toHaveLength(count);
    const outputSeqs = harness.viewerFrames.map((frame) => {
      const decoded = decodeFrame(frame);
      if (decoded.type !== "output") throw new Error("expected output");
      return decoded.seq;
    });
    expect(outputSeqs).toEqual(Array.from({ length: count }, (_value, index) => index));
  });

  it("fails closed when the bounded outbound queue is exhausted", () => {
    const harness = makeHarness();
    let accepted = true;
    for (let seq = 0; accepted && seq < 400; seq += 1) {
      accepted = harness.host.send(outputFrame(seq, "x".repeat(16_300)));
    }
    expect(accepted).toBe(false);
    expect(harness.hostFailures).toContain("outbound_queue_full");
  });

  it("reports stats and disposes timers", () => {
    const harness = makeHarness();
    harness.host.send(outputFrame(0));
    harness.pump();
    expect(harness.host.stats.sentRecords).toBeGreaterThan(0);
    expect(harness.viewer.stats.receivedRecords).toBeGreaterThan(0);
    harness.host.dispose();
    harness.viewer.dispose();
    advance(10_000);
    expect(harness.hostFailures).toEqual([]);
  });
});
