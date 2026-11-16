import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SelectiveRepeatReceiver, SelectiveRepeatSender, type SenderRecord } from "./arq.js";

let nowMs = 0;
const now = (): number => nowMs;

function advance(ms: number): void {
  nowMs += ms;
  vi.advanceTimersByTime(ms);
}

function bytes(value: number, size = 4): Uint8Array {
  return new Uint8Array(size).fill(value & 0xff);
}

beforeEach(() => {
  vi.useFakeTimers();
  nowMs = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SelectiveRepeatReceiver", () => {
  it("delivers in order and advances the cumulative ack", () => {
    const receiver = new SelectiveRepeatReceiver({ onFailure: () => {} });
    const first = receiver.accept(0, bytes(0));
    expect(first?.delivered).toHaveLength(1);
    expect(first?.ack).toEqual({ ackSeq: 1, ackBits: 0 });
    expect(first?.shouldAck).toBe(true);

    const second = receiver.accept(1, bytes(1));
    expect(second?.delivered).toHaveLength(1);
    expect(second?.ack).toEqual({ ackSeq: 2, ackBits: 0 });
  });

  it("buffers out-of-order records and releases the contiguous run", () => {
    const receiver = new SelectiveRepeatReceiver({ onFailure: () => {} });
    const second = receiver.accept(1, bytes(1));
    expect(second?.delivered).toEqual([]);
    expect(second?.ack).toEqual({ ackSeq: 0, ackBits: 0b1 });

    const third = receiver.accept(2, bytes(2));
    expect(third?.ack).toEqual({ ackSeq: 0, ackBits: 0b11 });

    const first = receiver.accept(0, bytes(0));
    expect(first?.delivered.map((frame) => frame[0])).toEqual([0, 1, 2]);
    expect(first?.ack).toEqual({ ackSeq: 3, ackBits: 0 });
    expect(receiver.bufferedCount).toBe(0);
  });

  it("re-acks duplicates but drops replays outside the window", () => {
    const receiver = new SelectiveRepeatReceiver({ onFailure: () => {}, replayWindow: 4 });
    receiver.accept(0, bytes(0));
    receiver.accept(1, bytes(1));
    receiver.accept(2, bytes(2));
    const duplicate = receiver.accept(1, bytes(1));
    expect(duplicate?.delivered).toEqual([]);
    expect(duplicate?.shouldAck).toBe(true);
    expect(duplicate?.ack.ackSeq).toBe(3);

    expect(receiver.accept(0, bytes(0))?.shouldAck).toBe(true);
    for (let seq = 3; seq <= 10; seq += 1) {
      receiver.accept(seq, bytes(seq));
    }
    expect(receiver.nextExpectedSeq).toBe(11);
    expect(receiver.accept(1, bytes(1))).toBeNull();
  });

  it("fails when the out-of-order buffer exceeds its record budget", () => {
    const failures: string[] = [];
    const receiver = new SelectiveRepeatReceiver({
      onFailure: (reason) => failures.push(reason),
      maxBufferedRecords: 2,
    });
    receiver.accept(1, bytes(1));
    receiver.accept(2, bytes(2));
    const overflow = receiver.accept(3, bytes(3));
    expect(overflow?.failure).toBe("receive_buffer_exhausted");
    expect(failures).toEqual(["receive_buffer_exhausted"]);
  });

  it("accepts the gap-closing record even when the buffer is at capacity", () => {
    const failures: string[] = [];
    const receiver = new SelectiveRepeatReceiver({
      onFailure: (reason) => failures.push(reason),
      maxBufferedRecords: 2,
    });
    receiver.accept(1, bytes(1));
    receiver.accept(2, bytes(2));
    expect(receiver.bufferedCount).toBe(2);

    // Inserting seq 0 drains the whole contiguous run in the same call, so the
    // capacity check must not reject it.
    const closing = receiver.accept(0, bytes(0));
    expect(closing?.failure).toBeUndefined();
    expect(closing?.delivered.map((frame) => frame[0])).toEqual([0, 1, 2]);
    expect(receiver.bufferedCount).toBe(0);
    expect(failures).toEqual([]);
  });

  it("fails when a gap is not filled within the buffer age budget", () => {
    const failures: string[] = [];
    const receiver = new SelectiveRepeatReceiver({
      onFailure: (reason) => failures.push(reason),
      maxBufferedAgeMs: 10,
      now,
    });
    receiver.accept(1, bytes(1));
    advance(10);
    expect(failures).toEqual(["receive_timeout"]);
  });
});

describe("SelectiveRepeatSender", () => {
  function makeSender(
    options: {
      windowSize?: number;
      maxPendingBytes?: number;
      maxRetries?: number;
      maxAgeMs?: number;
      rtoMs?: number;
      sendOk?: () => boolean;
    } = {},
  ): {
    sender: SelectiveRepeatSender;
    sent: SenderRecord[];
    failures: string[];
    retransmits: number[];
  } {
    const sent: SenderRecord[] = [];
    const failures: string[] = [];
    const retransmits: number[] = [];
    const sender = new SelectiveRepeatSender({
      sealAndSend: (record) => {
        if (options.sendOk !== undefined && !options.sendOk()) return false;
        sent.push(record);
        return true;
      },
      onFailure: (reason) => failures.push(reason),
      onRetransmit: (count) => retransmits.push(count),
      windowSize: options.windowSize,
      maxPendingBytes: options.maxPendingBytes,
      maxRetries: options.maxRetries,
      maxAgeMs: options.maxAgeMs,
      rtoMs: options.rtoMs ?? 10,
      now,
    });
    return { sender, sent, failures, retransmits };
  }

  it("retransmits unacknowledged records after the RTO and clears on cumulative ACK", () => {
    const { sender, sent, retransmits } = makeSender();
    expect(sender.sendFrame(bytes(0))).toBe(true);
    expect(sender.sendFrame(bytes(1))).toBe(true);
    expect(sender.pendingCount).toBe(2);

    advance(10);
    expect(sent).toHaveLength(4);
    expect(retransmits).toEqual([2]);

    sender.receiveAck(2, 0);
    expect(sender.pendingCount).toBe(0);
    advance(1_000);
    expect(sent).toHaveLength(4);
  });

  it("applies selective ACK bits", () => {
    const { sender } = makeSender();
    sender.sendFrame(bytes(0));
    sender.sendFrame(bytes(1));
    sender.sendFrame(bytes(2));
    sender.receiveAck(1, 1); // seq 0 cumulative, seq 2 selective
    expect(sender.pendingCount).toBe(1);
    expect(sender.pendingBytes).toBe(4);
  });

  it("refuses to exceed its fixed window", () => {
    const { sender } = makeSender({ windowSize: 2 });
    expect(sender.sendFrame(bytes(0))).toBe(true);
    expect(sender.sendFrame(bytes(1))).toBe(true);
    expect(sender.sendFrame(bytes(2))).toBe(false);
    expect(sender.pendingCount).toBe(2);
  });

  it("fails after the retransmission budget is exhausted", () => {
    const { sender, failures } = makeSender({ maxRetries: 1 });
    sender.sendFrame(bytes(0));
    advance(10); // retry 1
    expect(failures).toEqual([]);
    advance(20); // retry 2 > 1
    expect(failures).toEqual(["retransmit_limit"]);
    expect(sender.failed).toBe(true);
  });

  it("fails when an unacknowledged record is older than the max age", () => {
    const { sender, failures } = makeSender({ maxAgeMs: 15, maxRetries: 100 });
    sender.sendFrame(bytes(0));
    advance(10);
    expect(failures).toEqual([]);
    advance(20);
    expect(failures).toEqual(["retransmit_timeout"]);
  });

  it("fails when sealing or sending a record fails", () => {
    const { sender, failures } = makeSender({ sendOk: () => false });
    expect(sender.sendFrame(bytes(0))).toBe(false);
    expect(failures).toEqual(["send_failed"]);
  });

  it("keeps the latest ACK state for piggybacking", () => {
    const { sender, sent } = makeSender();
    sender.setAckState(9, 0b100);
    sender.sendFrame(bytes(0));
    expect(sent[0]?.ackSeq).toBe(9);
    expect(sent[0]?.ackBits).toBe(0b100);
  });
});
