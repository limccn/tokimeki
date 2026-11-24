import { describe, expect, it } from "vitest";

import { LogRing, sanitizeLogLine } from "./log-ring.js";

describe("log ring sanitization", () => {
  it("strips C1 and bidi controls in addition to C0/DEL", () => {
    expect(sanitizeLogLine("a\u009b‮b\u001b")).toBe("ab");
  });

  it("bounds the retained ring", () => {
    const ring = new LogRing(2);
    ring.push("one");
    ring.push("two");
    ring.push("three");
    expect(ring.entries()).toEqual(["two", "three"]);
  });
});
