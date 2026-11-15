import { describe, expect, it } from "vitest";

import {
  candidateBudgetBytes,
  canQueueCandidate,
  MAX_PENDING_CANDIDATE_BYTES,
  MAX_SIGNAL_CANDIDATE_BYTES,
  MAX_SIGNAL_MID_BYTES,
  readBoundedMid,
  readBoundedString,
} from "./signal-limits.js";

describe("signal limits", () => {
  it("rejects oversized candidate and mid fields", () => {
    const atLimit = "x".repeat(MAX_SIGNAL_CANDIDATE_BYTES);
    expect(readBoundedString({ candidate: atLimit }, "candidate", MAX_SIGNAL_CANDIDATE_BYTES)).toBe(
      atLimit,
    );
    expect(
      readBoundedString({ candidate: `${atLimit}x` }, "candidate", MAX_SIGNAL_CANDIDATE_BYTES),
    ).toBeNull();
    expect(readBoundedMid({ mid: "x".repeat(MAX_SIGNAL_MID_BYTES) })).toHaveLength(
      MAX_SIGNAL_MID_BYTES,
    );
    expect(readBoundedMid({ mid: "x".repeat(MAX_SIGNAL_MID_BYTES + 1) })).toBe("");
  });

  it("bounds the pending candidate queue by count and bytes", () => {
    expect(canQueueCandidate(0, 0, 1_024, 256)).toBe(true);
    expect(canQueueCandidate(256, 0, 1_024, 256)).toBe(false);
    expect(canQueueCandidate(1, MAX_PENDING_CANDIDATE_BYTES - 1, 2, 256)).toBe(false);
    expect(canQueueCandidate(1, MAX_PENDING_CANDIDATE_BYTES - 2, 2, 256)).toBe(true);
  });

  it("counts UTF-8 bytes for candidate and mid together", () => {
    expect(candidateBudgetBytes("abc", "mid")).toBe(6);
    expect(candidateBudgetBytes("终端", "0")).toBe(7);
  });
});
