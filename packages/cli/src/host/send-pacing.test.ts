import { describe, expect, it } from "vitest";

import {
  DRAIN_BUFFER_FLOOR_BYTES,
  DRAIN_WINDOW_MS,
  DrainWindow,
  SEND_PACE_QUEUE_HIGH_WATER_BYTES,
  SEND_PACE_QUEUE_LOW_WATER_BYTES,
  SendPacer,
  SNAPSHOT_PACE_FLOOR_MS,
} from "./send-pacing.js";

const noopTimers = {
  setInterval: () => ({}) as NodeJS.Timeout,
  clearInterval: () => undefined,
};

function createPacer(bytesPerSecond: number) {
  let now = 0;
  const sent: Array<{ label: string; at: number }> = [];
  const pacer = new SendPacer({
    bytesPerSecond,
    now: () => now,
    timers: noopTimers,
  });
  return {
    pacer,
    sent,
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
    record(label: string) {
      sent.push({ label, at: now });
    },
    pump() {
      pacer.pump();
    },
    labels() {
      return sent.map((entry) => entry.label);
    },
  };
}

describe("DrainWindow", () => {
  it("never reports slow while the link stays below the 64 KiB backlog floor", () => {
    const window = new DrainWindow();
    for (let now = 0; now <= DRAIN_WINDOW_MS * 4; now += 250) {
      expect(window.observe(now, DRAIN_BUFFER_FLOOR_BYTES - 1, 1_000_000)).toBe("idle");
    }
    expect(window.active).toBe(false);
  });

  it("reports slow after a full window when the buffer does not drain", () => {
    const window = new DrainWindow();
    expect(window.observe(0, 100_000, 10_000)).toBe("observing");
    expect(window.observe(2_999, 100_000, 10_000)).toBe("observing");
    expect(window.observe(3_000, 100_000, 10_000)).toBe("slow");
  });

  it("counts bytes written into the link when computing the drain rate", () => {
    const window = new DrainWindow();
    expect(window.observe(0, 100_000, 10_000)).toBe("observing");
    window.noteWritten(100_000);
    // 100k at the start + 100k written - 120k at the end = 80k over 3 s.
    expect(window.observe(DRAIN_WINDOW_MS, 120_000, 10_000)).toBe("observing");
  });

  it("ignores writes recorded before a window starts", () => {
    const window = new DrainWindow();
    window.noteWritten(50_000);
    expect(window.observe(0, 100_000, 10_000)).toBe("observing");
    expect(window.observe(DRAIN_WINDOW_MS, 100_000, 10_000)).toBe("slow");
  });

  it("treats a drain exactly at the threshold as acceptable", () => {
    const window = new DrainWindow();
    expect(window.observe(0, 150_000, 10_000)).toBe("observing");
    // 150k - 120k = 30k over 3 s = exactly 10 kB/s.
    expect(window.observe(DRAIN_WINDOW_MS, 120_000, 10_000)).toBe("observing");
  });

  it("resets the window when the buffer drops below the floor", () => {
    const window = new DrainWindow();
    expect(window.observe(0, 100_000, 10_000)).toBe("observing");
    expect(window.observe(1_000, 0, 10_000)).toBe("idle");
    expect(window.observe(2_000, 100_000, 10_000)).toBe("observing");
    expect(window.observe(4_999, 100_000, 10_000)).toBe("observing");
    expect(window.observe(5_000, 100_000, 10_000)).toBe("slow");
  });

  it("reports slow only for the viewer whose window drained slowly", () => {
    const slow = new DrainWindow();
    const healthy = new DrainWindow();
    slow.observe(0, 200_000, 10_000);
    healthy.observe(0, 200_000, 10_000);
    healthy.noteWritten(150_000);
    expect(slow.observe(DRAIN_WINDOW_MS, 200_000, 10_000)).toBe("slow");
    expect(healthy.observe(DRAIN_WINDOW_MS, 200_000, 10_000)).toBe("observing");
  });

  it("does nothing when the threshold is disabled", () => {
    const window = new DrainWindow();
    expect(window.observe(0, 200_000, 0)).toBe("idle");
    expect(window.active).toBe(false);
  });
});

describe("SendPacer", () => {
  it("requires a positive byte rate", () => {
    expect(() => new SendPacer({ bytesPerSecond: 0 })).toThrow(RangeError);
    expect(() => new SendPacer({ bytesPerSecond: -1 })).toThrow(RangeError);
    expect(() => new SendPacer({ bytesPerSecond: Number.NaN })).toThrow(RangeError);
  });

  it("sends immediately while the bucket has budget", () => {
    const ctx = createPacer(1_000);
    ctx.pacer.enqueue({ kind: "output", priority: true, bytes: 100, send: () => ctx.record("a") });
    expect(ctx.labels()).toEqual(["a"]);
    expect(ctx.pacer.queuedBytes).toBe(0);
    expect(ctx.pacer.queuedJobs).toBe(0);
  });

  it("lets a small OUTPUT pass an unfinished snapshot", () => {
    const ctx = createPacer(1_000);
    ctx.pacer.enqueue({
      kind: "output",
      priority: true,
      bytes: 1_000,
      send: () => ctx.record("filler"),
    });
    expect(ctx.labels()).toEqual(["filler"]);
    ctx.pacer.enqueue({
      kind: "snapshot",
      priority: false,
      bytes: 4_000,
      send: () => ctx.record("snapshot"),
    });
    ctx.pacer.enqueue({
      kind: "output",
      priority: true,
      bytes: 500,
      send: () => ctx.record("small"),
    });
    expect(ctx.labels()).toEqual(["filler"]);

    ctx.advance(500);
    ctx.pump();
    expect(ctx.labels()).toEqual(["filler", "small"]);

    // The oversized snapshot bursts once the one-second bucket is full again.
    ctx.advance(1_000);
    ctx.pump();
    expect(ctx.labels()).toEqual(["filler", "small", "snapshot"]);
  });

  it("keeps OUTPUT sequence order when a large OUTPUT is pending", () => {
    const ctx = createPacer(1_000);
    ctx.pacer.enqueue({
      kind: "output",
      priority: false,
      bytes: 800,
      send: () => ctx.record("large-1"),
    });
    expect(ctx.labels()).toEqual(["large-1"]);
    ctx.pacer.enqueue({
      kind: "output",
      priority: false,
      bytes: 800,
      send: () => ctx.record("large-2"),
    });
    ctx.pacer.enqueue({
      kind: "output",
      priority: true,
      bytes: 100,
      send: () => ctx.record("small"),
    });

    ctx.advance(600);
    ctx.pump();
    // The small frame must not open a seq gap by passing large-2.
    expect(ctx.labels()).toEqual(["large-1", "large-2"]);

    ctx.advance(100);
    ctx.pump();
    expect(ctx.labels()).toEqual(["large-1", "large-2", "small"]);
  });

  it("finishes a 256 KiB snapshot within the 8 s floor at a very low pace", () => {
    const ctx = createPacer(1_000);
    // Drain the bucket so the snapshot cannot use the full-bucket burst.
    ctx.pacer.enqueue({ kind: "output", priority: true, bytes: 999, send: () => undefined });
    let snapshotSentAt: number | null = null;
    ctx.pacer.enqueue({
      kind: "snapshot",
      priority: false,
      bytes: 262_144,
      send: () => {
        snapshotSentAt = ctx.now();
      },
    });

    while (snapshotSentAt === null && ctx.now() <= SNAPSHOT_PACE_FLOOR_MS) {
      ctx.advance(100);
      // Small OUTPUT keeps consuming the token budget without ever letting the
      // bucket refill to its one-second capacity.
      ctx.pacer.enqueue({
        kind: "output",
        priority: true,
        bytes: 100,
        send: () => undefined,
      });
      if (ctx.now() < SNAPSHOT_PACE_FLOOR_MS) {
        expect(snapshotSentAt).toBeNull();
      }
    }
    expect(snapshotSentAt).toBe(SNAPSHOT_PACE_FLOOR_MS);
  });

  it("pauses once above the 1 MiB queue bound and resumes at 256 KiB", () => {
    let now = 0;
    let highs = 0;
    let lows = 0;
    const pacer = new SendPacer({
      bytesPerSecond: 1_000_000,
      now: () => now,
      timers: noopTimers,
      onQueueHighWater: () => {
        highs += 1;
      },
      onQueueLowWater: () => {
        lows += 1;
      },
    });
    pacer.enqueue({ kind: "snapshot", priority: false, bytes: 1_000_000, send: () => undefined });
    pacer.enqueue({ kind: "snapshot", priority: false, bytes: 600_000, send: () => undefined });
    pacer.enqueue({ kind: "snapshot", priority: false, bytes: 600_000, send: () => undefined });
    expect(pacer.queuedBytes).toBe(1_200_000);
    expect(highs).toBe(1);

    now += 1_000;
    pacer.pump();
    expect(pacer.queuedBytes).toBe(600_000);
    expect(lows).toBe(0);

    now += 1_000;
    pacer.pump();
    expect(pacer.queuedBytes).toBe(0);
    expect(lows).toBe(1);
  });

  it("flushes the remaining queue on host exit", () => {
    const ctx = createPacer(1_000);
    ctx.pacer.enqueue({
      kind: "output",
      priority: true,
      bytes: SEND_PACE_QUEUE_HIGH_WATER_BYTES,
      send: () => ctx.record("large"),
    });
    ctx.pacer.enqueue({
      kind: "snapshot",
      priority: false,
      bytes: 4_000,
      send: () => ctx.record("snapshot"),
    });
    expect(ctx.labels()).toEqual(["large"]);
    ctx.pacer.flush();
    expect(ctx.labels()).toEqual(["large", "snapshot"]);
    expect(ctx.pacer.queuedBytes).toBe(0);
  });

  it("keeps the low-water resume separated from the high-water pause", () => {
    // Guards the constants used by the host pause wiring.
    expect(SEND_PACE_QUEUE_LOW_WATER_BYTES).toBeLessThan(SEND_PACE_QUEUE_HIGH_WATER_BYTES);
  });
});
