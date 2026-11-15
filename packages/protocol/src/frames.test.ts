import { describe, expect, it } from "vitest";

import {
  MAX_DATACHANNEL_MESSAGE_BYTES,
  MAX_FRAME_BYTES,
  MAX_TARGET_ID_BYTES,
  PROTOCOL_VERSION,
} from "./constants.js";
import {
  type BinaryFrame,
  decodeFrame,
  detectFrameType,
  encodeFrame,
  FRAME_ERROR_CODES,
  FRAME_TYPE_NAMES,
  FRAME_TYPES,
  type FrameErrorCode,
  isKnownFrameType,
  isReservedFrame,
  isReservedFrameType,
  ProtocolFrameError,
} from "./frames.js";

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function fromHex(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "hex"));
}

function expectFrameError(fn: () => unknown, code: FrameErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolFrameError);
    expect((error as ProtocolFrameError).code).toBe(code);
    return;
  }
  throw new Error(`expected ProtocolFrameError(${code})`);
}

describe("frame constants", () => {
  it("defines the seven v1 frame bytes and the 1 MiB frame limit", () => {
    expect(FRAME_TYPES).toEqual({
      INPUT: 0x01,
      OUTPUT: 0x02,
      SNAPSHOT: 0x03,
      RESYNC_REQ: 0x04,
      SNAPSHOT_TO: 0x05,
      TUNNEL: 0x06,
      TUNNEL_TO: 0x07,
    });
    expect(PROTOCOL_VERSION).toBe(1);
    expect(MAX_FRAME_BYTES).toBe(1_048_576);
    expect(MAX_DATACHANNEL_MESSAGE_BYTES).toBe(16_384);
    expect(FRAME_ERROR_CODES).toHaveLength(6);
  });

  it("names every known frame type and classifies reserved frames", () => {
    expect(FRAME_TYPE_NAMES[FRAME_TYPES.INPUT]).toBe("INPUT");
    expect(FRAME_TYPE_NAMES[FRAME_TYPES.SNAPSHOT_TO]).toBe("SNAPSHOT_TO");
    for (const type of Object.values(FRAME_TYPES)) {
      expect(isKnownFrameType(type)).toBe(true);
    }
    expect(isKnownFrameType(0x00)).toBe(false);
    expect(isKnownFrameType(0x08)).toBe(false);
    expect(isKnownFrameType(0x7f)).toBe(false);
    expect(isReservedFrameType(FRAME_TYPES.TUNNEL)).toBe(true);
    expect(isReservedFrameType(FRAME_TYPES.TUNNEL_TO)).toBe(true);
    expect(isReservedFrameType(FRAME_TYPES.OUTPUT)).toBe(false);
  });

  it("detects a type byte without decoding the frame", () => {
    expect(detectFrameType(fromHex("01"))).toBe(FRAME_TYPES.INPUT);
    expect(detectFrameType(fromHex("05ff"))).toBe(FRAME_TYPES.SNAPSHOT_TO);
    expect(detectFrameType(new Uint8Array())).toBeNull();
    expect(detectFrameType(fromHex("7f"))).toBe(0x7f);
  });
});

describe("frame roundtrips", () => {
  const frames: BinaryFrame[] = [
    { type: "input", payload: new Uint8Array() },
    { type: "input", payload: Uint8Array.of(0x00, 0xff, 0x0a, 0x68, 0x69) },
    { type: "output", seq: 0, payload: new Uint8Array() },
    { type: "output", seq: 42, payload: fromHex("1b5b33316d5245441b5b306d0d0a") },
    { type: "output", seq: Number.MAX_SAFE_INTEGER, payload: Uint8Array.of(0xff) },
    { type: "snapshot", seq: 7, payload: fromHex("1b5b3f3130343968") },
    { type: "resync_req" },
    { type: "snapshot_to", targetId: "client-1", seq: 123, payload: new Uint8Array() },
    {
      type: "snapshot_to",
      targetId: "é".repeat(32),
      seq: Number.MAX_SAFE_INTEGER,
      payload: Uint8Array.of(0x00, 0xff),
    },
    { type: "tunnel", payload: fromHex("deadbeef") },
    { type: "tunnel_to", targetId: "viewer-1", payload: Uint8Array.of(1, 2) },
  ];

  for (const frame of frames) {
    it(`roundtrips ${frame.type}`, () => {
      const encoded = encodeFrame(frame);
      expect(decodeFrame(encoded)).toEqual(frame);
    });
  }

  it("is deterministic and big-endian for u64 sequence numbers", () => {
    expect(toHex(encodeFrame({ type: "output", seq: 1, payload: new Uint8Array() }))).toBe(
      "020000000000000001",
    );
    expect(
      toHex(encodeFrame({ type: "snapshot", seq: 0x01020304, payload: new Uint8Array() })),
    ).toBe("030000000001020304");
  });

  it("identifies reserved tunnel frames after decoding", () => {
    const tunnel = decodeFrame(encodeFrame({ type: "tunnel", payload: Uint8Array.of(0x42) }));
    expect(tunnel.type).toBe("tunnel");
    expect(isReservedFrame(tunnel)).toBe(true);

    const tunnelTo = decodeFrame(
      encodeFrame({ type: "tunnel_to", targetId: "viewer-1", payload: Uint8Array.of(0x42) }),
    );
    expect(tunnelTo.type).toBe("tunnel_to");
    expect(isReservedFrame(tunnelTo)).toBe(true);

    const input = decodeFrame(encodeFrame({ type: "input", payload: new Uint8Array() }));
    expect(isReservedFrame(input)).toBe(false);
  });

  it("copies payloads instead of aliasing caller or wire buffers", () => {
    const source = Uint8Array.of(1, 2, 3);
    const encoded = encodeFrame({ type: "output", seq: 5, payload: source });
    source[0] = 9;

    const decoded = decodeFrame(encoded);
    encoded[9] = 0xee;

    expect(decoded).toEqual({ type: "output", seq: 5, payload: Uint8Array.of(1, 2, 3) });
  });

  it("decodes from Uint8Array views with a non-zero byteOffset", () => {
    const backing = Uint8Array.of(0xaa, 0xbb, 0x01, 0x68, 0x69);
    expect(decodeFrame(backing.subarray(2))).toEqual({
      type: "input",
      payload: Uint8Array.of(0x68, 0x69),
    });
  });
});

describe("frame limits and malformed input", () => {
  it("rejects sequences that are negative, fractional, or unsafe", () => {
    for (const seq of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expectFrameError(
        () => encodeFrame({ type: "output", seq, payload: new Uint8Array() }),
        "invalid_seq",
      );
    }
  });

  it("rejects an on-wire u64 above Number.MAX_SAFE_INTEGER", () => {
    expectFrameError(() => decodeFrame(fromHex("020020000000000000")), "invalid_seq");
  });

  it("accepts empty payloads for data frames", () => {
    for (const frame of [
      { type: "input", payload: new Uint8Array() },
      { type: "output", seq: 0, payload: new Uint8Array() },
      { type: "snapshot", seq: 0, payload: new Uint8Array() },
    ] satisfies BinaryFrame[]) {
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    }
  });

  it("enforces target id length in UTF-8 bytes", () => {
    expect(() =>
      encodeFrame({ type: "snapshot_to", targetId: "a", seq: 0, payload: new Uint8Array() }),
    ).not.toThrow();
    expect(() =>
      encodeFrame({
        type: "snapshot_to",
        targetId: "a".repeat(MAX_TARGET_ID_BYTES),
        seq: 0,
        payload: new Uint8Array(),
      }),
    ).not.toThrow();
    for (const targetId of ["", "a".repeat(MAX_TARGET_ID_BYTES + 1), "é".repeat(33), "\uD800"]) {
      expectFrameError(
        () => encodeFrame({ type: "snapshot_to", targetId, seq: 0, payload: new Uint8Array() }),
        "invalid_target_id",
      );
    }
    expect(() =>
      encodeFrame({
        type: "snapshot_to",
        targetId: "é".repeat(32),
        seq: 0,
        payload: new Uint8Array(),
      }),
    ).not.toThrow();
  });

  it("rejects truncated frames", () => {
    expectFrameError(() => decodeFrame(new Uint8Array()), "frame_truncated");
    expectFrameError(() => decodeFrame(fromHex("02")), "frame_truncated");
    expectFrameError(() => decodeFrame(fromHex("0200000000000000")), "frame_truncated");
    expectFrameError(() => decodeFrame(fromHex("03")), "frame_truncated");
    expectFrameError(() => decodeFrame(fromHex("05")), "frame_truncated");
    expectFrameError(() => decodeFrame(fromHex("0505636c69")), "frame_truncated");
    expectFrameError(() => decodeFrame(fromHex("0508636c69656e742d31")), "frame_truncated");
  });

  it("rejects invalid target lengths and invalid UTF-8 on decode", () => {
    expectFrameError(() => decodeFrame(fromHex("05000000000000000000")), "invalid_target_id");
    expectFrameError(() => decodeFrame(fromHex("0541")), "invalid_target_id");
    expectFrameError(() => decodeFrame(fromHex("0501ff0000000000000000")), "invalid_target_id");
  });

  it("requires RESYNC_REQ to be exactly one byte", () => {
    expect(toHex(encodeFrame({ type: "resync_req" }))).toBe("04");
    expectFrameError(() => decodeFrame(fromHex("0400")), "invalid_frame");
  });

  it("rejects unknown frame type bytes", () => {
    expectFrameError(() => decodeFrame(fromHex("00")), "unknown_frame_type");
    expectFrameError(() => decodeFrame(fromHex("08")), "unknown_frame_type");
    expectFrameError(() => decodeFrame(fromHex("7f00")), "unknown_frame_type");
  });

  it("accepts exactly 1 MiB and rejects anything larger", () => {
    const maxPayload = new Uint8Array(MAX_FRAME_BYTES - 1);
    maxPayload[0] = 0x41;
    const encoded = encodeFrame({ type: "input", payload: maxPayload });
    expect(encoded.byteLength).toBe(MAX_FRAME_BYTES);
    expect(decodeFrame(encoded).type).toBe("input");

    expectFrameError(
      () => encodeFrame({ type: "input", payload: new Uint8Array(MAX_FRAME_BYTES) }),
      "frame_too_large",
    );

    const oversize = new Uint8Array(MAX_FRAME_BYTES + 1);
    oversize[0] = FRAME_TYPES.INPUT;
    expectFrameError(() => decodeFrame(oversize), "frame_too_large");
  });

  it("rejects non-Uint8Array inputs", () => {
    expectFrameError(() => decodeFrame("not-bytes" as unknown as Uint8Array), "invalid_frame");
    expectFrameError(
      () =>
        encodeFrame({
          type: "input",
          payload: "not-bytes",
        } as unknown as BinaryFrame),
      "invalid_frame",
    );
  });
});
