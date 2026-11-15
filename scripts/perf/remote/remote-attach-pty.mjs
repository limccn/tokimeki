#!/usr/bin/env node

/**
 * Run `tokimeki attach` under a PTY on the remote host.
 *
 * The cross-NAT perf harness reaches this process through `ssh` with a plain
 * pipe, which gives the CLI a 1x1 or absent terminal if attach is run directly.
 * Spawning it under a local PTY keeps the viewer's terminal semantics identical
 * to the proven e2e path (80x24-style viewport, normal SIGWINCH behavior).
 *
 * Wire format, deliberately minimal:
 *   - SSH stdin bytes are forwarded verbatim to the attach PTY.
 *   - Attach PTY output (TUI frames and logs) is forwarded to stdout.
 *   - Tokens stay in the environment; nothing here touches argv or disk.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pty from "@homebridge/node-pty-prebuilt-multiarch";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = join(root, "packages/cli/dist/index.js");

const child = pty.spawn(process.execPath, [cli, "attach"], {
  name: "tokimeki-remote-attach",
  cwd: root,
  cols: 90,
  rows: 28,
  env: {
    ...process.env,
    TOKIMEKI_TERM: "xterm-256color",
    TOKIMEKI_COLORTERM: "truecolor",
  },
  encoding: null,
});

const BEGIN = Buffer.from("PERF_DATA_BEGIN");
const END = Buffer.from("PERF_DATA_END");
let carry = Buffer.alloc(0);
let inBulk = false;

/** Length of the longest suffix of `data` that prefixes `marker`. */
function pendingPrefix(data, marker) {
  const max = Math.min(marker.length - 1, data.length);
  for (let size = max; size > 0; size -= 1) {
    if (data.subarray(data.length - size).equals(marker.subarray(0, size))) {
      return size;
    }
  }
  return 0;
}

/**
 * Forward control markers and logs, but drop the bulk TUI payload between
 * PERF_DATA_BEGIN and PERF_DATA_END. The bulk is still read from the PTY (so
 * the viewer's rendering path runs), but shipping it over the cross-border SSH
 * link would dominate the measurement and hide the P2P throughput.
 */
function forward(data) {
  let pending = carry.length === 0 ? data : Buffer.concat([carry, data]);
  carry = Buffer.alloc(0);
  for (;;) {
    if (!inBulk) {
      const index = pending.indexOf(BEGIN);
      if (index >= 0) {
        process.stdout.write(pending.subarray(0, index + BEGIN.length));
        pending = pending.subarray(index + BEGIN.length);
        inBulk = true;
        continue;
      }
      const keep = pendingPrefix(pending, BEGIN);
      process.stdout.write(pending.subarray(0, pending.length - keep));
      carry = pending.subarray(pending.length - keep);
      return;
    }
    const index = pending.indexOf(END);
    if (index >= 0) {
      process.stdout.write(END);
      pending = pending.subarray(index + END.length);
      inBulk = false;
      continue;
    }
    const keep = pendingPrefix(pending, END);
    carry = pending.subarray(pending.length - keep);
    return;
  }
}

child.onData((data) => {
  forward(Buffer.from(data));
});

child.onExit(({ exitCode }) => {
  process.stdout.write(`\nREMOTE_ATTACH_EXIT=${exitCode}\n`, () => {
    process.exit(exitCode === 0 ? 0 : 1);
  });
});

process.stdin.on("data", (data) => {
  child.write(data);
});

// When the harness closes the SSH channel, tear the remote PTY down so no
// orphan attach process keeps a session token alive on the VPS.
process.stdin.on("end", () => {
  try {
    child.kill();
  } catch {
    // best effort
  }
  process.exit(0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    try {
      child.kill();
    } catch {
      // best effort
    }
    process.exit(0);
  });
}
