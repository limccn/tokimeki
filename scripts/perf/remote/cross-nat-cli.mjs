import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pty from "@homebridge/node-pty-prebuilt-multiarch";

import { nowNs, nsToMs, sleep, summarizeLatency } from "../harness/metrics.mjs";
import { ensureRemoteHarness, REMOTE_HOSTS, runRemote, sshArgs } from "./ssh.mjs";

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
        reject(new Error(`cross-nat cli: timeout waiting for ${label}`));
      }
    }, 25);
  });
}

function waitForAny(read, needles, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const timer = setInterval(() => {
      const text = read();
      let found = null;
      for (const needle of needles) {
        const index = text.indexOf(needle);
        if (index >= 0 && (found === null || index < found.index)) {
          found = { needle, index };
        }
      }
      if (found !== null) {
        clearInterval(timer);
        resolvePromise(found.needle);
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`cross-nat cli: timeout waiting for ${label}`));
      }
    }, 25);
  });
}

async function removeRemoteEnvFile(remote, envFile) {
  try {
    await runRemote({
      remote,
      command: `rm -f ${envFile}`,
      timeoutMs: 15_000,
    });
  } catch {
    // best effort
  }
}

/** Keep diagnostics readable: ANSI-stripped transport-relevant attach lines. */
function transportLines(text) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip PTY ANSI escapes
  const ansi = /\x1b\[[0-9;?]*[a-zA-Z]/g;
  return text
    .replace(ansi, "")
    .split(/\r?\n/)
    .filter((line) => /p2p|transport|ice|relay|attached/i.test(line))
    .slice(-12)
    .join("\n");
}

/**
 * Real-CLI cross-NAT P2P measurement: local host runs `tokimeki run` with the
 * deterministic TUI; the remote VPS runs `tokimeki attach` inside a remote PTY
 * wrapper. The session token is written to a remote 0600 temp env file (not
 * argv), and deleted after the run.
 */
export async function runCrossNatCli({
  relayUrl,
  masterToken,
  remote,
  mode,
  bytes = 8 * 1024 * 1024,
  rttSamples = 20,
  timeoutMs = 120_000,
}) {
  const target = REMOTE_HOSTS[remote];
  if (target === undefined) {
    throw new Error(`unknown remote: ${remote}`);
  }
  if (mode !== "direct" && mode !== "turn" && mode !== "fallback") {
    throw new Error(`cross-nat cli mode must be direct, turn or fallback, got ${mode}`);
  }
  await ensureRemoteHarness(remote);
  const policy = mode === "direct" ? "all" : "relay";
  const session = `perf-xnat-cli-${remote}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionToken = randomBytes(32).toString("base64url");
  const envFile = `/tmp/tokimeki-xnat-env-${session}`;
  const envText = [
    `TOKIMEKI_RELAY_URL=${relayUrl}`,
    `TOKIMEKI_SESSION=${session}`,
    `TOKIMEKI_SESSION_TOKEN=${sessionToken}`,
    "TOKIMEKI_P2P=auto",
    `TOKIMEKI_ICE_TRANSPORT_POLICY=${policy}`,
    "TOKIMEKI_LOG_LEVEL=debug",
    "TOKIMEKI_TERM=xterm-256color",
    "TOKIMEKI_COLORTERM=truecolor",
    "",
  ].join("\n");

  const created = await runRemote({
    remote,
    command: `umask 077; cat > ${envFile}`,
    input: envText,
    timeoutMs: 30_000,
  });
  if (created.code !== 0) {
    // The file may exist even when the SSH channel failed late.
    await removeRemoteEnvFile(remote, envFile);
    throw new Error(`cross-nat cli: remote env file failed: ${created.stderr}`);
  }

  const hostEnv = {
    ...process.env,
    TOKIMEKI_RELAY_URL: relayUrl,
    TOKIMEKI_MASTER_TOKEN: masterToken,
    TOKIMEKI_SESSION: session,
    TOKIMEKI_SESSION_TOKEN: sessionToken,
    TOKIMEKI_P2P: "auto",
    TOKIMEKI_ICE_TRANSPORT_POLICY: policy,
    TOKIMEKI_LOG_LEVEL: "debug",
    TOKIMEKI_TERM: "xterm-256color",
    TOKIMEKI_COLORTERM: "truecolor",
  };
  let host;
  try {
    host = pty.spawn(process.execPath, [cli, "run", "--", process.execPath, emitTui], {
      name: "perf-xnat-cli-host",
      cwd: root,
      cols: 90,
      rows: 28,
      env: hostEnv,
      encoding: null,
    });
  } catch (error) {
    // Never leave the session token behind if the local host cannot start.
    await removeRemoteEnvFile(remote, envFile);
    throw error;
  }
  let hostOut = "";
  let hostExit = null;
  host.onData((data) => {
    hostOut += Buffer.from(data).toString("utf8");
  });
  host.onExit(({ exitCode }) => {
    hostExit = exitCode;
  });

  let attach = null;
  let attachOut = "";
  let attachErr = "";
  let attachExit = null;
  try {
    await waitFor(() => hostOut, "PERF_TUI_READY", 30_000, "host TUI ready");
    await waitFor(() => hostOut, "relay ready", 30_000, "host relay ready");

    const command =
      `trap 'rm -f ${envFile}' EXIT; cd /opt/tokimeki && set -a && . ${envFile} && set +a && ` +
      "node scripts/perf/remote/remote-attach-pty.mjs";
    attach = spawn("ssh", [...sshArgs({ ...target, tty: false }), command], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    attach.stdin.on("error", () => {
      // The remote attach may exit before stdin is written; ignore EPIPE.
    });
    attach.stdout.on("data", (data) => {
      attachOut += data.toString("utf8");
    });
    attach.stderr.on("data", (data) => {
      attachErr += data.toString("utf8");
    });
    attach.on("close", (code) => {
      attachExit = code;
    });

    try {
      await waitFor(() => attachOut, "PERF_TUI_READY", 60_000, "remote attach snapshot");
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `--- attach stdout ---\n${attachOut.slice(-2000)}\n` +
          `--- attach stderr ---\n${attachErr.slice(-2000)}`,
      );
    }
    let p2pOutcome;
    const p2pStartedAt = Date.now();
    try {
      p2pOutcome = await waitForAny(
        () => hostOut,
        ["p2p data channel open", "p2p unavailable", "using relay"],
        45_000,
        "p2p outcome",
      );
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `--- host ---\n${hostOut.slice(-4000)}\n` +
          `--- attach transport ---\n${transportLines(attachOut)}\n` +
          `--- attach stdout ---\n${attachOut.slice(-2000)}\n` +
          `--- attach stderr ---\n${attachErr.slice(-2000)}`,
      );
    }
    const p2pElapsedMs = Date.now() - p2pStartedAt;
    if (mode !== "fallback" && p2pOutcome !== "p2p data channel open") {
      throw new Error(
        `p2p ${mode} failed: ${hostOut.slice(-2000)}\n` +
          `--- attach transport ---\n${transportLines(attachOut)}\n` +
          `--- attach ---\n${attachOut.slice(-1000)}\n` +
          `--- attach stderr ---\n${attachErr.slice(-1000)}`,
      );
    }
    let transportMode = "relay";
    if (p2pOutcome === "p2p data channel open") {
      await waitFor(() => hostOut, "p2p ready", 15_000, "p2p ready");
      const modeMatch = hostOut.match(/\((p2p-(?:direct|turn)[^)]*)\)/);
      transportMode = modeMatch?.[1] ?? "unknown";
    }
    // Anything logged from here on belongs to the measurement window; a
    // fallback to relay during RTT/burst must not be reported as p2p.
    const measuredFromHost = hostOut.length;
    const measuredFromAttach = attachOut.length;

    const rtts = [];
    for (let index = 0; index < rttSamples; index += 1) {
      const nonce = `xnat${index}-${Date.now()}`;
      const startedAt = nowNs();
      attach.stdin.write(`rtt ${nonce}\r`);
      await waitFor(
        () => attachOut,
        `PERF_RTT:${nonce}`,
        Math.min(timeoutMs, 30_000),
        `RTT ${index}`,
      );
      rtts.push(nsToMs(nowNs() - startedAt));
    }

    const startedAt = nowNs();
    attach.stdin.write(`start ${bytes}\r`);
    await waitFor(() => attachOut, `PERF_DATA_END ${bytes}`, timeoutMs, "burst end");
    const finishedAt = nowNs();
    const durationMs = Math.max(1, nsToMs(finishedAt - startedAt));
    const iceProvider = hostOut.match(/ice provider: ([^\s(]+)/)?.[1] ?? "unknown";
    const errors = [];
    if (
      transportMode.startsWith("p2p-") &&
      (/p2p unavailable/.test(hostOut.slice(measuredFromHost)) ||
        /relay fallback active/.test(attachOut.slice(measuredFromAttach)))
    ) {
      errors.push("p2p fell back to relay during the measurement window");
    }
    return {
      session,
      remote,
      mode,
      transportMode,
      iceProvider,
      p2pOutcome,
      fallbackMs: p2pOutcome === "p2p data channel open" ? null : p2pElapsedMs,
      payloadBytes: bytes,
      durationMs: Math.round(durationMs * 1000) / 1000,
      throughputBytesPerSec: Math.round(bytes / (durationMs / 1000)),
      latencyMs: summarizeLatency(rtts),
      hostExit,
      attachExit,
      errors,
    };
  } finally {
    if (attach !== null) {
      try {
        attach.stdin.write("\u0003");
      } catch {
        // best effort
      }
      await sleep(500);
      try {
        attach.kill();
      } catch {
        // best effort
      }
    }
    try {
      host.kill();
    } catch {
      // best effort
    }
    await removeRemoteEnvFile(remote, envFile);
  }
}
