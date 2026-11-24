import { describe, expect, it, vi } from "vitest";

import { createLogger } from "../src/logging.js";

describe("relay logger allowlist", () => {
  it("keeps host-exit and TURN-fallback diagnostics but drops unknown fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      createLogger({ TOKIMEKI_LOG_LEVEL: "info" }, { sessionId: "sess-1" }).info("host_exited", {
        exitCode: 0,
        signal: "SIGTERM",
        fallback: true,
        token: "must-not-appear",
      });
      const line = JSON.parse(String(spy.mock.calls[0]?.[0])) as Record<string, unknown>;
      expect(line).toMatchObject({
        sessionId: "sess-1",
        exitCode: 0,
        signal: "SIGTERM",
        fallback: true,
      });
      expect(line.token).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
