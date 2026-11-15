#!/usr/bin/env node
/**
 * Strict-NAT viewer runner.
 *
 * Spawns `tokimeki attach` in a PTY, waits for the host's perf TUI, sends one
 * RTT probe and one burst, and reports the observed transport/log lines.
 * The session token is read from the environment, never argv.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workDir =
  process.env.TOKIMEKI_VIEWER_WORKDIR !== undefined
    ? resolve(process.env.TOKIMEKI_VIEWER_WORKDIR)
    : undefined;
const requireFrom =
  workDir === undefined
    ? createRequire(import.meta.url)
    : createRequire(join(workDir, "package.json"));
const pty = requireFrom("@homebridge/node-pty-prebuilt-multiarch");
const cli =
  process.env.TOKIMEKI_VIEWER_CLI ??
  (workDir === undefined
    ? join(root, "packages/cli/dist/index.js")
    : join(workDir, "node_modules", "@limccn", "tokimeki", "dist", "index.js"));

if (!fs.existsSync(cli)) {
  console.error(`viewer-runner: CLI not found at ${cli}`);
  process.exit(2);
}

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

const mode = argument("mode", "direct");
const bytes = Number(argument("bytes", String(1024 * 1024)));
const timeoutMs = Number(argument("timeout-ms", "120000"));
const label = argument("label", "viewer");
const relayUrl = process.env.TOKIMEKI_RELAY_URL ?? "wss://relay.tokiapi.app";
const session = process.env.TOKIMEKI_SESSION;
const token = process.env.TOKIMEKI_SESSION_TOKEN;

if (mode !== "direct" && mode !== "turn") {
  console.error("viewer-runner: --mode must be direct or turn");
  process.exit(2);
}
if (!session || !token) {
  console.error("viewer-runner: TOKIMEKI_SESSION and TOKIMEKI_SESSION_TOKEN are required");
  process.exit(2);
}
if (!Number.isFinite(bytes) || bytes <= 0) {
  console.error("viewer-runner: --bytes must be positive");
  process.exit(2);
}

const policy = mode === "turn" ? "relay" : "all";
const child = pty.spawn(process.execPath, [cli, "attach"], {
  name: "tokimeki-strictnat-viewer",
  cwd: workDir ?? root,
  cols: 90,
  rows: 28,
  env: {
    ...process.env,
    TOKIMEKI_RELAY_URL: relayUrl,
    TOKIMEKI_SESSION: session,
    TOKIMEKI_P2P: "auto",
    TOKIMEKI_ICE_TRANSPORT_POLICY: policy,
    TOKIMEKI_TERM: "xterm-256color",
    TOKIMEKI_COLORTERM: "truecolor",
    TOKIMEKI_LOG_LEVEL: "debug",
  },
  encoding: null,
});

let output = "";
child.onData((data) => {
  output += Buffer.from(data).toString("utf8");
});

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function ansiFree(text) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip PTY ANSI escapes
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

function waitFor(needle, ms, description) {
  const deadline = Date.now() + ms;
  return new Promise((resolvePromise, reject) => {
    const timer = setInterval(() => {
      if (output.includes(needle)) {
        clearInterval(timer);
        resolvePromise();
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`timeout waiting for ${description}`));
      }
    }, 25);
  });
}

async function finish(code, line) {
  try {
    child.kill();
  } catch {
    // best effort
  }
  await new Promise((resolvePromise) => {
    process.stdout.write(line, resolvePromise);
  });
  process.exit(code);
}

try {
  await waitFor("PERF_TUI_READY", timeoutMs, "remote TUI ready");
  const nonce = `strictnat-${label}-${Date.now()}`;
  const rttStarted = Date.now();
  child.write(`rtt ${nonce}\r`);
  await waitFor(`PERF_RTT:${nonce}`, Math.min(timeoutMs, 30_000), "RTT marker");
  const rttMs = Date.now() - rttStarted;

  const burstStarted = Date.now();
  child.write(`start ${bytes}\r`);
  await waitFor(`PERF_DATA_END ${bytes}`, timeoutMs, "burst end marker");
  const durationMs = Math.max(1, Date.now() - burstStarted);

  const transport = ansiFree(output)
    .split(/\r?\n/)
    .filter((line) => /p2p|transport|relay ready|iceProvider|route selector/i.test(line))
    .slice(-12);

  const result = {
    ok: true,
    label,
    mode,
    policy,
    session,
    bytes,
    rttMs,
    durationMs,
    throughputBytesPerSec: Math.round(bytes / (durationMs / 1000)),
    transport,
  };
  child.write("quit\r");
  await sleep(500);
  await finish(0, `VIEWER_RESULT ${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const tail = ansiFree(output).slice(-6000);
  await finish(1, `VIEWER_FAIL ${message}\n--- attach tail ---\n${tail}\n`);
}
