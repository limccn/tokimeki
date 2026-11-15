import { describe, expect, it } from "vitest";

import { createRedactor, Logger } from "./logger.js";

function captureLogger(level: "debug" | "info" | "warn" | "error" | "silent") {
  const lines: string[] = [];
  const logger = new Logger({ level, write: (line) => lines.push(line) });
  return { logger, lines };
}

describe("createRedactor", () => {
  it("replaces every occurrence of known secrets", () => {
    const redact = createRedactor(["session-token-9876"]);
    expect(redact("token=session-token-9876; again session-token-9876")).toBe(
      "token=[redacted]; again [redacted]",
    );
  });

  it("replaces longer secrets first so no partial value survives", () => {
    const redact = createRedactor(["abcd", "abcdef"]);
    expect(redact("xabcdefy")).toBe("x[redacted]y");
  });

  it("ignores unset and very short values", () => {
    const redact = createRedactor([undefined, "", "abc"]);
    expect(redact("abc")).toBe("abc");
  });
});

describe("Logger", () => {
  it("filters below the configured level and prefixes messages", () => {
    const { logger, lines } = captureLogger("info");
    logger.debug("hidden");
    logger.info("shown");
    logger.warn("also shown");
    expect(lines).toEqual(["[tokimeki] info: shown", "[tokimeki] warn: also shown"]);
  });

  it("redacts secrets on every line", () => {
    const lines: string[] = [];
    const logger = new Logger({
      level: "debug",
      write: (line) => lines.push(line),
      redact: createRedactor(["master-token-1234"]),
    });
    logger.error("bad token master-token-1234");
    logger.raw("raw master-token-1234");
    expect(lines.join("\n")).not.toContain("master-token-1234");
    expect(lines).toHaveLength(2);
  });

  it("mutes leveled output while the raw screen is owned", () => {
    const { logger, lines } = captureLogger("info");
    logger.setMuted(true);
    logger.info("suppressed");
    logger.warn("also suppressed");
    logger.setMuted(false);
    logger.info("visible");
    expect(lines).toEqual(["[tokimeki] info: visible"]);
  });

  it("writes raw session lines regardless of level", () => {
    const { logger, lines } = captureLogger("silent");
    logger.raw("session: sess-1");
    expect(lines).toEqual(["session: sess-1"]);
  });
});
