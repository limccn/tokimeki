import { describe, expect, it } from "vitest";

import { resolveResize, shouldApplyResize, sizesEqual } from "./resize-policy.js";

const local = { cols: 80, rows: 24 };
const startup = { cols: 90, rows: 28 };
const pinned = { cols: 100, rows: 30 };
const latest = { cols: 120, rows: 40 };
const viewerA = { cols: 100, rows: 30 };
const viewerB = { cols: 60, rows: 20 };

describe("resolveResize", () => {
  it("latest follows the most recent resize request", () => {
    expect(
      resolveResize({
        policy: "latest",
        local,
        startup,
        pinned: null,
        viewers: [viewerA],
        latest,
      }),
    ).toEqual(latest);
  });

  it("latest retains the last size after every viewer leaves", () => {
    expect(
      resolveResize({
        policy: "latest",
        local,
        startup,
        pinned: null,
        viewers: [],
        latest: viewerA,
      }),
    ).toEqual(viewerA);
  });

  it("min fits the smallest viewer", () => {
    expect(
      resolveResize({
        policy: "min",
        local,
        startup,
        pinned: null,
        viewers: [viewerA, viewerB],
        latest,
      }),
    ).toEqual(viewerB);
  });

  it("min falls back to the local size without viewers", () => {
    expect(
      resolveResize({
        policy: "min",
        local,
        startup,
        pinned: null,
        viewers: [],
        latest,
      }),
    ).toEqual(local);
  });

  it("pinned prefers TOKIMEKI_PTY_SIZE and falls back to the startup size", () => {
    expect(
      resolveResize({
        policy: "pinned",
        local,
        startup,
        pinned,
        viewers: [viewerA],
        latest,
      }),
    ).toEqual(pinned);
    expect(
      resolveResize({
        policy: "pinned",
        local,
        startup,
        pinned: null,
        viewers: [viewerA],
        latest,
      }),
    ).toEqual(startup);
  });
});

describe("shouldApplyResize", () => {
  it("skips no-op resizes so ConPTY does not repaint", () => {
    expect(shouldApplyResize({ cols: 100, rows: 30 }, { cols: 100, rows: 30 })).toBe(false);
    expect(sizesEqual({ cols: 100, rows: 30 }, { cols: 100, rows: 30 })).toBe(true);
  });

  it("applies any dimension change", () => {
    expect(shouldApplyResize({ cols: 100, rows: 30 }, { cols: 101, rows: 30 })).toBe(true);
    expect(shouldApplyResize({ cols: 100, rows: 30 }, { cols: 100, rows: 31 })).toBe(true);
    expect(sizesEqual({ cols: 100, rows: 30 }, { cols: 100, rows: 31 })).toBe(false);
  });
});
