import {
  decodeFrame,
  decodeTunnelRecord,
  encodeFrame,
  TUNNEL_FLAG_FEC_PARITY,
  TUNNEL_INPUT_PAYLOAD_MAX_BYTES,
  type TunnelKeyMode,
} from "@limccn/tokimeki-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Logger } from "../../logger.js";
import type { TunnelFecMode } from "./capability.js";
import { deriveTunnelKeys, TunnelCipher } from "./crypto.js";
import { encodeXorFecGroup, TUNNEL_FEC_INPUT_PAYLOAD_MAX_BYTES } from "./fec.js";
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
    hostFec?: TunnelFecMode;
    viewerFec?: TunnelFecMode;
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
    fec: options.hostFec ?? "none",
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
    fec: options.viewerFec ?? "none",
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

type TunnelHeader = ReturnType<typeof decodeTunnelRecord>["header"];

function headers(records: readonly Uint8Array[]): TunnelHeader[] {
  return records.map((record) => decodeTunnelRecord(record).header);
}

function dropRecord(records: Uint8Array[], predicate: (header: TunnelHeader) => boolean): void {
  const index = records.findIndex((record) => predicate(decodeTunnelRecord(record).header));
  if (index < 0) throw new Error("expected tunnel record not found");
  records.splice(index, 1);
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

describe("TunnelTransport XOR FEC", () => {
  const GROUP = 8;

  function sendGroup(harness: Harness): Uint8Array[] {
    const frames: Uint8Array[] = [];
    for (let seq = 0; seq < GROUP; seq += 1) {
      const frame = outputFrame(seq, `fec-frame-${seq}`);
      frames.push(frame);
      expect(harness.host.send(frame)).toBe(true);
    }
    return frames;
  }

  it("emits one parity record per full group when XOR is enabled", () => {
    const harness = makeHarness({ hostFec: "xor" });
    const frames = sendGroup(harness);
    const fecRecords = headers(harness.hostToViewer).filter((header) => header.type === "fec");
    expect(fecRecords).toHaveLength(1);
    expect((fecRecords[0]?.flags ?? 0) & TUNNEL_FLAG_FEC_PARITY).toBe(TUNNEL_FLAG_FEC_PARITY);
    expect(fecRecords[0]?.seq).toBe(0);
    expect(harness.host.stats.fecGroupsSent).toBe(1);

    harness.pump();
    expect(harness.viewerFrames).toEqual(frames);
    expect(harness.viewerFailures).toEqual([]);
  });

  it("recovers a single dropped data record from parity before the ARQ timeout", () => {
    const harness = makeHarness({ hostFec: "xor", viewerFec: "xor" });
    const frames = sendGroup(harness);
    dropRecord(harness.hostToViewer, (header) => header.type === "data" && header.seq === 3);
    harness.pump();

    expect(harness.viewerFrames).toEqual(frames);
    expect(harness.viewer.stats.fecRecovered).toBe(1);
    expect(harness.viewer.stats.retransmits).toBe(0);
    expect(harness.viewerFailures).toEqual([]);
    expect(harness.host.pendingCount).toBe(0);
  });

  it("falls back to ARQ when the parity record is lost", () => {
    const harness = makeHarness({ hostFec: "xor", viewerFec: "xor" });
    sendGroup(harness);
    dropRecord(harness.hostToViewer, (header) => header.type === "data" && header.seq === 3);
    dropRecord(harness.hostToViewer, (header) => header.type === "fec");
    harness.pump();
    expect(harness.viewerFrames).toHaveLength(3);
    expect(harness.viewer.stats.fecRecovered).toBe(0);

    advance(200);
    harness.pump();
    expect(harness.viewerFrames).toHaveLength(GROUP);
    expect(harness.host.stats.retransmits).toBeGreaterThan(0);
  });

  it("does not recover when more than one record is missing", () => {
    const harness = makeHarness({ hostFec: "xor", viewerFec: "xor" });
    sendGroup(harness);
    dropRecord(harness.hostToViewer, (header) => header.type === "data" && header.seq === 2);
    dropRecord(harness.hostToViewer, (header) => header.type === "data" && header.seq === 5);
    harness.pump();
    expect(harness.viewerFrames).toHaveLength(2);
    expect(harness.viewer.stats.fecRecovered).toBe(0);

    advance(200);
    harness.pump();
    expect(harness.viewerFrames).toHaveLength(GROUP);
  });

  it("sends no parity records when FEC is off", () => {
    const harness = makeHarness();
    const frames = sendGroup(harness);
    expect(headers(harness.hostToViewer).some((header) => header.type === "fec")).toBe(false);
    harness.pump();
    expect(harness.viewerFrames).toEqual(frames);
  });

  it("accepts peer parity while sending without FEC", () => {
    const harness = makeHarness({ hostFec: "xor", viewerFec: "none" });
    const frames = sendGroup(harness);
    expect(harness.viewer.fec).toBe("none");
    dropRecord(harness.hostToViewer, (header) => header.type === "data" && header.seq === 4);
    harness.pump();
    expect(harness.viewerFrames).toEqual(frames);
    expect(harness.viewer.stats.fecRecovered).toBe(1);
  });

  it("splits FEC-enabled input at the parity-safe frame size", () => {
    const harness = makeHarness({ viewerFec: "xor" });
    const input = new Uint8Array(TUNNEL_FEC_INPUT_PAYLOAD_MAX_BYTES + 10).fill(0x42);
    expect(harness.viewer.sendTerminalInput(input)).toBe(true);
    harness.pump();
    expect(harness.hostFrames).toHaveLength(2);
    const payload = Buffer.concat(
      harness.hostFrames.map((frame) => {
        const decoded = decodeFrame(frame);
        if (decoded.type !== "input") throw new Error("expected input");
        return Buffer.from(decoded.payload);
      }),
    );
    expect(payload).toEqual(Buffer.from(input));
  });

  it("drops malformed or unauthenticated parity without delivering frames", () => {
    const harness = makeHarness();
    const keys = deriveTunnelKeys({
      keyMode: "session-token",
      sessionId: SESSION_ID,
      sessionToken: SESSION_TOKEN,
    });
    const cipher = new TunnelCipher({
      keys,
      sendDirection: "hostToViewer",
      sessionId: SESSION_ID,
      nonceSource: counterNonce(9000),
    });
    const validGroup = encodeXorFecGroup({
      startSeq: 0,
      count: 1,
      lengths: [1],
      parity: new Uint8Array([7]),
    });

    // Count 0 is invalid metadata.
    harness.viewer.receive(
      cipher.seal({
        type: "fec",
        flags: TUNNEL_FLAG_FEC_PARITY,
        seq: 0,
        plaintext: new Uint8Array(6),
      }),
    );
    expect(harness.viewer.stats.fecParityDropped).toBe(1);

    // A parity record without the parity flag is ignored.
    harness.viewer.receive(cipher.seal({ type: "fec", flags: 0, seq: 0, plaintext: validGroup }));
    expect(harness.viewer.stats.fecParityDropped).toBe(2);

    // Header seq and metadata startSeq must agree.
    harness.viewer.receive(
      cipher.seal({
        type: "fec",
        flags: TUNNEL_FLAG_FEC_PARITY,
        seq: 0,
        plaintext: encodeXorFecGroup({
          startSeq: 5,
          count: 1,
          lengths: [1],
          parity: new Uint8Array([7]),
        }),
      }),
    );
    expect(harness.viewer.stats.fecParityDropped).toBe(3);

    // A tampered parity record fails AEAD and changes no FEC state.
    const sealed = cipher.seal({
      type: "fec",
      flags: TUNNEL_FLAG_FEC_PARITY,
      seq: 0,
      plaintext: validGroup,
    });
    const tampered = new Uint8Array(sealed);
    tampered[tampered.byteLength - 1] = (tampered[tampered.byteLength - 1] ?? 0) ^ 0xff;
    harness.viewer.receive(tampered);
    expect(harness.viewer.stats.decryptFailures).toBe(1);
    expect(harness.viewer.stats.fecParityDropped).toBe(3);
    expect(harness.viewerFrames).toEqual([]);
    expect(harness.viewerFailures).toEqual([]);
  });
});
