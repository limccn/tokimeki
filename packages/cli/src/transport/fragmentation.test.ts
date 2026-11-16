import {
  encodeFrame,
  FRAGMENT_HEADER_BYTES,
  type FrameErrorCode,
  MAX_DATACHANNEL_MESSAGE_BYTES,
  MAX_FRAGMENT_CHUNK_BYTES,
  MAX_FRAGMENT_COUNT,
  MAX_FRAME_BYTES,
  ProtocolFrameError,
} from "@limccn/tokimeki-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Logger } from "../logger.js";
import {
  FRAGMENT_REASSEMBLY_TIMEOUT_MS,
  FragmentReassembler,
  fragmentFrame,
  MAX_CONCURRENT_REASSEMBLIES,
  sendFragments,
} from "./fragmentation.js";

const logger = new Logger({ level: "silent", write: () => {} });

function snapshotFrame(payloadBytes: number): Uint8Array {
  return encodeFrame({
    type: "snapshot",
    seq: 7,
    payload: new Uint8Array(payloadBytes).fill(0x41),
  });
}

function fragmentFor(
  messageId: number,
  totalBytes: number,
  fragmentIndex = 0,
  fragmentCount = MAX_FRAGMENT_COUNT,
): Uint8Array {
  return encodeFrame({
    type: "fragment",
    messageId,
    fragmentIndex,
    fragmentCount,
    totalBytes,
    payload: new Uint8Array(MAX_FRAGMENT_CHUNK_BYTES),
  });
}

function expectFrameError(fn: () => unknown, code: FrameErrorCode = "invalid_frame"): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolFrameError);
    expect((error as ProtocolFrameError).code).toBe(code);
    return;
  }
  throw new Error(`expected ProtocolFrameError(${code})`);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("fragmentFrame / sendFragments", () => {
  it("splits a large frame into canonical DataChannel-sized messages", () => {
    const frame = snapshotFrame(MAX_FRAGMENT_CHUNK_BYTES + 100);
    const fragments = fragmentFrame(frame, 1);

    expect(fragments).toHaveLength(2);
    for (const fragment of fragments) {
      expect(fragment.byteLength).toBeLessThanOrEqual(MAX_DATACHANNEL_MESSAGE_BYTES);
      expect(fragment[0]).toBe(0x08);
      expect(fragment.byteLength - FRAGMENT_HEADER_BYTES).toBeGreaterThan(0);
    }
    expect(fragments[0]?.byteLength).toBe(MAX_DATACHANNEL_MESSAGE_BYTES);
  });

  it("sends small frames directly and large frames as fragments", () => {
    const small = snapshotFrame(10);
    const directCalls: Uint8Array[] = [];
    expect(
      sendFragments(
        (bytes) => {
          directCalls.push(bytes);
          return true;
        },
        small,
        3,
      ),
    ).toBe(true);
    expect(directCalls).toEqual([small]);

    const large = snapshotFrame(MAX_FRAGMENT_CHUNK_BYTES + 100);
    const sent: Uint8Array[] = [];
    expect(
      sendFragments(
        (bytes) => {
          sent.push(bytes);
          return true;
        },
        large,
        4,
      ),
    ).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent.every((bytes) => bytes.byteLength <= MAX_DATACHANNEL_MESSAGE_BYTES)).toBe(true);
  });

  it("returns false when send fails or throws", () => {
    const large = snapshotFrame(MAX_FRAGMENT_CHUNK_BYTES + 100);
    expect(sendFragments(() => false, large, 5)).toBe(false);
    expect(
      sendFragments(
        () => {
          throw new Error("send failed");
        },
        large,
        6,
      ),
    ).toBe(false);
  });

  it("rejects empty, oversized, nested, and invalid message ids", () => {
    const frame = snapshotFrame(10);
    expectFrameError(() => fragmentFrame(new Uint8Array(), 1));
    expectFrameError(() => fragmentFrame(snapshotFrame(MAX_FRAME_BYTES), 1), "frame_too_large");
    expectFrameError(() => fragmentFrame(frame, 0));
    expectFrameError(() => fragmentFrame(frame, 0x1_0000_0000));

    const nested = encodeFrame({
      type: "fragment",
      messageId: 1,
      fragmentIndex: 0,
      fragmentCount: 1,
      totalBytes: 1,
      payload: Uint8Array.of(0x42),
    });
    expectFrameError(() => fragmentFrame(nested, 1));
  });
});

describe("FragmentReassembler", () => {
  it("reassembles out-of-order fragments byte-exactly", () => {
    const frame = snapshotFrame(MAX_FRAGMENT_CHUNK_BYTES + 100);
    const fragments = fragmentFrame(frame, 11);
    const reassembler = new FragmentReassembler({ logger });

    let complete: Uint8Array | null = null;
    for (const fragment of [...fragments].reverse()) {
      complete = reassembler.accept(fragment) ?? complete;
    }
    expect(complete).toEqual(frame);
    expect(reassembler.transferCount).toBe(0);
  });

  it("ignores an identical duplicate and drops a conflicting duplicate", () => {
    const frame = snapshotFrame(MAX_FRAGMENT_CHUNK_BYTES + 100);
    const fragments = fragmentFrame(frame, 12);
    const [first, second] = fragments;
    if (first === undefined || second === undefined) throw new Error("expected two fragments");

    const reassembler = new FragmentReassembler({ logger });
    expect(reassembler.accept(first)).toBeNull();
    expect(reassembler.accept(first)).toBeNull();

    const conflicting = first.slice();
    conflicting[FRAGMENT_HEADER_BYTES] = 0x99;
    expect(reassembler.accept(conflicting)).toBeNull();
    expect(reassembler.transferCount).toBe(0);
    expect(reassembler.accept(second)).toBeNull();
  });

  it("expires incomplete transfers", () => {
    vi.useFakeTimers();
    const frame = snapshotFrame(MAX_FRAGMENT_CHUNK_BYTES + 100);
    const fragments = fragmentFrame(frame, 13);
    const first = fragments[0];
    if (first === undefined) throw new Error("expected a fragment");

    const reassembler = new FragmentReassembler({ logger });
    expect(reassembler.accept(first)).toBeNull();
    expect(reassembler.transferCount).toBe(1);
    vi.advanceTimersByTime(FRAGMENT_REASSEMBLY_TIMEOUT_MS + 1);
    expect(reassembler.transferCount).toBe(0);
  });

  it("bounds concurrent reassemblies and evicts the oldest", () => {
    const reassembler = new FragmentReassembler({ logger });
    for (let messageId = 1; messageId <= MAX_CONCURRENT_REASSEMBLIES + 1; messageId += 1) {
      reassembler.accept(fragmentFor(messageId, MAX_FRAME_BYTES));
    }
    expect(reassembler.transferCount).toBeLessThanOrEqual(MAX_CONCURRENT_REASSEMBLIES);
  });

  it("drops reassembled frames that are themselves FRAGMENT frames", () => {
    const inner = encodeFrame({
      type: "fragment",
      messageId: 21,
      fragmentIndex: 0,
      fragmentCount: 1,
      totalBytes: 1,
      payload: Uint8Array.of(0x42),
    });
    const outer = encodeFrame({
      type: "fragment",
      messageId: 22,
      fragmentIndex: 0,
      fragmentCount: 1,
      totalBytes: inner.byteLength,
      payload: inner,
    });

    const reassembler = new FragmentReassembler({ logger });
    expect(reassembler.accept(outer)).toBeNull();
    expect(reassembler.transferCount).toBe(0);
  });

  it("ignores non-fragment and malformed messages", () => {
    const reassembler = new FragmentReassembler({ logger });
    expect(
      reassembler.accept(encodeFrame({ type: "input", payload: Uint8Array.of(0x41) })),
    ).toBeNull();
    expect(reassembler.accept(new Uint8Array())).toBeNull();
    expect(reassembler.transferCount).toBe(0);
  });
});
