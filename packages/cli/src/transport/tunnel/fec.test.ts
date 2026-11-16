import { describe, expect, it } from "vitest";

import {
  decodeXorFecGroup,
  encodeXorFecGroup,
  TUNNEL_FEC_DATA_FRAME_MAX_BYTES,
  TUNNEL_FEC_GROUP_SIZE,
  TUNNEL_FEC_METADATA_MAX_BYTES,
  type XorFecGroup,
  XorFecReceiver,
  XorFecSender,
} from "./fec.js";

function payload(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (seed * 31 + index * 7) & 0xff;
  }
  return bytes;
}

function xorParity(payloads: readonly Uint8Array[]): Uint8Array {
  let maxLength = 0;
  for (const bytes of payloads) {
    if (bytes.byteLength > maxLength) maxLength = bytes.byteLength;
  }
  const parity = new Uint8Array(maxLength);
  for (const bytes of payloads) {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      parity[index] = (parity[index] ?? 0) ^ (bytes[index] ?? 0);
    }
  }
  return parity;
}

function makeGroup(startSeq: number, payloads: readonly Uint8Array[]): XorFecGroup {
  return {
    startSeq,
    count: payloads.length,
    lengths: payloads.map((bytes) => bytes.byteLength),
    parity: xorParity(payloads),
  };
}

function decodeOrThrow(encoded: Uint8Array | null): XorFecGroup {
  if (encoded === null) throw new Error("expected a parity record");
  const group = decodeXorFecGroup(encoded);
  if (group === null) throw new Error("expected a valid FEC group");
  return group;
}

describe("XorFecSender", () => {
  it("emits parity only once a group fills and pads with XOR", () => {
    const sender = new XorFecSender();
    const payloads = Array.from({ length: TUNNEL_FEC_GROUP_SIZE }, (_value, seq) =>
      payload(4 + seq * 3, seq),
    );
    for (let seq = 0; seq < TUNNEL_FEC_GROUP_SIZE - 1; seq += 1) {
      expect(sender.add(seq, payloads[seq] ?? new Uint8Array())).toBeNull();
    }
    expect(sender.pendingRecords).toBe(TUNNEL_FEC_GROUP_SIZE - 1);

    const group = decodeOrThrow(
      sender.add(TUNNEL_FEC_GROUP_SIZE - 1, payloads[7] ?? new Uint8Array()),
    );
    expect(group.startSeq).toBe(0);
    expect(group.count).toBe(TUNNEL_FEC_GROUP_SIZE);
    expect(group.lengths).toEqual(payloads.map((bytes) => bytes.byteLength));
    expect(group.parity).toEqual(xorParity(payloads));
    expect(sender.groupsSent).toBe(1);
    expect(sender.pendingRecords).toBe(0);
  });

  it("ignores duplicate and retransmitted sequences", () => {
    const sender = new XorFecSender();
    expect(sender.add(0, payload(8, 0))).toBeNull();
    expect(sender.add(1, payload(8, 1))).toBeNull();
    expect(sender.add(1, payload(8, 1))).toBeNull();
    for (let seq = 2; seq < TUNNEL_FEC_GROUP_SIZE; seq += 1) {
      sender.add(seq, payload(8, seq));
    }
    expect(sender.groupsSent).toBe(1);
    // A retransmission after the group was flushed must not create parity.
    expect(sender.add(3, payload(8, 3))).toBeNull();
    expect(sender.groupsSent).toBe(1);
    expect(sender.pendingRecords).toBe(0);
  });

  it("restarts the group after a sequence gap", () => {
    const sender = new XorFecSender();
    sender.add(0, payload(8, 0));
    sender.add(1, payload(8, 1));
    expect(sender.add(5, payload(8, 5))).toBeNull();
    expect(sender.droppedGroups).toBe(1);
    expect(sender.lastDropReason).toBe("non_contiguous");
    for (let seq = 6; seq < 12; seq += 1) {
      sender.add(seq, payload(8, seq));
    }
    const group = decodeOrThrow(sender.add(12, payload(8, 12)));
    expect(group.startSeq).toBe(5);
    expect(group.count).toBe(TUNNEL_FEC_GROUP_SIZE);
  });

  it("skips parity when a group frame is too large to protect", () => {
    const sender = new XorFecSender();
    const oversized = new Uint8Array(TUNNEL_FEC_DATA_FRAME_MAX_BYTES + 1);
    for (let seq = 0; seq < TUNNEL_FEC_GROUP_SIZE; seq += 1) {
      expect(sender.add(seq, oversized)).toBeNull();
    }
    expect(sender.groupsSent).toBe(0);
    expect(sender.droppedGroups).toBe(1);
    expect(sender.lastDropReason).toBe("parity_too_large");
  });

  it("supports smaller test groups", () => {
    const sender = new XorFecSender({ groupSize: 2 });
    expect(sender.add(0, payload(4, 0))).toBeNull();
    const group = decodeOrThrow(sender.add(1, payload(4, 1)));
    expect(group.startSeq).toBe(0);
    expect(group.count).toBe(2);
  });
});

describe("FEC group encoding", () => {
  it("roundtrips a short group and lays out metadata canonically", () => {
    const payloads = [payload(5, 0), payload(9, 1), payload(2, 2)];
    const group = makeGroup(7, payloads);
    const encoded = encodeXorFecGroup(group);
    expect(encoded.byteLength).toBe(6 + 3 * 2 + 9);
    const decoded = decodeXorFecGroup(encoded);
    expect(decoded).toEqual(group);
    // The parity record never exceeds one tunnel plaintext budget.
    expect(encoded.byteLength).toBeLessThanOrEqual(TUNNEL_FEC_METADATA_MAX_BYTES + 9);
  });

  it("rejects malformed decode inputs", () => {
    expect(decodeXorFecGroup(new Uint8Array(0))).toBeNull();
    expect(decodeXorFecGroup(new Uint8Array(5))).toBeNull();
    const valid = encodeXorFecGroup(makeGroup(0, [payload(4, 0), payload(4, 1)]));
    const badCount = new Uint8Array(valid);
    badCount[4] = 0;
    expect(decodeXorFecGroup(badCount)).toBeNull();
    const tooMany = new Uint8Array(valid);
    tooMany[4] = TUNNEL_FEC_GROUP_SIZE + 1;
    expect(decodeXorFecGroup(tooMany)).toBeNull();
    // Drop a parity byte so lengths and parity disagree.
    expect(decodeXorFecGroup(valid.subarray(0, valid.byteLength - 1))).toBeNull();
    // Metadata truncated before the length table completes.
    expect(decodeXorFecGroup(valid.subarray(0, 8))).toBeNull();
  });

  it("rejects invalid group descriptions at encode time", () => {
    expect(() =>
      encodeXorFecGroup({
        startSeq: 0,
        count: 0,
        lengths: [],
        parity: new Uint8Array(0),
      }),
    ).toThrow();
    expect(() =>
      encodeXorFecGroup({
        startSeq: 0,
        count: 2,
        lengths: [4],
        parity: new Uint8Array(4),
      }),
    ).toThrow();
    expect(() =>
      encodeXorFecGroup({
        startSeq: 0,
        count: 1,
        lengths: [4],
        parity: new Uint8Array(3),
      }),
    ).toThrow();
  });
});

describe("XorFecReceiver", () => {
  it("recovers exactly one missing record byte-for-byte", () => {
    const receiver = new XorFecReceiver();
    const payloads = Array.from({ length: 4 }, (_value, index) => payload(3 + index * 5, index));
    payloads.forEach((bytes, seq) => {
      if (seq !== 2) receiver.addData(seq, bytes);
    });
    const recovered = receiver.tryRecover(makeGroup(0, payloads));
    expect(recovered).not.toBeNull();
    expect(recovered?.seq).toBe(2);
    expect(Buffer.from(recovered?.plaintext ?? new Uint8Array())).toEqual(
      Buffer.from(payloads[2] ?? new Uint8Array()),
    );
    expect(receiver.recoveredCount).toBe(1);
  });

  it("recovers the first, middle and last record in a group", () => {
    const payloads = Array.from({ length: TUNNEL_FEC_GROUP_SIZE }, (_value, index) =>
      payload(5 + index, index),
    );
    for (const missingSeq of [0, 3, TUNNEL_FEC_GROUP_SIZE - 1]) {
      const receiver = new XorFecReceiver();
      payloads.forEach((bytes, seq) => {
        if (seq !== missingSeq) receiver.addData(seq, bytes);
      });
      const recovered = receiver.tryRecover(makeGroup(0, payloads));
      expect(recovered?.seq).toBe(missingSeq);
      expect(Buffer.from(recovered?.plaintext ?? new Uint8Array())).toEqual(
        Buffer.from(payloads[missingSeq] ?? new Uint8Array()),
      );
    }
  });

  it("does not recover when more than one record is missing", () => {
    const receiver = new XorFecReceiver();
    const payloads = Array.from({ length: 4 }, (_value, index) => payload(6, index));
    payloads.forEach((bytes, seq) => {
      if (seq !== 1 && seq !== 3) receiver.addData(seq, bytes);
    });
    expect(receiver.tryRecover(makeGroup(0, payloads))).toBeNull();
    expect(receiver.recoveredCount).toBe(0);
  });

  it("returns null when every record is already present", () => {
    const receiver = new XorFecReceiver();
    const payloads = [payload(4, 0), payload(4, 1), payload(4, 2)];
    payloads.forEach((bytes, seq) => {
      receiver.addData(seq, bytes);
    });
    expect(receiver.tryRecover(makeGroup(0, payloads))).toBeNull();
    expect(receiver.rejectedParity).toBe(0);
  });

  it("rejects malformed groups and inconsistent lengths", () => {
    const receiver = new XorFecReceiver();
    expect(
      receiver.tryRecover({ startSeq: 0, count: 0, lengths: [], parity: new Uint8Array(0) }),
    ).toBeNull();
    expect(
      receiver.tryRecover({
        startSeq: 0,
        count: TUNNEL_FEC_GROUP_SIZE + 1,
        lengths: new Array(TUNNEL_FEC_GROUP_SIZE + 1).fill(1),
        parity: new Uint8Array(1),
      }),
    ).toBeNull();
    expect(
      receiver.tryRecover({
        startSeq: 0xffff_ffff,
        count: 2,
        lengths: [1, 1],
        parity: new Uint8Array(1),
      }),
    ).toBeNull();
    expect(receiver.rejectedParity).toBe(3);

    const payloads = [payload(4, 0), payload(4, 1), payload(4, 2)];
    const group = makeGroup(0, payloads);
    receiver.addData(1, payload(3, 1)); // length disagrees with the parity metadata
    receiver.addData(2, payloads[2] ?? new Uint8Array());
    expect(receiver.tryRecover(group)).toBeNull();
  });

  it("bounds the plaintext cache by count, bytes and age", () => {
    let now = 0;
    const byCount = new XorFecReceiver({ maxRecords: 2, now: () => now });
    byCount.addData(0, payload(2, 0));
    byCount.addData(1, payload(2, 1));
    byCount.addData(2, payload(2, 2));
    expect(byCount.cachedRecords).toBe(2);
    expect(byCount.cachedBytes).toBe(4);

    const byBytes = new XorFecReceiver({ maxBytes: 3, now: () => now });
    byBytes.addData(0, payload(2, 0));
    byBytes.addData(1, payload(2, 1));
    expect(byBytes.cachedRecords).toBe(1);
    expect(byBytes.cachedBytes).toBe(2);

    const byAge = new XorFecReceiver({ maxAgeMs: 100, now: () => now });
    byAge.addData(0, payload(2, 0));
    now = 100;
    byAge.addData(1, payload(2, 1));
    expect(byAge.cachedRecords).toBe(1);
    expect(byAge.cachedBytes).toBe(2);
  });

  it("resets all cached state", () => {
    const receiver = new XorFecReceiver();
    receiver.addData(0, payload(4, 0));
    receiver.reset();
    expect(receiver.cachedRecords).toBe(0);
    expect(receiver.cachedBytes).toBe(0);
  });
});
