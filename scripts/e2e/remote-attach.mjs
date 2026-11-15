#!/usr/bin/env node

/**
 * Cross-machine test helper: attach from a remote host and drive the fake TUI.
 *
 * Required environment:
 *   TOKIMEKI_RELAY_URL, TOKIMEKI_SESSION, TOKIMEKI_SESSION_TOKEN
 *
 * Optional: TOKIMEKI_P2P (auto|off), TOKIMEKI_ICE_TRANSPORT_POLICY (all|relay),
 *           TOKIMEKI_LOG_LEVEL, REMOTE_ATTACH_TIMEOUT_MS (default 120000),
 *           REMOTE_ATTACH_HOLD_MS (wait before Ctrl-C),
 *           REMOTE_ATTACH_DETACH_MS (close the viewer without Ctrl-C).
 *
 * Asserts initial snapshot, input echo, resize, live output, and Ctrl-C
 * propagation. Prints REMOTE_PASS or REMOTE_FAIL. Never prints credentials.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pty from "@homebridge/node-pty-prebuilt-multiarch";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(root, "packages/cli/dist/index.js");
const timeoutMs = Number(process.env.REMOTE_ATTACH_TIMEOUT_MS ?? 120_000);
// Keep the session alive after the functional checks so a slow TURN/ICE
// negotiation has time to complete and show up in the host's debug log.
const holdMs = Number(process.env.REMOTE_ATTACH_HOLD_MS ?? 0);
// Test-only: close the viewer without sending Ctrl-C so the host survives and
// a second attach can verify viewer reconnect.
const detachMs = Number(process.env.REMOTE_ATTACH_DETACH_MS ?? 0);

for (const name of ["TOKIMEKI_RELAY_URL", "TOKIMEKI_SESSION", "TOKIMEKI_SESSION_TOKEN"]) {
  if (!process.env[name]) {
    console.error(`REMOTE_FAIL: ${name} is required`);
    process.exit(2);
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: match ANSI escape sequences from the PTY
const ansi = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function main() {
  const child = pty.spawn(process.execPath, [cli, "attach"], {
    name: "tokimeki-remote-attach",
    cwd: root,
    cols: 80,
    rows: 24,
    env: {
      ...process.env,
      TOKIMEKI_TERM: "xterm-256color",
      TOKIMEKI_COLORTERM: "truecolor",
      TOKIMEKI_HEARTBEAT_SECONDS: "10",
      TOKIMEKI_SCROLLBACK_LINES: "1000",
      TOKIMEKI_SNAPSHOT_MAX_BYTES: "262144",
      TOKIMEKI_LOG_LEVEL: process.env.TOKIMEKI_LOG_LEVEL ?? "debug",
    },
    encoding: null,
  });

  let output = "";
  let exited = false;
  let exitCode = null;
  child.onData((data) => {
    output += Buffer.from(data).toString("utf8");
  });
  child.onExit(({ exitCode: code }) => {
    exited = true;
    exitCode = code;
  });

  async function waitFor(needle, ms, label = needle) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (output.replace(ansi, "").includes(needle)) return;
      await sleep(25);
    }
    throw new Error(`timed out waiting for ${JSON.stringify(label)}`);
  }

  try {
    await waitFor("TOKIMEKI_E2E_READY", timeoutMs, "initial snapshot");
    child.write("remote-e2e\r");
    await waitFor("ECHO:remote-e2e", timeoutMs, "input echo");

    child.resize(120, 40);
    await waitFor("SIZE=120x40", timeoutMs, "resize propagation");
    await waitFor("TICK=", timeoutMs, "live output");
    if (holdMs > 0) await sleep(holdMs);

    if (detachMs > 0) {
      await sleep(detachMs);
      child.kill();
      console.log("REMOTE_DETACH");
      return 0;
    }

    child.write("\u0003");
    await waitFor("host exited (code=0)", Math.min(timeoutMs, 60_000), "host exited");

    const deadline = Date.now() + 10_000;
    while (!exited && Date.now() < deadline) await sleep(25);
    if (!exited) throw new Error("attach process did not exit after host-exited");

    const clean = output.replace(ansi, "");
    const transport = clean
      .split(/\r?\n/)
      .filter((line) => /p2p|transport|relay ready|iceProvider/i.test(line))
      .slice(-8);
    console.log("REMOTE_TRANSPORT:");
    for (const line of transport) console.log(`  ${line.trim()}`);
    console.log("REMOTE_PASS");
    return exitCode === 0 ? 0 : 1;
  } catch (error) {
    const clean = output.replace(ansi, "");
    console.error(`REMOTE_FAIL: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`REMOTE_TAIL:\n${clean.slice(-4000)}`);
    try {
      child.kill();
    } catch {
      // best effort
    }
    return 1;
  }
}

process.exitCode = await main();
