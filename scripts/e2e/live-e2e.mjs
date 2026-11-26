#!/usr/bin/env node
/**
 * Live end-to-end test for the relay + PTY + (optional) P2P path.
 *
 * Required environment:
 *   TOKIMEKI_RELAY_URL      wss://... or ws://... (worker root, no /ws suffix)
 *   Host credential, one of:
 *     TOKIMEKI_TOKEN + TOKIMEKI_NAMESPACE  opaque host token (Host JWT or
 *                                          static namespace token) + its
 *                                          namespace; explicit sessions must
 *                                          start with `<namespace>.`
 *     TOKIMEKI_MASTER_TOKEN                single-owner fallback credential
 *                                          (must match the Worker secret)
 *
 * Optional:
 *   TOKIMEKI_SESSION         default: e2e-<epoch>, or
 *                            <namespace>.e2e-<epoch> in TOKIMEKI_TOKEN mode
 *   TOKIMEKI_SESSION_TOKEN  default: random
 *   REQUIRE_P2P=1            fail when no p2p-direct/p2p-turn transport is seen
 *   E2E_P2P_MODE             default: auto (use "off" for the relay-only run)
 *   E2E_ICE_POLICY           default: all (use "relay" to force TURN-only ICE)
 *   REQUIRE_P2P_FALLBACK=1   fail unless a P2P attempt fell back to relay
 *   E2E_SECRET_CHECK=1       inject dummy host secrets and assert the PTY child
 *                            cannot see their names
 *   E2E_FLOW_CONTROL=1       pause one viewer during a 4 MiB burst and require
 *                            relay pause/resume; requires E2E_P2P_MODE=off
 *   E2E_LISTENER=1           add `attach --listen`, require immediate/periodic
 *                            snapshots, and prove listener input is ignored
 *   E2E_TUNNEL=1             enable `TOKIMEKI_TUNNEL=auto` and require the TUN
 *                            data path; requires E2E_P2P_MODE=auto
 *   E2E_TUNNEL_SECRET        optional >=16-byte shared secret for relay-blind
 *                            tunnel keys (host and viewers use the same value)
 *   E2E_TUNNEL_FEC           "xor" enables XOR parity for the tunnel; requires
 *                            E2E_TUNNEL=1. Without injected packet loss this
 *                            only asserts negotiation, not recovery.
 *   E2E_TUNNEL_BURST=1       run a 4 MiB PTY burst over the tunnel and require
 *                            BURST_DONE on both viewers; requires E2E_TUNNEL=1
 *   E2E_TUNNEL_MISMATCH=1    give the host and viewers different tunnel secrets
 *                            and require relay fallback; requires E2E_TUNNEL=1
 *                            and E2E_TUNNEL_SECRET_HOST/_VIEWER
 *   E2E_WINDOW=1             fixed TUI window (`TOKIMEKI_WINDOW=on`,
 *                            `TOKIMEKI_WINDOW_SIZE=100x30`): require the host PTY
 *                            to stay fixed across viewer attach/resize, assert
 *                            viewer status bars, cursor-following crops, mouse
 *                            translation, and the debug log panel. Also runs the
 *                            F12 overlay checks unless E2E_INVITE=0.
 *   E2E_INVITE=0             skip the F12 viewer-config overlay checks
 *   E2E_CONFIG=1             start the host from TOKIMEKI_CONFIG JSON only
 *                            (explicit env still wins) and assert PTY scrub
 *   E2E_TIMEOUT_MS           default: 45000
 *   E2E_DUMP_DIR             on failure, write each process's full output here
 *   E2E_CLI_ENTRY            CLI entry to run (default: local
 *                            packages/cli/dist/index.js); point this at an
 *                            installed npm package to verify a published release
 *
 * The test starts a host CLI in a PTY and two attach CLIs, then checks:
 * snapshot restore, bidirectional input, broadcast, resize, reconnect, and
 * Ctrl-C propagation. It never writes tokens to stdout; failure diagnostics
 * redact the host/session tokens and the viewer-config base64 payload.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pty from "@homebridge/node-pty-prebuilt-multiarch";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = process.env.E2E_CLI_ENTRY
  ? resolve(process.env.E2E_CLI_ENTRY)
  : join(root, "packages/cli/dist/index.js");
if (!existsSync(cli)) {
  console.error(`CLI entry not found: ${cli}`);
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
  (useHostToken ? `${hostNamespace}.e2e-${Date.now()}` : `e2e-${Date.now()}`);
const sessionToken = process.env.TOKIMEKI_SESSION_TOKEN ?? randomBytes(32).toString("base64url");
const requireP2p = process.env.REQUIRE_P2P === "1";
const requireP2pFallback = process.env.REQUIRE_P2P_FALLBACK === "1";
const p2pMode = process.env.E2E_P2P_MODE ?? "auto";
const icePolicy = process.env.E2E_ICE_POLICY ?? "all";
const secretCheck = process.env.E2E_SECRET_CHECK === "1";
const flowControl = process.env.E2E_FLOW_CONTROL === "1";
const listenerMode = process.env.E2E_LISTENER === "1";
const tunnelMode = process.env.E2E_TUNNEL === "1";
const tunnelSecret = process.env.E2E_TUNNEL_SECRET;
const tunnelFec = process.env.E2E_TUNNEL_FEC;
const tunnelSecretHost = process.env.E2E_TUNNEL_SECRET_HOST ?? tunnelSecret;
const tunnelSecretViewer = process.env.E2E_TUNNEL_SECRET_VIEWER ?? tunnelSecret;
const tunnelBurst = process.env.E2E_TUNNEL_BURST === "1";
const tunnelMismatch = process.env.E2E_TUNNEL_MISMATCH === "1";
const windowMode = process.env.E2E_WINDOW === "1";
const inviteCheck = windowMode && process.env.E2E_INVITE !== "0";
const configEnvelope = process.env.E2E_CONFIG === "1";
const windowSize = parseSize(process.env.E2E_WINDOW_SIZE ?? "100x30");
const hostCols = windowMode ? 140 : 90;
const hostRows = windowMode ? 40 : 28;

function viewerConfigJson(cols, rows) {
  return JSON.stringify({
    version: 1,
    relayUrl,
    session,
    sessionToken,
    window: { cols, rows },
  });
}

const redactionValues = new Set([masterToken, hostToken, sessionToken]);
for (const size of [windowSize, { cols: 120, rows: 40 }, { cols: 100, rows: 30 }]) {
  redactionValues.add(
    Buffer.from(viewerConfigJson(size.cols, size.rows), "utf8").toString("base64"),
  );
}
redactionValues.add(Buffer.from(sessionToken, "utf8").toString("base64"));

function redactText(text) {
  let result = text;
  for (const value of redactionValues) {
    if (typeof value === "string" && value.length >= 8) {
      result = result.split(value).join("<redacted>");
    }
  }
  return result;
}

function parseSize(raw) {
  const match = /^(\d+)x(\d+)$/.exec(raw.trim());
  if (match === null) {
    console.error("E2E_WINDOW_SIZE must be <cols>x<rows>");
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
if (flowControl && p2pMode !== "off") {
  console.error("E2E_FLOW_CONTROL=1 requires E2E_P2P_MODE=off so output uses the relay");
  process.exit(2);
}
if (tunnelMode && p2pMode === "off") {
  console.error("E2E_TUNNEL=1 requires E2E_P2P_MODE=auto; the TUN profile is P2P-only");
  process.exit(2);
}
if (tunnelFec !== undefined && tunnelFec !== "off" && tunnelFec !== "xor") {
  console.error("E2E_TUNNEL_FEC must be off or xor");
  process.exit(2);
}
if (tunnelFec === "xor" && !tunnelMode) {
  console.error("E2E_TUNNEL_FEC=xor requires E2E_TUNNEL=1");
  process.exit(2);
}
if (tunnelBurst && !tunnelMode) {
  console.error("E2E_TUNNEL_BURST=1 requires E2E_TUNNEL=1");
  process.exit(2);
}
if (tunnelMismatch && !tunnelMode) {
  console.error("E2E_TUNNEL_MISMATCH=1 requires E2E_TUNNEL=1");
  process.exit(2);
}
if (tunnelMismatch && p2pMode === "off") {
  console.error("E2E_TUNNEL_MISMATCH=1 requires E2E_P2P_MODE=auto");
  process.exit(2);
}
if (tunnelMismatch) {
  for (const [name, value] of [
    ["E2E_TUNNEL_SECRET_HOST", tunnelSecretHost],
    ["E2E_TUNNEL_SECRET_VIEWER", tunnelSecretViewer],
  ]) {
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 16) {
      console.error(`${name} must be a >=16-byte secret for E2E_TUNNEL_MISMATCH=1`);
      process.exit(2);
    }
  }
  if (tunnelSecretHost === tunnelSecretViewer) {
    console.error("E2E_TUNNEL_MISMATCH=1 requires different host/viewer tunnel secrets");
    process.exit(2);
  }
}
if (flowControl && windowMode) {
  console.error("E2E_FLOW_CONTROL=1 and E2E_WINDOW=1 are separate scenarios");
  process.exit(2);
}
if (flowControl && (tunnelBurst || tunnelMismatch)) {
  console.error("E2E_FLOW_CONTROL=1 cannot be combined with tunnel burst/mismatch");
  process.exit(2);
}
if (tunnelBurst && tunnelMismatch) {
  console.error("E2E_TUNNEL_BURST=1 and E2E_TUNNEL_MISMATCH=1 are separate scenarios");
  process.exit(2);
}

const processes = [];
let failed = false;

function commonEnv() {
  const env = { ...process.env };
  // Do not inherit host/viewer overrides from the caller's shell; the test
  // matrix sets every knob explicitly so runs stay reproducible.
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
    TOKIMEKI_P2P: p2pMode,
    TOKIMEKI_ICE_TRANSPORT_POLICY: icePolicy,
    ...(windowMode
      ? {
          TOKIMEKI_WINDOW: "on",
          TOKIMEKI_WINDOW_SIZE: `${windowSize.cols}x${windowSize.rows}`,
          TOKIMEKI_LOG_VIEW_ROWS: "8",
          TOKIMEKI_INVITE_KEY: "f12",
        }
      : {}),
    ...(tunnelMode ? { TOKIMEKI_TUNNEL: "auto" } : {}),
    ...(tunnelMode && tunnelFec !== undefined ? { TOKIMEKI_TUNNEL_FEC: tunnelFec } : {}),
    TOKIMEKI_LOG_LEVEL: "debug",
  };
}

function viewerEnv() {
  const env = { ...commonEnv() };
  if (listenerMode) env.TOKIMEKI_LISTENER_SNAPSHOT_MS = "500";
  if (tunnelSecretViewer !== undefined) env.TOKIMEKI_TUNNEL_SECRET = tunnelSecretViewer;
  return env;
}

function configHostEnv() {
  const env = { ...commonEnv() };
  for (const key of [
    "TOKIMEKI_RELAY_URL",
    "TOKIMEKI_SESSION",
    "TOKIMEKI_SESSION_TOKEN",
    "TOKIMEKI_P2P",
    "TOKIMEKI_ICE_TRANSPORT_POLICY",
    "TOKIMEKI_WINDOW",
    "TOKIMEKI_WINDOW_SIZE",
    "TOKIMEKI_WINDOW_TUI",
    "TOKIMEKI_LOG_VIEW_ROWS",
    "TOKIMEKI_INVITE_KEY",
    "TOKIMEKI_TUNNEL",
    "TOKIMEKI_TUNNEL_FEC",
    "TOKIMEKI_TUNNEL_SECRET",
  ]) {
    delete env[key];
  }
  // Explicit env wins over the envelope; the wrong JSON session proves it.
  if (useHostToken) {
    env.TOKIMEKI_TOKEN = hostToken;
    env.TOKIMEKI_NAMESPACE = hostNamespace;
  } else {
    env.TOKIMEKI_MASTER_TOKEN = masterToken;
  }
  env.TOKIMEKI_SESSION = session;
  env.TOKIMEKI_LOG_LEVEL = "debug";
  env.TOKIMEKI_CONFIG = JSON.stringify({
    v: 1,
    relayUrl,
    session: "json-session-should-lose",
    sessionToken,
    window: { cols: windowSize.cols, rows: windowSize.rows },
    windowMode: windowMode ? "on" : "off",
    logLevel: "debug",
    p2p: p2pMode,
    iceTransportPolicy: icePolicy,
    ...(tunnelMode ? { tunnel: "auto" } : {}),
    ...(tunnelMode && tunnelFec !== undefined ? { tunnelFec } : {}),
    ...(tunnelMode && tunnelSecretHost !== undefined ? { tunnelSecret: tunnelSecretHost } : {}),
  });
  return env;
}

function hostEnv() {
  if (configEnvelope) return configHostEnv();
  const env = { ...commonEnv() };
  if (tunnelSecretHost !== undefined) env.TOKIMEKI_TUNNEL_SECRET = tunnelSecretHost;
  if (secretCheck) {
    // Dummy values only; the fixture reports presence, never values. Keep a
    // configured tunnel secret intact so host/viewer key modes still match.
    if (!tunnelMode) env.TOKIMEKI_TUNNEL_SECRET = "e2e-dummy-tunnel-secret";
    env.TOKIMEKI_COTURN_SECRET = "e2e-dummy-coturn-secret";
    env.TOKIMEKI_TURN_API_TOKEN = "e2e-dummy-turn-api-token";
    env.TOKIMEKI_TURN_CREDENTIAL = "e2e-dummy-turn-credential";
    env.TOKIMEKI_ATTACH_URL = "https://e2e.invalid/#t-dummy";
  }
  return env;
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
  const state = {
    name,
    child,
    output: "",
    exited: false,
    exit: null,
    waiters: new Set(),
  };
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

/**
 * Match a log phrase after PTY reflow. Reflow can split a line anywhere and
 * can duplicate the boundary character, so compare on compacted text and allow
 * each character to repeat.
 */
function logIncludes(text, phrase) {
  const compact = normalizeLog(text.slice(-262_144)).replace(/\s+/g, "");
  const pattern = phrase
    .replace(/\s+/g, "")
    .split("")
    .map((ch) => `${ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}+`)
    .join("");
  return new RegExp(pattern).test(compact);
}

/** Wait for a log line that PTY reflow may have split across cursor codes. */
function waitForLog(state, needle, timeout = timeoutMs, label = needle) {
  return waitForCheck(state, () => logIncludes(state.output, needle), timeout, label);
}

/** Search only the tail so multi-megabyte burst output stays cheap to scan. */
function waitForRecent(state, needle, timeout = timeoutMs, label = needle) {
  return waitForCheck(state, () => state.output.slice(-262_144).includes(needle), timeout, label);
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

/**
 * Strip terminal control sequences and line wrapping so log assertions survive
 * PTY reflow (a narrow host can split a log line across cursor-position codes).
 */
function normalizeLog(text) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI stripping is intentional.
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\s+/g, " ");
}

function waitForCount(state, needle, count, timeout = timeoutMs, label = needle) {
  const check = () => countOccurrences(state.output, needle) >= count;
  if (check()) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      state.waiters.delete(waiter);
      rejectPromise(
        new Error(
          `[${state.name}] timed out waiting for ${count}x ${JSON.stringify(label)}; tail=${JSON.stringify(
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

function lastNormalizedMatch(state, pattern) {
  const matches = [...normalizeLog(state.output).matchAll(pattern)];
  return matches.length === 0 ? null : matches[matches.length - 1];
}

function assertFixedHost(host, baseline, label) {
  if (baseline === null) return;
  const resizeCount = countOccurrences(host.output, "REASON=resize");
  if (resizeCount !== baseline.resize) {
    throw new Error(`${label}: host PTY received a resize (${baseline.resize} -> ${resizeCount})`);
  }
  const ptyCount = countOccurrences(host.output, "PTY resized to");
  if (ptyCount !== baseline.pty) {
    throw new Error(`${label}: host PTY was resized (${baseline.pty} -> ${ptyCount})`);
  }
  const size = lastNormalizedMatch(host, /SIZE=(\d+)x(\d+)/g);
  if (size === null || Number(size[1]) !== windowSize.cols || Number(size[2]) !== windowSize.rows) {
    throw new Error(`${label}: host PTY is not ${windowSize.cols}x${windowSize.rows}`);
  }
}

async function main() {
  console.log(`session=${session} relay=${relayUrl} cli=${cli}`);

  const host = start(
    "host",
    ["run", "--", process.execPath, fakeTui],
    hostEnv(),
    hostCols,
    hostRows,
  );
  await waitFor(host, "TOKIMEKI_E2E_READY");
  pass("host PTY started fake TUI");
  // Over a high-latency link the host can take several reconnect attempts to
  // register. Starting a viewer before the session exists produces a fatal
  // invalid_session, so wait for the host's relay welcome first.
  await waitFor(host, "relay ready:", timeoutMs, "host relay ready");
  pass("host connected to relay");

  let windowBaseline = null;
  if (windowMode) {
    await waitForLog(
      host,
      `SIZE=${windowSize.cols}x${windowSize.rows}`,
      timeoutMs,
      "fixed host PTY size",
    );
    windowBaseline = {
      resize: countOccurrences(host.output, "REASON=resize"),
      pty: countOccurrences(host.output, "PTY resized to"),
    };
    pass(`fixed host PTY started at ${windowSize.cols}x${windowSize.rows}`);
  }

  // Live auth check: with the session online, a bad session token must be
  // rejected by the host-token hash comparison rather than session existence.
  const bad = start("bad-attach", ["attach"], {
    ...viewerEnv(),
    TOKIMEKI_SESSION_TOKEN: randomBytes(32).toString("base64url"),
  });
  // A high-latency link can spend most of the handshake timeout before the
  // relay even sees the bad token. Wait for the auth error, then require exit.
  await waitFor(bad, "unauthorized", Math.min(timeoutMs, 60_000));
  await waitExit(bad, 10_000);
  pass("wrong session token rejected");

  const attach1 = start("attach1", ["attach"], viewerEnv(), 80, 24);
  await waitFor(attach1, "TOKIMEKI_E2E_READY");
  pass("attach1 received initial snapshot");
  if (configEnvelope) {
    // The JSON session deliberately differs from the explicit env session; a
    // successful attach proves the explicit env won.
    pass("TOKIMEKI_CONFIG host connected; viewer attached to the explicit env session");
  }

  attach1.child.write("hello-e2e\r");
  await waitFor(attach1, "ECHO:hello-e2e");
  pass("attach1 input echoed by host PTY");

  if (secretCheck || configEnvelope) {
    attach1.child.write("env-check\r");
    await waitFor(attach1, "TOKIMEKI_ENV_CHECK_DONE");
    if (!attach1.output.includes("ENV_SECRETS_PRESENT=0")) {
      throw new Error("host PTY child can see relay secret environment variables");
    }
    if (!attach1.output.includes("ENV_CONFIG_PRESENT=0")) {
      throw new Error("host PTY child can see TOKIMEKI_CONFIG");
    }
    if (!configEnvelope && !attach1.output.includes("ENV_RELAY_URL_PRESENT=yes")) {
      throw new Error("non-secret TOKIMEKI_RELAY_URL was not preserved for the PTY child");
    }
    pass(
      configEnvelope
        ? "TOKIMEKI_CONFIG applied and scrubbed from the PTY; explicit env won"
        : "host PTY child cannot see relay secrets; non-secret config preserved",
    );
  }

  const attach2 = start(
    "attach2",
    ["attach"],
    viewerEnv(),
    windowMode ? 120 : 80,
    windowMode ? 40 : 24,
  );
  await waitFor(attach2, "TOKIMEKI_E2E_READY");
  pass("attach2 received initial snapshot");

  attach2.child.write("two-e2e\r");
  await waitFor(attach1, "ECHO:two-e2e");
  await waitFor(attach2, "ECHO:two-e2e");
  pass("shared control broadcasts input to both attaches");

  if (windowMode) {
    await waitForLog(host, "viewers=2", timeoutMs, "host viewers status");
    await waitForLog(host, "f12:menu", timeoutMs, "host invite hint");
    await waitForLog(host, "view:fit", timeoutMs, "host fit status");
    if (!host.output.includes("\x1b[2m")) {
      throw new Error("debug log panel did not render");
    }
    await waitForLog(attach1, "view:80x23@", timeoutMs, "attach1 crop status");
    await waitForLog(attach2, "view:fit", timeoutMs, "attach2 fit status");
    assertFixedHost(host, windowBaseline, "after two viewers attached");
    pass("host status bar, debug log panel, and viewer crop/fit status verified");

    if (inviteCheck) {
      host.child.write("\x1b[24~");
      await waitForLog(host, "TOKIMEKI CONNECTION", 20_000, "connection menu");
      await waitForLog(host, "session token (viewer capability):", 20_000, "menu token line");
      await waitForLog(host, "c: copy config", 20_000, "menu copy hint");
      host.child.write("c");
      await waitFor(host, "\x1b]52;c;", 20_000, "OSC 52 copy");
      host.child.write("x");
      await new Promise((r) => setTimeout(r, 500));
      for (const viewer of [attach1, attach2]) {
        if (viewer.output.includes("ECHO:x") || viewer.output.includes("ECHO:c")) {
          throw new Error(`invite overlay forwarded a key to the PTY (${viewer.name})`);
        }
      }
      host.child.write("\x1b");
      await new Promise((r) => setTimeout(r, 300));
      attach1.child.write("post-invite-e2e\r");
      await waitForLog(attach1, "ECHO:post-invite-e2e", 20_000, "post-invite input");
      host.child.write("[23~");
      await waitForLog(host, "LOGS", 20_000, "F11 log view");
      host.child.write("[23~");
      await new Promise((r) => setTimeout(r, 300));
      pass("F12 menu opened, copied via OSC 52, consumed keys, closed; F11 log view toggled");
    }

    attach1.child.resize(120, 40);
    await waitForLog(attach1, "view:fit", timeoutMs, "attach1 fit after resize");
    assertFixedHost(host, windowBaseline, "after viewer resize");
    attach1.child.resize(80, 24);
    await waitForLog(attach1, "view:80x23@", timeoutMs, "attach1 crop after resize");
    assertFixedHost(host, windowBaseline, "after viewer resize restore");
    pass("viewer resize only changed its local viewport; host PTY stayed fixed");

    attach2.child.write("cursor-e2e\r");
    await waitForRecent(attach1, "CURSOR_MOVED=28,90", 20_000, "cursor move");
    await waitForCheck(
      attach1,
      () => {
        const match = lastNormalizedMatch(attach1, /view:(\d+)x(\d+)@(\d+),(\d+)/g);
        return match !== null && (Number(match[3]) > 0 || Number(match[4]) > 0);
      },
      20_000,
      "camera followed cursor",
    );
    pass("cropped viewer camera followed the TUI cursor");

    attach1.child.write("\x1b[<0;10;5M");
    await waitForLog(attach1, "MOUSE=", 20_000, "translated mouse");
    const mouse = lastNormalizedMatch(attach1, /MOUSE=(\d+),(\d+),/g);
    if (mouse === null) throw new Error("fixture did not report a translated mouse event");
    const mouseX = Number(mouse[1]);
    const mouseY = Number(mouse[2]);
    if (mouseX < 1 || mouseX > windowSize.cols || mouseY < 1 || mouseY > windowSize.rows) {
      throw new Error(`translated mouse ${mouseX},${mouseY} is outside the fixed grid`);
    }
    pass(`viewer mouse input mapped into the fixed grid (${mouseX},${mouseY})`);
  } else {
    attach1.child.resize(100, 30);
    await waitFor(attach2, "SIZE=100x30", timeoutMs, "SIZE=100x30");
    pass("resize propagated to PTY and broadcast");
  }

  // v1.1 F2: a read-only listener gets snapshots but cannot influence the PTY.
  let listener = null;
  if (listenerMode) {
    listener = start("listener", ["attach", "--listen"], viewerEnv(), 100, 30);
    await waitFor(listener, "TOKIMEKI_E2E_READY", timeoutMs, "listener initial snapshot");
    pass("listener received an immediate snapshot");

    const ignored = "listener-input-must-not-echo";
    listener.child.write(`${ignored}\r`);
    await new Promise((r) => setTimeout(r, 2_000));
    const leaked = [host, attach1, attach2].some((state) =>
      state.output.includes(`ECHO:${ignored}`),
    );
    if (leaked) {
      throw new Error("listener input reached the shared PTY");
    }
    pass("listener input was ignored and never reached the PTY");

    // The fixture echoes viewer input; the listener must see it in the next
    // periodic full snapshot without sending a resync or ACK.
    const updateMarker = "listener-periodic-e2e";
    attach2.child.write(`${updateMarker}\r`);
    await waitFor(attach2, `ECHO:${updateMarker}`, timeoutMs, "viewer echo for listener");
    await waitForRecent(
      listener,
      `ECHO:${updateMarker}`,
      20_000,
      "listener periodic snapshot update",
    );
    pass("listener received a periodic snapshot update");
  }

  if (flowControl) {
    // Stop draining attach1's stdout. Its relay reader eventually stops ACKing,
    // the relay crosses the 1 MiB unacked high-water mark, and the host pauses
    // the PTY. Resuming stdout must drain the backlog, clear the pause, and let
    // the remaining burst (including its end marker) through.
    attach1.child.pause();
    let paused = true;
    try {
      attach2.child.write("burst-e2e\r");
      await waitForRecent(host, "relay flow control pause for", 30_000, "relay pause");
      pass("relay paused the host because a viewer stopped draining");
      await new Promise((r) => setTimeout(r, 1000));
      attach1.child.resume();
      paused = false;
      await waitForRecent(host, "relay flow control resume for", 30_000, "relay resume");
      pass("viewer ACK cleared relay backpressure");
      await waitForRecent(attach1, "BURST_DONE=", 90_000, "BURST_DONE on paused viewer");
      await waitForRecent(attach2, "BURST_DONE=", 90_000, "BURST_DONE on active viewer");
      pass("4 MiB PTY burst completed on both viewers after flow-control resume");

      // The burst scrolled the original READY marker out of the visible screen.
      // Redraw so the later reconnect snapshot can assert on it again.
      attach2.child.write("redraw-e2e\r");
      await waitForRecent(attach1, "REASON=redraw", 20_000, "redraw on paused viewer");
      await waitForRecent(attach2, "REASON=redraw", 20_000, "redraw on active viewer");
      pass("fixture screen redrawn after the burst");
    } finally {
      if (paused) attach1.child.resume();
    }
  }

  // Persist a unique state marker that the TUI redraws, so a reconnect can
  // prove it received the pre-disconnect screen instead of a blank terminal.
  attach2.child.write("persist-e2e\r");
  await waitFor(attach2, "LAST_INPUT=persist-e2e");

  // Exercise the P2P data path end to end: the host must send output over the
  // DataChannel and receive viewer input over it. Both viewers need a switch
  // before we type, otherwise attach2's input may still legitimately use relay.
  let p2pDataPath = false;
  if (p2pMode !== "off") {
    if (tunnelMismatch) {
      // Different HKDF secrets make AEAD fail. The viewer detects the corrupt
      // host output and reports a relay fallback; the host may or may not also
      // see its own decrypt failure, so require the fallback, not that log.
      await waitForLog(host, "p2p unavailable for", timeoutMs, "P2P mismatch fallback");
      await waitForLog(host, "using relay", timeoutMs, "relay fallback");
      const mismatchMarker = "tunnel-mismatch-e2e";
      attach2.child.write(`${mismatchMarker}\r`);
      await waitFor(attach1, `ECHO:${mismatchMarker}`, timeoutMs, "mismatch echo on attach1");
      await waitFor(attach2, `ECHO:${mismatchMarker}`, timeoutMs, "mismatch echo on attach2");
      if (logIncludes(host.output, "tunnel unavailable for")) {
        pass("host also detected the tunnel decrypt mismatch");
      }
      pass("tunnel secret mismatch fell back to relay; input still echoed");
      // The mismatch marker changed LAST_INPUT; restore the reconnect marker.
      attach2.child.write("persist-e2e\r");
      await waitForLog(attach2, "ECHO:persist-e2e", 20_000, "persist after tunnel mismatch");
    } else {
      const outputMarker = tunnelMode
        ? "p2p output started on tunnel"
        : "p2p output started on data channel";
      try {
        await waitForCount(host, outputMarker, 2, 20_000, outputMarker);
        if (tunnelMode) {
          await waitForCount(host, "tunnel ready for", 2, 20_000, "tunnel ready for");
          const expectedKeyMode = tunnelSecretHost ? "shared-secret" : "session-token";
          const hostLog = normalizeLog(host.output);
          if (!new RegExp(`tunnel ready for .*keyMode=\\s*=?${expectedKeyMode}`).test(hostLog)) {
            throw new Error(`tunnel did not negotiate keyMode=${expectedKeyMode}`);
          }
          pass(
            tunnelSecretHost
              ? "tunnel used shared-secret keyMode (relay cannot derive the keys)"
              : "tunnel used session-token keyMode (relay can derive; not relay-blind)",
          );
          if (tunnelFec === "xor") {
            if (!/tunnel ready for .*fec=xor/.test(hostLog)) {
              throw new Error("tunnel did not negotiate XOR FEC");
            }
            // The e2e does not inject packet loss, so this only proves the XOR
            // sender policy was negotiated. Single-loss recovery has unit and
            // TunnelTransport integration coverage; real-loss e2e is unverified.
            pass("tunnel negotiated XOR FEC (no packet loss injected; recovery unverified)");
          }
        }
        await new Promise((r) => setTimeout(r, 300));
        attach2.child.write("p2p-live\r");
        await waitForLog(host, "p2p input received over data channel", 20_000);
        await waitFor(attach2, "ECHO:p2p-live", 20_000);
        if (tunnelMode && /tunnel unavailable for/.test(normalizeLog(host.output))) {
          throw new Error("the tunnel fell back to the relay during the tunnel run");
        }
        p2pDataPath = true;
        const transports = [
          ...new Set(
            [...host.output.matchAll(/p2p data channel open for \S+ \(([^)]+)\)/g)].map(
              (match) => match[1],
            ),
          ),
        ];
        if (transports.length > 0) {
          console.log(`P2P transports: ${transports.join(", ")}`);
        }
        pass(
          tunnelMode
            ? "TUN data path carried host output and viewer input"
            : "P2P data path carried host output and viewer input",
        );
        if (tunnelBurst) {
          attach2.child.write("burst-e2e\r");
          await waitForRecent(attach1, "BURST_DONE=4194304", 180_000, "tunnel burst on attach1");
          await waitForRecent(attach2, "BURST_DONE=4194304", 180_000, "tunnel burst on attach2");
          if (/tunnel unavailable for/.test(normalizeLog(host.output))) {
            throw new Error("the tunnel fell back to the relay during the burst");
          }
          pass("4 MiB PTY burst completed over the tunnel on both viewers");
          attach2.child.write("redraw-e2e\r");
          await waitForRecent(attach1, "REASON=redraw", 20_000, "redraw after tunnel burst");
          await waitForRecent(attach2, "REASON=redraw", 20_000, "redraw after tunnel burst");
          // The burst changed LAST_INPUT; restore the reconnect marker.
          attach2.child.write("persist-e2e\r");
          await waitForLog(attach2, "ECHO:persist-e2e", 20_000, "persist after tunnel burst");
        }
      } catch (error) {
        if (requireP2p || tunnelMode) throw error;
        console.log(`WARN ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // Reconnect: kill attach1, start attach3, and require the snapshot to include
  // state produced before attach1 disconnected. attach3 joins at the same size
  // so the host does not need to resize/redraw the PTY for the snapshot.
  stop(attach1);
  await waitExit(attach1, 10_000);
  await new Promise((r) => setTimeout(r, 500));
  const attach3 = start(
    "attach3",
    ["attach"],
    viewerEnv(),
    windowMode ? 140 : 100,
    windowMode ? 40 : 30,
  );
  if (windowMode) {
    await waitForLog(attach3, "relay=ready", timeoutMs, "attach3 viewport ready");
  } else {
    await waitFor(attach3, "TOKIMEKI_E2E_READY");
  }
  await waitForLog(attach3, "LAST_INPUT=persist-e2e", timeoutMs, "reconnect snapshot");
  attach3.child.write("reconnect-e2e\r");
  await waitForLog(attach3, "ECHO:reconnect-e2e", timeoutMs, "reconnect echo");
  await waitForLog(attach2, "ECHO:reconnect-e2e", timeoutMs, "reconnect broadcast");
  pass("reconnect snapshot restored earlier output and shared control still works");

  const combined = `${host.output}\n${attach2.output}\n${attach3.output}`;
  if (p2pMode === "off") {
    if (/p2p-(direct|turn)|p2p ready|p2p output started/.test(combined)) {
      throw new Error("P2P was disabled but P2P activity appeared in the logs");
    }
    pass("P2P disabled: relay-only data path verified");
  } else if (p2pDataPath) {
    pass("P2P transport established (p2p-direct or p2p-turn in logs)");
  } else if (tunnelMismatch) {
    pass("tunnel secret mismatch stayed on the relay fallback");
  } else if (requireP2p) {
    throw new Error("P2P was required but no p2p-direct/p2p-turn transport was exercised");
  } else {
    console.log("WARN P2P not observed; relay path still passed");
  }

  if (requireP2pFallback || tunnelMismatch) {
    if (!/p2p unavailable for .*using relay/.test(normalizeLog(host.output))) {
      throw new Error("P2P fallback was required but the host never logged a relay fallback");
    }
    pass("P2P attempt failed over to the relay data path");
  }

  // Ctrl-C may arrive as a stdin byte or as a ConPTY SIGINT. In both cases the
  // fake TUI exits 0 and the host reports PTY exit; final PTY output can be
  // dropped by ConPTY during teardown, so assert the lifecycle signal rather
  // than the fixture's diagnostic marker.
  attach2.child.write("\u0003");
  await waitFor(host, "PTY exited (code=0)", 15_000);
  // A half-open viewer connection may only notice the lost host-exited after
  // its heartbeat timeout (2.5 intervals). Allow it to reconnect and receive
  // the persisted host-exit replay.
  await waitFor(attach2, "host exited (code=0)", Math.min(timeoutMs, 60_000));
  await waitFor(attach3, "host exited (code=0)", Math.min(timeoutMs, 60_000));
  if (listener !== null) {
    await waitFor(listener, "host exited (code=0)", Math.min(timeoutMs, 60_000));
    pass("host exit reached the read-only listener");
  }
  pass("Ctrl-C propagated through relay to PTY and host-exited reached viewers");

  await waitExit(host, 15_000);
  await waitExit(attach2, 5_000);
  await waitExit(attach3, 5_000);
  if (listener !== null) await waitExit(listener, 5_000);
  pass("host and attached viewers exited cleanly");
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
    for (const state of processes) stop(state);
    setTimeout(() => process.exit(failed ? 1 : 0), 300);
  });
