import { describe, expect, it } from "vitest";

import {
  DEFAULT_SESSION_MAX_TTL_SECONDS,
  MAX_SESSION_TTL_SECONDS,
  parseNonNegativeInt,
  sessionIdleTtlSeconds,
  sessionMaxBytes,
  sessionMaxMessagesPerSecond,
  sessionMaxTtlSeconds,
} from "../src/env.js";

describe("parseNonNegativeInt", () => {
  it("preserves zero, which disables the limiters", () => {
    expect(parseNonNegativeInt("0", 99)).toBe(0);
  });

  it("parses positive values and trims whitespace", () => {
    expect(parseNonNegativeInt(" 120 ", 99)).toBe(120);
    expect(parseNonNegativeInt("1024", 0)).toBe(1024);
  });

  it("falls back on missing, negative, empty, and non-numeric input", () => {
    expect(parseNonNegativeInt(undefined, 7)).toBe(7);
    expect(parseNonNegativeInt("", 7)).toBe(7);
    expect(parseNonNegativeInt("-5", 7)).toBe(7);
    expect(parseNonNegativeInt("abc", 7)).toBe(7);
  });

  it("clamps to the maximum", () => {
    expect(parseNonNegativeInt("1000", 0, 10)).toBe(10);
  });
});

describe("session limit configuration", () => {
  it("defaults the absolute TTL to 24h and treats 0 as off", () => {
    expect(sessionMaxTtlSeconds({})).toBe(DEFAULT_SESSION_MAX_TTL_SECONDS);
    expect(sessionMaxTtlSeconds({ TOKIMEKI_SESSION_MAX_TTL_SECONDS: "0" })).toBe(0);
  });

  it("falls back on an invalid absolute TTL and clamps the upper bound", () => {
    expect(sessionMaxTtlSeconds({ TOKIMEKI_SESSION_MAX_TTL_SECONDS: "nope" })).toBe(
      DEFAULT_SESSION_MAX_TTL_SECONDS,
    );
    expect(
      sessionMaxTtlSeconds({
        TOKIMEKI_SESSION_MAX_TTL_SECONDS: String(MAX_SESSION_TTL_SECONDS * 2),
      }),
    ).toBe(MAX_SESSION_TTL_SECONDS);
  });

  it("defaults idle, bytes, and message rate to off", () => {
    expect(sessionIdleTtlSeconds({})).toBe(0);
    expect(sessionMaxBytes({})).toBe(0);
    expect(sessionMaxMessagesPerSecond({})).toBe(0);
  });

  it("parses positive idle, bytes, and rate limits", () => {
    expect(sessionIdleTtlSeconds({ TOKIMEKI_SESSION_IDLE_TTL_SECONDS: "60" })).toBe(60);
    expect(sessionMaxBytes({ TOKIMEKI_SESSION_MAX_BYTES: "1048576" })).toBe(1_048_576);
    expect(sessionMaxMessagesPerSecond({ TOKIMEKI_SESSION_MAX_MESSAGES_PER_SECOND: "25" })).toBe(
      25,
    );
  });

  it("falls back on invalid idle, bytes, and rate limits", () => {
    expect(sessionIdleTtlSeconds({ TOKIMEKI_SESSION_IDLE_TTL_SECONDS: "-1" })).toBe(0);
    expect(sessionMaxBytes({ TOKIMEKI_SESSION_MAX_BYTES: "lots" })).toBe(0);
    expect(sessionMaxMessagesPerSecond({ TOKIMEKI_SESSION_MAX_MESSAGES_PER_SECOND: "" })).toBe(0);
  });
});
