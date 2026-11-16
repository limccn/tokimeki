#!/usr/bin/env node
/**
 * Live e2e for the v1.1 P2P direct snapshot path.
 *
 * Required environment:
 *   TOKIMEKI_RELAY_URL      worker root (ws:// or wss://, no /ws suffix)
 *   TOKIMEKI_MASTER_TOKEN   matching Worker secret
 *
 * Optional:
 *   TOKIMEKI_SESSION, TOKIMEKI_SESSION_TOKEN, E2E_TIMEOUT_MS, E2E_DUMP_DIR
 *
 * The host fills the headless mirror with a 4 MiB burst before a viewer joins,
 * so the P2P switch snapshot is larger than one DataChannel message. The test
 * then requires:
 *   - host fragment/snapshot logs and a viewer `via=p2p` snapshot > 16 KiB;
 *   - no relay SNAPSHOT_TO for that viewer between DataChannel open and
 *     `transport ready`;
 *   - post-switch input/output over the DataChannel.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pty from "@homebridge/node-pty-prebuilt-multiarch";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(root, "packages/cli/dist/index.js");
const fakeTui = join(root, "scripts/e2e/fake-tui.mjs");
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 90_000);
const dumpDir = process.env.E2E_DUMP_DIR;

const relayUrl = process.env.TOKIMEKI_RELAY_URL;
const masterToken = process.env.TOKIMEKI_MASTER_TOKEN;
const session = process.env.TOKIMEKI_SESSION ?? `p2p-snapshot-${Date.now()}`;
const sessionToken = process.env.TOKIMEKI_SESSION_TOKEN ?? randomBytes(32).toString("base64url");

if (!relayUrl || !masterToken) {
  console.error("TOKIMEKI_RELAY_URL and TOKIMEKI_MASTER_TOKEN are required");
  process.exit(2);
}

const processes = [];
let failed = false;

function baseEnv() {
  return {
    ...process.env,
    TOKIMEKI_RELAY_URL: relayUrl,
    TOKIMEKI_MASTER_TOKEN: masterToken,
    TOKIMEKI_SESSION: session,
    TOKIMEKI_SESSION_TOKEN: sessionToken,
    TOKIMEKI_TERM: "xterm-256color",
    TOKIMEKI_COLORTERM: "truecolor",
    TOKIMEKI_HEARTBEAT_SECONDS: "10",
    TOKIMEKI_SCROLLBACK_LINES: "1000",
    TOKIMEKI_SNAPSHOT_MAX_BYTES: "262144",
    TOKIMEKI_P2P: "auto",
    TOKIMEKI_ICE_TRANSPORT_POLICY: "all",
    TOKIMEKI_LOG_LEVEL: "debug",
  };
}

function start(name, args, cols = 90, rows = 28) {
  const child = pty.spawn(process.execPath, [cli, ...args], {
    name: `tokimeki-${name}`,
    cwd: root,
    cols,
    rows,
    env: baseEnv(),
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

function waitFor(state, needle, timeout = timeoutMs, label = needle) {
  const check = () => state.output.includes(needle);
  if (check()) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      state.waiters.delete(waiter);
      rejectPromise(
        new Error(
          `[${state.name}] timed out waiting for ${JSON.stringify(label)}; ` +
            `tail=${JSON.stringify(state.output.slice(-1500))}`,
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

function waitExit(state, timeout = 15_000) {
  if (state.exited) return Promise.resolve(state.exit);
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      state.waiters.delete(waiter);
      resolvePromise(null);
    }, timeout);
    const waiter = () => {
      if (!state.exited) return;
      clearTimeout(timer);
      state.waiters.delete(waiter);
      resolvePromise(state.exit);
    };
    state.waiters.add(waiter);
  });
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function dumpOutputs() {
  if (!dumpDir) return;
  try {
    mkdirSync(dumpDir, { recursive: true });
    for (const state of processes) {
      writeFileSync(join(dumpDir, `${state.name}.log`), state.output);
    }
  } catch (error) {
    console.error(`failed to dump logs: ${String(error)}`);
  }
}

async function main() {
  console.log(`session=${session} relay=${relayUrl}`);
  // Wide host PTY: stderr debug lines must not wrap before the e2e parser sees
  // them. The inner PTY is resized to the viewer's 80x24 after attach.
  const host = start("host", ["run", "--", process.execPath, fakeTui], 200, 40);
  await waitFor(host, "TOKIMEKI_E2E_READY");
  await waitFor(host, "relay ready:", timeoutMs, "host relay ready");
  pass("host PTY and relay ready");

  // Fill the headless mirror's scrollback before the viewer attaches. The
  // resulting switch snapshot is tens of KiB, well above one DC message.
  host.child.write("burst-e2e\r");
  await waitFor(host, "BURST_DONE=4194304", timeoutMs, "host 4 MiB burst");
  await sleep(500);
  pass("host mirror filled with a large screen");

  const viewer = start("viewer", ["attach"], 80, 24);
  await waitFor(viewer, "TOKIMEKI_E2E_READY");
  pass("viewer attached");

  const viewerIdMatch = /viewer joined: ([A-Za-z0-9._-]+)/.exec(host.output);
  if (viewerIdMatch === null) throw new Error("host did not log the viewer client id");
  const viewerId = viewerIdMatch[1];
  await waitFor(host, `p2p snapshot sent (target=${viewerId}`, timeoutMs, "host P2P snapshot log");
  await waitFor(host, `p2p ready for ${viewerId}`, timeoutMs, "host P2P ready");

  // Attach mutes stderr logging while the alternate screen is active, so the
  // viewer's own debug line is intentionally unavailable. The host log proves
  // the switch snapshot went over the DataChannel; the viewer's rendered burst
  // content proves it applied a snapshot containing the large screen.
  const p2pSnapshotPattern =
    /p2p snapshot sent \(target=[^,]+, seq=\d+, bytes=(\d+), fragments=(\d+)\)/g;
  let lastSnapshot = null;
  for (const match of host.output.matchAll(p2pSnapshotPattern)) lastSnapshot = match;
  if (lastSnapshot === null) throw new Error("host did not log a P2P snapshot");
  const snapshotBytes = Number(lastSnapshot[1]);
  const snapshotFragments = Number(lastSnapshot[2]);
  if (!Number.isFinite(snapshotBytes) || snapshotBytes <= 16_384) {
    throw new Error(`P2P switch snapshot was not large enough: ${snapshotBytes} bytes`);
  }
  if (!Number.isFinite(snapshotFragments) || snapshotFragments <= 1) {
    throw new Error(`P2P switch snapshot was not fragmented: ${snapshotFragments} fragments`);
  }
  if (!viewer.output.includes("0123456789abcdef")) {
    throw new Error("viewer never rendered the burst-filled snapshot content");
  }
  pass(
    `P2P switch snapshot was ${snapshotBytes} bytes in ${snapshotFragments} fragments ` +
      "and reached the viewer",
  );

  const openIndex = host.output.indexOf(`p2p data channel open for ${viewerId}`);
  const readyIndex = host.output.indexOf(`p2p ready for ${viewerId}`);
  if (openIndex < 0 || readyIndex < openIndex) {
    throw new Error("could not locate the P2P switch window in host logs");
  }
  const switchWindow = host.output.slice(openIndex, readyIndex);
  if (switchWindow.includes(`relay snapshot sent (target=${viewerId}`)) {
    throw new Error("host fell back to a relay snapshot during the P2P switch");
  }
  pass("P2P switch snapshot used the DataChannel, not relay SNAPSHOT_TO");

  viewer.child.write("p2p-snapshot-live\r");
  await waitFor(host, `p2p input received over data channel from ${viewerId}`);
  await waitFor(viewer, "ECHO:p2p-snapshot-live");
  pass("post-switch input/output travelled over the DataChannel");

  viewer.child.write("\u0003");
  await waitFor(host, "PTY exited (code=0)", 20_000);
  await waitFor(viewer, "host exited (code=0)", Math.min(timeoutMs, 60_000));
  pass("Ctrl-C propagated and both sessions exited cleanly");
}

main()
  .then(async () => {
    for (const state of processes) stop(state);
    await Promise.all(processes.map((state) => waitExit(state, 5_000)));
    console.log("E2E PASS");
  })
  .catch(async (error) => {
    failed = true;
    console.error(`E2E FAIL: ${error instanceof Error ? error.message : String(error)}`);
    dumpOutputs();
    for (const state of processes) stop(state);
    await Promise.all(processes.map((state) => waitExit(state, 5_000)));
  })
  .finally(() => {
    setTimeout(() => process.exit(failed ? 1 : 0), 300);
  });
