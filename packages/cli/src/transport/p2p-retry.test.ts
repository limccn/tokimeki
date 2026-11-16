import { describe, expect, it } from "vitest";

import { canRetryP2P, MAX_CONCURRENT_P2P_RETRIES, P2P_RETRY_DELAY_MS } from "./p2p-retry.js";

const base = {
  hasLink: true,
  linkReady: false,
  p2pEnabled: true,
  closing: false,
  alreadyUsed: false,
  inFlight: 0,
};

describe("canRetryP2P", () => {
  it("allows one pre-ready retry per viewer within the concurrency limit", () => {
    expect(canRetryP2P(base)).toBe(true);
    expect(canRetryP2P({ ...base, inFlight: MAX_CONCURRENT_P2P_RETRIES - 1 })).toBe(true);
  });

  it("rejects failures after ready, missing links, disabled P2P, closing, or reuse", () => {
    expect(canRetryP2P({ ...base, linkReady: true })).toBe(false);
    expect(canRetryP2P({ ...base, hasLink: false })).toBe(false);
    expect(canRetryP2P({ ...base, p2pEnabled: false })).toBe(false);
    expect(canRetryP2P({ ...base, closing: true })).toBe(false);
    expect(canRetryP2P({ ...base, alreadyUsed: true })).toBe(false);
    expect(canRetryP2P({ ...base, inFlight: MAX_CONCURRENT_P2P_RETRIES })).toBe(false);
  });

  it("uses a short bounded retry delay", () => {
    expect(P2P_RETRY_DELAY_MS).toBe(500);
  });
});
