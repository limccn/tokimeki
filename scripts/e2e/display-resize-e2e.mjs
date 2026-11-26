#!/usr/bin/env node
/**
 * Focused live e2e for v1.8 fixed-grid live resize (0.1.9).
 *
 * Required environment (same contract as live-e2e.mjs):
 *   TOKIMEKI_RELAY_URL      ws://... or wss://... (worker root, no /ws suffix)
 *   Host credential, one of:
 *     TOKIMEKI_TOKEN + TOKIMEKI_NAMESPACE
 *     TOKIMEKI_MASTER_TOKEN
 *
 * Optional:
 *   TOKIMEKI_SESSION        default: e2e-resize-<epoch>
 *   TOKIMEKI_SESSION_TOKEN  default: random
 *   E2E_TIMEOUT_MS          default: 45000
 *   E2E_DUMP_DIR            on failure, write each process's output here
 *   E2E_CLI_ENTRY           CLI entry (default packages/cli/dist/index.js)
 *   E2E_START_SIZE          fixed grid to start with (default 120x40)
 *   E2E_TARGET_SIZE         grid to resize to (default 132x43)
 *
 * Scenario:
 *   1. fixed host 120x40 + two CLI viewers + a read-only listener.
 *   2. a raw "legacy" viewer with no `display.resize` capability joins; the
 *      F12 resize editor reports the gate and the PTY stays 120x40.
 *   3. the legacy viewer leaves; the host resizes to 132x43 through the F12
 *      editor; both viewers and the listener render the new grid.
 *   4. one viewer reconnects and its welcome/snapshot already carry 132x43.
 *   5. the listener never injects input; Ctrl-C exits the session cleanly.
 *
 * Usage:
 *   TOKIMEKI_RELAY_URL=ws://127.0.0.1:8787 \
 *   TOKIMEKI_MASTER_TOKEN=test-master-token \
 *   node scripts/e2e/display-resize-e2e.mjs
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pty from "@homebridge/node-pty-prebuilt-multiarch";
import WebSocket from "ws";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = process.env.E2E_CLI_ENTRY
  ? resolve(process.env.E2E_CLI_ENTRY)
  : join(root, "packages/cli/dist/index.js");
if (!existsSync(cli)) {
  console.error(`CLI entry not found: ${cli}; run npm run build first`);
  process.exit(2);
}
const fakeTui = join(root, "scripts/e2e/fake-tui.mjs");
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 45_000);
const dumpDir = process.env.E2E_DUMP_DIR;

const relayUrl = process.env.TOKIMEKI_RELAY_URL;
const masterToken = process.env.TOKIMEKI_MASTER_TOKEN;
const hostToken = process.env.TOKIMEKI_TOKEN;
const hostNamespace = process.env.TOKIMEKI_NAMESPACE;
const useHostToken = typeof hostToken === "string" && hostToken.length > 0;
const session =
  process.env.TOKIMEKI_SESSION ??
  (useHostToken ? `${hostNamespace}.e2e-resize-${Date.now()}` : `e2e-resize-${Date.now()}`);
const sessionToken = process.env.TOKIMEKI_SESSION_TOKEN ?? randomBytes(32).toString("base64url");
const startSize = parseSize(process.env.E2E_START_SIZE ?? "120x40");
const targetSize = parseSize(process.env.E2E_TARGET_SIZE ?? "132x43");

function parseSize(raw) {
  const match = /^(\d+)x(\d+)$/.exec(raw.trim());
  if (match === null) {
    console.error("E2E_START_SIZE/E2E_TARGET_SIZE must be <cols>x<rows>");
    process.exit(2);
  }
  return { cols: Number(match[1]), rows: Number(match[2]) };
}

if (!relayUrl || (!useHostToken && !masterToken)) {
  console.error(
    "TOKIMEKI_RELAY_URL and either TOKIMEKI_TOKEN+TOKIMEKI_NAMESPACE or TOKIMEKI_MASTER_TOKEN are required",
  );
  process.exit(2);
}
if (useHostToken) {
  if (typeof hostNamespace !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(hostNamespace)) {
    console.error(
      "TOKIMEKI_NAMESPACE is required with TOKIMEKI_TOKEN (^[a-z0-9][a-z0-9_-]{0,31}$)",
    );
    process.exit(2);
  }
  if (!session.startsWith(`${hostNamespace}.`)) {
    console.error(`TOKIMEKI_SESSION must start with "${hostNamespace}." with TOKIMEKI_TOKEN`);
    process.exit(2);
  }
}

const redactionValues = new Set([masterToken, hostToken, sessionToken]);

function redactText(text) {
  let result = text;
  for (const value of redactionValues) {
    if (typeof value === "string" && value.length >= 8) {
      result = result.split(value).join("<redacted>");
    }
  }
  return result;
}

const processes = [];
let legacy = null;
let failed = false;

function commonEnv() {
  const env = { ...process.env };
  for (const key of [
    "TOKIMEKI_RELAY_URL",
    "TOKIMEKI_MASTER_TOKEN",
    "TOKIMEKI_TOKEN",
    "TOKIMEKI_NAMESPACE",
    "TOKIMEKI_NAMESPACE_TOKEN",
    "TOKIMEKI_SESSION",
    "TOKIMEKI_SESSION_TOKEN",
    "TOKIMEKI_P2P",
    "TOKIMEKI_ICE_TRANSPORT_POLICY",
    "TOKIMEKI_TUNNEL",
    "TOKIMEKI_TUNNEL_FEC",
    "TOKIMEKI_TUNNEL_SECRET",
    "TOKIMEKI_WINDOW",
    "TOKIMEKI_WINDOW_SIZE",
    "TOKIMEKI_WINDOW_TUI",
    "TOKIMEKI_LOG_VIEW_ROWS",
    "TOKIMEKI_INVITE_KEY",
    "TOKIMEKI_CONFIG",
    "TOKIMEKI_LOG_LEVEL",
  ]) {
    delete env[key];
  }
  return {
    ...env,
    TOKIMEKI_RELAY_URL: relayUrl,
    ...(useHostToken
      ? { TOKIMEKI_TOKEN: hostToken, TOKIMEKI_NAMESPACE: hostNamespace }
      : { TOKIMEKI_MASTER_TOKEN: masterToken }),
    TOKIMEKI_SESSION: session,
    TOKIMEKI_SESSION_TOKEN: sessionToken,
    TOKIMEKI_TERM: "xterm-256color",
    TOKIMEKI_COLORTERM: "truecolor",
    TOKIMEKI_HEARTBEAT_SECONDS: "10",
    TOKIMEKI_SCROLLBACK_LINES: "1000",
    TOKIMEKI_SNAPSHOT_MAX_BYTES: "262144",
    // The display-size path is control-plane; P2P is covered by live-e2e.
    TOKIMEKI_P2P: "off",
    TOKIMEKI_WINDOW: "on",
    TOKIMEKI_WINDOW_SIZE: `${startSize.cols}x${startSize.rows}`,
    TOKIMEKI_LOG_VIEW_ROWS: "8",
    TOKIMEKI_INVITE_KEY: "f12",
    TOKIMEKI_LOG_LEVEL: "debug",
  };
}

function hostEnv() {
  return commonEnv();
}

function viewerEnv() {
  return { ...commonEnv(), TOKIMEKI_LISTENER_SNAPSHOT_MS: "500" };
}

function start(name, args, env, cols = 80, rows = 24) {
  const child = pty.spawn(process.execPath, [cli, ...args], {
    name: `tokimeki-${name}`,
    cwd: root,
    cols,
    rows,
    env,
    encoding: null,
  });
  const state = { name, child, output: "", exited: false, exit: null, waiters: new Set() };
  processes.push(state);
  child.onData((data) => {
    state.output += Buffer.from(data).toString("utf8");
    for (const waiter of state.waiters) waiter();
  });
  child.onExit((event) => {
    state.exited = true;
    state.exit = event;
    for (const waiter of state.waiters) waiter();
  });
  return state;
}

function stop(state) {
  if (!state || state.exited) return;
  try {
    state.child.kill();
  } catch {
    // best effort
  }
}

function normalizeLog(text) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI stripping is intentional.
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\s+/g, " ");
}

/** Match a phrase after PTY reflow (split lines, duplicated boundary chars). */
function logIncludes(text, phrase) {
  const compact = normalizeLog(text.slice(-262_144)).replace(/\s+/g, "");
  const pattern = phrase
    .replace(/\s+/g, "")
    .split("")
    .map((ch) => `${ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}+`)
    .join("");
  return new RegExp(pattern).test(compact);
}

function waitForCheck(state, check, timeout, label) {
  if (check()) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      state.waiters.delete(waiter);
      rejectPromise(
        new Error(
          `[${state.name}] timed out waiting for ${JSON.stringify(label)}; tail=${JSON.stringify(
            redactText(state.output.slice(-1500)),
          )}`,
        ),
      );
    }, timeout);
    const waiter = () => {
      if (!check()) return;
      clearTimeout(timer);
      state.waiters.delete(waiter);
      resolvePromise();
    };
    state.waiters.add(waiter);
  });
}

function waitFor(state, needle, timeout = timeoutMs, label = needle) {
  return waitForCheck(state, () => state.output.includes(needle), timeout, label);
}

function waitForLog(state, needle, timeout = timeoutMs, label = needle) {
  return waitForCheck(state, () => logIncludes(state.output, needle), timeout, label);
}

function waitExit(state, timeout = 10_000) {
  if (state.exited) return Promise.resolve(state.exit);
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error(`[${state.name}] did not exit`)),
      timeout,
    );
    const waiter = () => {
      if (!state.exited) return;
      clearTimeout(timer);
      state.waiters.delete(waiter);
      resolvePromise(state.exit);
    };
    state.waiters.add(waiter);
  });
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function websocketUrl() {
  return `${relayUrl.replace(/^http/, "ws").replace(/\/$/, "")}/ws/${encodeURIComponent(session)}`;
}

/**
 * Raw viewer that never advertises `display.resize`, standing in for an old
 * CLI or the TokiAPI web viewer. It only needs hello/welcome; frames are
 * ignored.
 */
function startLegacyViewer() {
  const socket = new WebSocket(websocketUrl(), {
    headers: { "X-Tokimeki-Session": sessionToken },
  });
  const state = {
    name: "legacy",
    socket,
    output: "",
    ready: false,
    welcome: null,
    errored: null,
  };
  socket.on("open", () => {
    socket.send(
      JSON.stringify({
        v: 1,
        type: "hello",
        role: "viewer",
        session,
        clientId: "legacy-e2e",
        protocolVersion: 1,
        client: { name: "legacy-e2e", version: "0", kind: "test" },
        capabilities: { display: { modes: ["viewport"], logPanel: true } },
      }),
    );
  });
  socket.on("message", (data, isBinary) => {
    if (isBinary) return;
    try {
      const message = JSON.parse(Buffer.from(data).toString("utf8"));
      if (message.type === "welcome") {
        state.ready = true;
        state.welcome = message;
      }
      if (message.type === "error") state.errored = message;
    } catch {
      // ignore malformed frames
    }
  });
  socket.on("error", (error) => {
    state.errored = { message: error.message };
  });
  return state;
}

async function waitLegacyReady(state) {
  const deadline = Date.now() + 10_000;
  while (!state.ready) {
    if (state.errored !== null) {
      throw new Error(`legacy viewer failed: ${JSON.stringify(state.errored)}`);
    }
    if (Date.now() >= deadline) throw new Error("timed out waiting for the legacy welcome");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

function closeLegacy(state) {
  if (state === null) return;
  try {
    state.socket.close(1000, "e2e done");
  } catch {
    // best effort
  }
}

/** Drive the F12 resize editor from `startSize` to `targetSize` and apply. */
async function driveResizeEditor(host, target) {
  host.child.write("\x1b[24~"); // F12
  await waitForLog(host, "TOKIMEKI CONNECTION", 20_000, "connection menu");
  // Items: 1 status, 2 show/hide token, 3 copy config, 4 open log view,
  // 5 resize hosted window (fixed hosts include it; debug log view is on).
  host.child.write("5");
  await waitForLog(host, "TOKIMEKI WINDOW SIZE", 10_000, "resize editor");
  const colsDelta = target.cols - startSize.cols;
  const rowsDelta = target.rows - startSize.rows;
  let keys = "";
  if (colsDelta > 0) keys += "\x1b[C".repeat(colsDelta);
  else if (colsDelta < 0) keys += "\x1b[D".repeat(-colsDelta);
  if (rowsDelta > 0) keys += "\x1b[A".repeat(rowsDelta);
  else if (rowsDelta < 0) keys += "\x1b[B".repeat(-rowsDelta);
  if (keys.length > 0) host.child.write(keys);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  host.child.write("\r");
}

async function main() {
  console.log(
    `session=${session} relay=${relayUrl} start=${startSize.cols}x${startSize.rows} ` +
      `target=${targetSize.cols}x${targetSize.rows}`,
  );

  const host = start("host", ["run", "--", process.execPath, fakeTui], hostEnv(), 140, 40);
  await waitFor(host, "TOKIMEKI_E2E_READY");
  await waitFor(host, "relay ready:", timeoutMs, "host relay ready");
  await waitForLog(host, `SIZE=${startSize.cols}x${startSize.rows}`, timeoutMs, "fixed size");
  pass(`host fixed PTY started at ${startSize.cols}x${startSize.rows}`);

  const attach1 = start("attach1", ["attach"], viewerEnv(), 80, 24);
  await waitFor(attach1, "TOKIMEKI_E2E_READY");
  const attach2 = start("attach2", ["attach"], viewerEnv(), 120, 40);
  await waitFor(attach2, "TOKIMEKI_E2E_READY");
  await waitForLog(host, "viewers=2", timeoutMs, "two viewers");
  pass("two fixed-grid viewers attached");

  const listener = start("listener", ["attach", "--listen"], viewerEnv(), 100, 30);
  await waitFor(listener, "TOKIMEKI_E2E_READY", timeoutMs, "listener snapshot");
  pass("read-only listener attached");

  legacy = startLegacyViewer();
  await waitLegacyReady(legacy);
  await waitForLog(host, "viewer joined: legacy", timeoutMs, "legacy viewer joined");
  pass("legacy viewer without display.resize joined");

  // 1. The gate must block the resize while the legacy viewer is connected.
  await driveResizeEditor(host, targetSize);
  await waitForLog(host, "fixed-window resize", timeoutMs, "gate block");
  await waitForLog(host, "legacy-e2e does not advertise display.resize", 10_000, "gate reason");
  await waitForLog(host, "live resize blocked", 10_000, "menu gate line");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  if (logIncludes(host.output, `PTY resized to ${targetSize.cols}x${targetSize.rows}`)) {
    throw new Error("host PTY was resized while a legacy viewer was connected");
  }
  pass("legacy viewer blocked the live resize and the PTY was unchanged");

  closeLegacy(legacy);
  legacy = null;
  await waitForLog(host, "viewer left: legacy", timeoutMs, "legacy viewer left");
  pass("legacy viewer disconnected");

  // 2. Retry: every remaining client supports display.resize.
  await driveResizeEditor(host, targetSize);
  // The 40-column debug corner truncates long lines; assert the stable prefix
  // and verify the target size through the PTY/snapshot markers below.
  await waitForLog(host, "fixed display resize", timeoutMs, "display resize applied");
  await waitForLog(
    host,
    `PTY resized to ${targetSize.cols}x${targetSize.rows}`,
    timeoutMs,
    "PTY resize",
  );
  pass(`host applied the live resize to ${targetSize.cols}x${targetSize.rows}`);

  for (const viewer of [attach1, attach2, listener]) {
    await waitForLog(
      viewer,
      `SIZE=${targetSize.cols}x${targetSize.rows}`,
      timeoutMs,
      `${viewer.name} new grid`,
    );
  }
  // The status bar's logical-grid field is only updated by the display-size
  // path; together with the fixture SIZE marker it proves the new grid.
  for (const viewer of [attach1, attach2, listener]) {
    await waitForLog(
      viewer,
      `relay ${targetSize.cols}x${targetSize.rows}`,
      10_000,
      `${viewer.name} status grid`,
    );
  }
  pass("both viewers and the listener rendered the new grid");

  // 3. Listener input is ignored and never reaches the shared PTY.
  const ignored = "listener-resize-must-not-echo";
  listener.child.write(`${ignored}\r`);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
  if ([host, attach1, attach2].some((state) => state.output.includes(`ECHO:${ignored}`))) {
    throw new Error("listener input reached the shared PTY");
  }
  pass("listener stayed read-only after the resize");

  // 4. Reconnect: welcome + first snapshot already carry the new grid.
  stop(attach1);
  await waitExit(attach1, 10_000);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  const attach3 = start("attach3", ["attach"], viewerEnv(), 120, 40);
  await waitForLog(
    attach3,
    `SIZE=${targetSize.cols}x${targetSize.rows}`,
    timeoutMs,
    "reconnect grid",
  );
  await waitForLog(attach3, "view:120x39@", timeoutMs, "reconnect crop status");
  attach3.child.write("resize-reconnect-e2e\r");
  await waitForLog(attach2, "ECHO:resize-reconnect-e2e", timeoutMs, "shared control after resize");
  pass("reconnect snapshot used the updated welcome fixed size and shared control works");

  // 5. Clean shutdown.
  attach2.child.write("\u0003");
  await waitFor(host, "PTY exited (code=0)", 15_000);
  await waitFor(attach2, "host exited (code=0)", Math.min(timeoutMs, 60_000));
  await waitFor(attach3, "host exited (code=0)", Math.min(timeoutMs, 60_000));
  await waitFor(listener, "host exited (code=0)", Math.min(timeoutMs, 60_000));
  await waitExit(host, 15_000);
  await waitExit(attach2, 5_000);
  await waitExit(attach3, 5_000);
  await waitExit(listener, 5_000);
  pass("host and clients exited cleanly");
}

main()
  .then(() => {
    console.log("E2E PASS");
  })
  .catch((error) => {
    failed = true;
    console.error(`E2E FAIL: ${error instanceof Error ? error.message : String(error)}`);
    if (dumpDir !== undefined) {
      try {
        mkdirSync(dumpDir, { recursive: true });
        for (const state of processes) {
          writeFileSync(join(dumpDir, `${state.name}.log`), redactText(state.output));
        }
      } catch (dumpError) {
        console.error(`failed to dump process logs: ${String(dumpError)}`);
      }
    }
    for (const state of processes) {
      console.error(`--- ${state.name} tail ---\n${redactText(state.output.slice(-3000))}`);
    }
  })
  .finally(() => {
    closeLegacy(legacy);
    for (const state of processes) stop(state);
    setTimeout(() => process.exit(failed ? 1 : 0), 500);
  });
