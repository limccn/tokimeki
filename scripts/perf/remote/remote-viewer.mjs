#!/usr/bin/env node
/**
 * Standalone synthetic viewer for the cross-NAT perf task.
 *
 * Runs on a remote VPS. The session token is read from the first stdin line
 * (never argv/env so it does not appear in process listings). Emits
 * REMOTE_VIEWER_READY, waits for the configured payload, then emits a JSON
 * result line.
 */

import fs from "node:fs";
import { nowNs, nsToMs, sleep, summarizeLatency } from "../harness/metrics.mjs";
import { RelayViewer } from "../harness/relay-viewer.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

const relayUrl = argument("relay");
const session = argument("session");
const clientId = argument("client-id", "remote-viewer");
const bytes = Number(argument("bytes", String(8 * 1024 * 1024)));
const timeoutMs = Number(argument("timeout-ms", "120000"));
const stallAfter = Number(argument("stall-after", "0"));
const stallMs = Number(argument("stall-ms", "0"));
const snapshotReconnect = process.argv.includes("--snapshot-reconnect");
const reconnectMs = Number(argument("reconnect-ms", "2000"));

if (relayUrl === undefined || session === undefined) {
  process.stderr.write("REMOTE_VIEWER_FAIL missing --relay/--session\n");
  process.exit(2);
}

const token = fs.readFileSync(0, "utf8").trim().split(/\r?\n/)[0] ?? "";

if (token.length === 0) {
  process.stderr.write("REMOTE_VIEWER_FAIL missing session token\n");
  process.exit(2);
}

const viewer = new RelayViewer({
  relayUrl,
  session,
  sessionToken: token,
  clientId,
});
const startedAt = Date.now();
const flow =
  stallAfter > 0 && stallMs > 0 ? { stallAfter, stallMs, stalledAt: null, resumedAt: null } : null;

/**
 * Emit a final line and exit only after the stdout write is flushed. stdout to
 * a pipe is asynchronous on POSIX, so `process.exit()` right after `write()`
 * can truncate the result line the harness is waiting for.
 */
function writeAndExit(text, code) {
  return new Promise((resolve) => {
    process.stdout.write(text, () => {
      process.exit(code);
      resolve();
    });
  });
}

if (snapshotReconnect) {
  let viewer2 = null;
  let stage = "initial-connect";
  try {
    await viewer.connect();
    const connectedAt = nowNs();
    process.stdout.write("REMOTE_VIEWER_READY\n");
    stage = "initial-snapshot";
    const initial = await viewer.waitForSnapshot(timeoutMs);
    const initialLatencyMs = Math.max(0, nsToMs(initial.at - connectedAt));
    stage = "initial-close";
    await viewer.close();
    const closedAt = Date.now();
    await sleep(reconnectMs);
    stage = "reconnect";
    viewer2 = new RelayViewer({
      relayUrl,
      session,
      sessionToken: token,
      clientId: `${clientId}-r2`,
    });
    await viewer2.connect();
    const reconnectGapMs = Date.now() - closedAt;
    stage = "resync-snapshot";
    const resyncSentAt = nowNs();
    viewer2.sendResync("0");
    const resync = await viewer2.waitForSnapshot(timeoutMs);
    const resyncLatencyMs = Math.max(0, nsToMs(resync.at - resyncSentAt));
    if (initial.targetId !== clientId || resync.targetId !== `${clientId}-r2`) {
      throw new Error(
        `snapshot target mismatch: initial=${initial.targetId} resync=${resync.targetId}`,
      );
    }
    const result = {
      ok: true,
      mode: "snapshot-reconnect",
      clientId,
      initialBytes: initial.bytes,
      resyncBytes: resync.bytes,
      initialTargetId: initial.targetId,
      resyncTargetId: resync.targetId,
      initialLatencyMs,
      reconnectGapMs,
      resyncLatencyMs,
      errors: [...viewer.errors, ...viewer2.errors],
      wallMs: Date.now() - startedAt,
    };
    await viewer2.close();
    await writeAndExit(`REMOTE_VIEWER_RESULT ${JSON.stringify(result)}\n`, 0);
  } catch (error) {
    const failLine =
      `REMOTE_VIEWER_FAIL stage=${stage} ` +
      `${error instanceof Error ? error.message : String(error)} ` +
      `initialBytes=${viewer.snapshots.at(-1)?.bytes ?? 0} ` +
      `errors=${JSON.stringify([...viewer.errors, ...(viewer2?.errors ?? [])])}\n`;
    try {
      await viewer.close();
    } catch {
      // best effort
    }
    try {
      await viewer2?.close();
    } catch {
      // best effort
    }
    await writeAndExit(failLine, 1);
  }
}

try {
  await viewer.connect();
  if (flow !== null) {
    let stalled = false;
    viewer.on("frame", () => {
      if (stalled || viewer.receivedPayloadBytes < flow.stallAfter) {
        return;
      }
      stalled = true;
      flow.stalledAt = Date.now();
      viewer.stall();
      setTimeout(() => {
        flow.resumedAt = Date.now();
        viewer.resume();
      }, flow.stallMs);
    });
  }
  process.stdout.write("REMOTE_VIEWER_READY\n");
  await viewer.waitForBytes(bytes, timeoutMs);
  const stats = viewer.stats();
  const first = typeof stats.firstRecvAt === "bigint" ? Number(stats.firstRecvAt) : null;
  const last = typeof stats.lastRecvAt === "bigint" ? Number(stats.lastRecvAt) : null;
  const durationMs =
    first !== null && last !== null && last > first ? nsToMs(BigInt(last) - BigInt(first)) : null;
  const result = {
    ok: true,
    clientId,
    relayUrl,
    session,
    payloadBytes: stats.receivedPayloadBytes,
    wireBytes: stats.receivedWireBytes,
    frames: stats.receivedFrames,
    durationMs,
    throughputBytesPerSec:
      durationMs !== null && durationMs > 0
        ? Math.round(stats.receivedPayloadBytes / (durationMs / 1000))
        : null,
    latencyMs: summarizeLatency(stats.latencySamplesMs),
    errors: viewer.errors,
    closeInfo: viewer.closeInfo,
    wallMs: Date.now() - startedAt,
    ...(flow === null ? {} : { flow }),
  };
  await viewer.close();
  await writeAndExit(`REMOTE_VIEWER_RESULT ${JSON.stringify(result)}\n`, 0);
} catch (error) {
  const failLine =
    `REMOTE_VIEWER_FAIL ${error instanceof Error ? error.message : String(error)} ` +
    `received=${viewer.receivedPayloadBytes} frames=${viewer.receivedFrames} ` +
    `flow=${JSON.stringify(flow)} errors=${JSON.stringify(viewer.errors)} ` +
    `close=${JSON.stringify(viewer.closeInfo)}\n`;
  try {
    await viewer.close();
  } catch {
    // best effort
  }
  await writeAndExit(failLine, 1);
}
