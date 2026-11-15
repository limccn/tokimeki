import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pty from "@homebridge/node-pty-prebuilt-multiarch";

import { nowNs, nsToMs, sleep, summarizeLatency } from "./metrics.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = join(root, "packages/cli/dist/index.js");
const emitTui = join(root, "scripts/perf/emit-tui.mjs");

function waitFor(read, needle, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const timer = setInterval(() => {
      if (read().includes(needle)) {
        clearInterval(timer);
        resolvePromise();
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`p2p: timeout waiting for ${label}`));
      }
    }, 25);
  });
}

/**
 * Run a real CLI host + attach over the relay and measure the P2P data path.
 *
 * Returns transport mode, RTT samples, and end-to-end burst throughput. The
 * burst is emitted by `scripts/perf/emit-tui.mjs`; the host/attach run in PTYs
 * exactly like a user session.
 */
export async function runRealP2P({
  relayUrl,
  masterToken,
  session,
  sessionToken,
  bytes = 8 * 1024 * 1024,
  rttSamples = 20,
  timeoutMs = 120_000,
}) {
  const baseEnv = {
    ...process.env,
    TOKIMEKI_RELAY_URL: relayUrl,
    TOKIMEKI_SESSION: session,
    TOKIMEKI_SESSION_TOKEN: sessionToken,
    TOKIMEKI_P2P: "auto",
    TOKIMEKI_LOG_LEVEL: "debug",
    TOKIMEKI_TERM: "xterm-256color",
    TOKIMEKI_COLORTERM: "truecolor",
  };
  const hostEnv = { ...baseEnv, TOKIMEKI_MASTER_TOKEN: masterToken };
  const viewerEnv = { ...baseEnv };
  delete viewerEnv.TOKIMEKI_MASTER_TOKEN;

  const host = pty.spawn(process.execPath, [cli, "run", "--", process.execPath, emitTui], {
    name: "perf-p2p-host",
    cwd: root,
    cols: 90,
    rows: 28,
    env: hostEnv,
    encoding: null,
  });

  let hostOut = "";
  let hostExit = null;
  host.onData((data) => {
    hostOut += Buffer.from(data).toString("utf8");
  });
  host.onExit(({ exitCode }) => {
    hostExit = exitCode;
  });

  let viewer = null;
  let viewerOut = "";
  let viewerExit = null;

  try {
    // The viewer must attach after the host has created the session; otherwise
    // the relay returns host-offline/invalid-session and the snapshot never
    // arrives.
    await waitFor(() => hostOut, "PERF_TUI_READY", 30_000, "host TUI ready");
    await waitFor(() => hostOut, "relay ready", 30_000, "host relay ready");
    viewer = pty.spawn(process.execPath, [cli, "attach"], {
      name: "perf-p2p-viewer",
      cwd: root,
      cols: 80,
      rows: 24,
      env: viewerEnv,
      encoding: null,
    });
    viewer.onData((data) => {
      viewerOut += Buffer.from(data).toString("utf8");
    });
    viewer.onExit(({ exitCode }) => {
      viewerExit = exitCode;
    });

    await waitFor(() => viewerOut, "PERF_TUI_READY", 30_000, "viewer snapshot");
    await waitFor(() => hostOut, "p2p ready", 20_000, "p2p ready");
    const modeMatch = hostOut.match(/\((p2p-(?:direct|turn)[^)]*)\)/);
    const transportMode = modeMatch?.[1] ?? "unknown";

    const rtts = [];
    for (let index = 0; index < rttSamples; index += 1) {
      const nonce = `p2p${index}-${Date.now()}`;
      const startedAt = nowNs();
      viewer.write(`rtt ${nonce}\r`);
      await waitFor(
        () => viewerOut,
        `PERF_RTT:${nonce}`,
        Math.min(timeoutMs, 10_000),
        `RTT ${index}`,
      );
      rtts.push(nsToMs(nowNs() - startedAt));
    }

    const startedAt = nowNs();
    viewer.write(`start ${bytes}\r`);
    await waitFor(() => viewerOut, "PERF_DATA_END", timeoutMs, "burst end");
    const finishedAt = nowNs();
    const durationMs = Math.max(1, nsToMs(finishedAt - startedAt));
    return {
      transportMode,
      payloadBytes: bytes,
      durationMs: Math.round(durationMs * 1000) / 1000,
      throughputBytesPerSec: Math.round(bytes / (durationMs / 1000)),
      latencyMs: summarizeLatency(rtts),
      hostExit,
      viewerExit,
      errors: hostExit !== null && hostExit !== 0 ? [`host exit ${hostExit}`] : [],
    };
  } finally {
    if (viewer !== null) {
      try {
        viewer.write("\u0003");
      } catch {
        // best effort
      }
    }
    await sleep(500);
    try {
      host.kill();
    } catch {
      // best effort
    }
    if (viewer !== null) {
      try {
        viewer.kill();
      } catch {
        // best effort
      }
    }
  }
}
