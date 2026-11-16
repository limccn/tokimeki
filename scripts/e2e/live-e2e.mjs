#!/usr/bin/env node
/**
 * Live end-to-end test for the relay + PTY + (optional) P2P path.
 *
 * Required environment:
 *   TOKIMEKI_RELAY_URL      wss://... or ws://... (worker root, no /ws suffix)
 *   TOKIMEKI_MASTER_TOKEN   must match the deployed/local Worker secret
 *
 * Optional:
 *   TOKIMEKI_SESSION         default: e2e-<epoch>
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
 *   E2E_TIMEOUT_MS           default: 45000
 *   E2E_DUMP_DIR             on failure, write each process's full output here
 *
 * The test starts a host CLI in a PTY and two attach CLIs, then checks:
 * snapshot restore, bidirectional input, broadcast, resize, reconnect, and
 * Ctrl-C propagation. It never writes tokens to stdout.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pty from "@homebridge/node-pty-prebuilt-multiarch";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(root, "packages/cli/dist/index.js");
const fakeTui = join(root, "scripts/e2e/fake-tui.mjs");
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 45_000);
const dumpDir = process.env.E2E_DUMP_DIR;

const relayUrl = process.env.TOKIMEKI_RELAY_URL;
const masterToken = process.env.TOKIMEKI_MASTER_TOKEN;
const session = process.env.TOKIMEKI_SESSION ?? `e2e-${Date.now()}`;
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

if (!relayUrl || !masterToken) {
  console.error("TOKIMEKI_RELAY_URL and TOKIMEKI_MASTER_TOKEN are required");
  process.exit(2);
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
    TOKIMEKI_P2P: p2pMode,
    TOKIMEKI_ICE_TRANSPORT_POLICY: icePolicy,
    ...(listenerMode ? { TOKIMEKI_LISTENER_SNAPSHOT_MS: "500" } : {}),
    ...(tunnelMode ? { TOKIMEKI_TUNNEL: "auto" } : {}),
    ...(tunnelMode && tunnelFec !== undefined ? { TOKIMEKI_TUNNEL_FEC: tunnelFec } : {}),
    ...(tunnelSecret === undefined ? {} : { TOKIMEKI_TUNNEL_SECRET: tunnelSecret }),
    TOKIMEKI_LOG_LEVEL: "debug",
  };
}

function hostEnv() {
  const env = { ...baseEnv(), TOKIMEKI_LOG_LEVEL: "debug" };
  if (secretCheck) {
    // Dummy values only; the fixture reports presence, never values. Keep a
    // configured tunnel secret intact so host/viewer key modes still match.
    if (!tunnelMode) env.TOKIMEKI_TUNNEL_SECRET = "e2e-dummy-tunnel-secret";
    env.TOKIMEKI_COTURN_SECRET = "e2e-dummy-coturn-secret";
    env.TOKIMEKI_TURN_API_TOKEN = "e2e-dummy-turn-api-token";
    env.TOKIMEKI_TURN_CREDENTIAL = "e2e-dummy-turn-credential";
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
            state.output.slice(-1500),
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

/** Search only the tail so multi-megabyte burst output stays cheap to scan. */
function waitForRecent(state, needle, timeout = timeoutMs, label = needle) {
  return waitForCheck(state, () => state.output.slice(-262_144).includes(needle), timeout, label);
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
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
            state.output.slice(-1500),
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

async function main() {
  console.log(`session=${session} relay=${relayUrl}`);

  const host = start("host", ["run", "--", process.execPath, fakeTui], hostEnv(), 90, 28);
  await waitFor(host, "TOKIMEKI_E2E_READY");
  pass("host PTY started fake TUI");
  // Over a high-latency link the host can take several reconnect attempts to
  // register. Starting a viewer before the session exists produces a fatal
  // invalid_session, so wait for the host's relay welcome first.
  await waitFor(host, "relay ready:", timeoutMs, "host relay ready");
  pass("host connected to relay");

  // Live auth check: with the session online, a bad session token must be
  // rejected by the host-token hash comparison rather than session existence.
  const bad = start("bad-attach", ["attach"], {
    ...baseEnv(),
    TOKIMEKI_SESSION_TOKEN: randomBytes(32).toString("base64url"),
  });
  // A high-latency link can spend most of the handshake timeout before the
  // relay even sees the bad token. Wait for the auth error, then require exit.
  await waitFor(bad, "unauthorized", Math.min(timeoutMs, 60_000));
  await waitExit(bad, 10_000);
  pass("wrong session token rejected");

  const attach1 = start("attach1", ["attach"], baseEnv(), 80, 24);
  await waitFor(attach1, "TOKIMEKI_E2E_READY");
  pass("attach1 received initial snapshot");

  attach1.child.write("hello-e2e\r");
  await waitFor(attach1, "ECHO:hello-e2e");
  pass("attach1 input echoed by host PTY");

  if (secretCheck) {
    attach1.child.write("env-check\r");
    await waitFor(attach1, "TOKIMEKI_ENV_CHECK_DONE");
    if (!attach1.output.includes("ENV_SECRETS_PRESENT=0")) {
      throw new Error("host PTY child can see relay secret environment variables");
    }
    if (!attach1.output.includes("ENV_RELAY_URL_PRESENT=yes")) {
      throw new Error("non-secret TOKIMEKI_RELAY_URL was not preserved for the PTY child");
    }
    pass("host PTY child cannot see relay secrets; non-secret config preserved");
  }

  const attach2 = start("attach2", ["attach"], baseEnv(), 80, 24);
  await waitFor(attach2, "TOKIMEKI_E2E_READY");
  pass("attach2 received initial snapshot");

  attach2.child.write("two-e2e\r");
  await waitFor(attach1, "ECHO:two-e2e");
  await waitFor(attach2, "ECHO:two-e2e");
  pass("shared control broadcasts input to both attaches");

  attach1.child.resize(100, 30);
  await waitFor(attach2, "SIZE=100x30", timeoutMs, "SIZE=100x30");
  pass("resize propagated to PTY and broadcast");

  // v1.1 F2: a read-only listener gets snapshots but cannot influence the PTY.
  let listener = null;
  if (listenerMode) {
    listener = start("listener", ["attach", "--listen"], baseEnv(), 100, 30);
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
    const outputMarker = tunnelMode
      ? "p2p output started on tunnel"
      : "p2p output started on data channel";
    try {
      await waitForCount(host, outputMarker, 2, 20_000, outputMarker);
      if (tunnelMode) {
        await waitForCount(host, "tunnel ready for", 2, 20_000, "tunnel ready for");
        const expectedKeyMode = tunnelSecret ? "shared-secret" : "session-token";
        if (!new RegExp(`tunnel ready for .*keyMode=${expectedKeyMode}`).test(host.output)) {
          throw new Error(`tunnel did not negotiate keyMode=${expectedKeyMode}`);
        }
        pass(
          tunnelSecret
            ? "tunnel used shared-secret keyMode (relay cannot derive the keys)"
            : "tunnel used session-token keyMode (relay can derive; not relay-blind)",
        );
        if (tunnelFec === "xor") {
          if (!/tunnel ready for .*fec=xor/.test(host.output)) {
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
      await waitFor(host, "p2p input received over data channel", 20_000);
      await waitFor(attach2, "ECHO:p2p-live", 20_000);
      if (tunnelMode && /tunnel unavailable for/.test(host.output)) {
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
    } catch (error) {
      if (requireP2p || tunnelMode) throw error;
      console.log(`WARN ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Reconnect: kill attach1, start attach3, and require the snapshot to include
  // state produced before attach1 disconnected. attach3 joins at the same size
  // so the host does not need to resize/redraw the PTY for the snapshot.
  stop(attach1);
  await waitExit(attach1, 10_000);
  await new Promise((r) => setTimeout(r, 500));
  const attach3 = start("attach3", ["attach"], baseEnv(), 100, 30);
  await waitFor(attach3, "TOKIMEKI_E2E_READY");
  await waitFor(attach3, "LAST_INPUT=persist-e2e");
  attach3.child.write("reconnect-e2e\r");
  await waitFor(attach3, "ECHO:reconnect-e2e");
  await waitFor(attach2, "ECHO:reconnect-e2e");
  pass("reconnect snapshot restored earlier output and shared control still works");

  const combined = `${host.output}\n${attach2.output}\n${attach3.output}`;
  if (p2pMode === "off") {
    if (/p2p-(direct|turn)|p2p ready|p2p output started/.test(combined)) {
      throw new Error("P2P was disabled but P2P activity appeared in the logs");
    }
    pass("P2P disabled: relay-only data path verified");
  } else if (p2pDataPath) {
    pass("P2P transport established (p2p-direct or p2p-turn in logs)");
  } else if (requireP2p) {
    throw new Error("P2P was required but no p2p-direct/p2p-turn transport was exercised");
  } else {
    console.log("WARN P2P not observed; relay path still passed");
  }

  if (requireP2pFallback) {
    if (!/p2p unavailable for .*using relay/.test(host.output)) {
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
          writeFileSync(join(dumpDir, `${state.name}.log`), state.output);
        }
      } catch (dumpError) {
        console.error(`failed to dump process logs: ${String(dumpError)}`);
      }
    }
    for (const state of processes) {
      console.error(`--- ${state.name} tail ---\n${state.output.slice(-3000)}`);
    }
  })
  .finally(() => {
    for (const state of processes) stop(state);
    setTimeout(() => process.exit(failed ? 1 : 0), 300);
  });
