#!/usr/bin/env node
/**
 * Deterministic TUI for the real-CLI P2P perf scenario.
 *
 * Prints PERF_TUI_READY, then reads line commands from stdin:
 *   start <bytes>   emit exactly <bytes> bytes of PERF_DATA lines, then
 *                   PERF_DATA_END <sent>
 *   rtt <nonce>     print PERF_RTT:<nonce>
 *   quit            exit
 */

import readline from "node:readline";

const LINE = "PERF_DATA:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n";
const LINE_BYTES = Buffer.byteLength(LINE);

process.stdout.write("PERF_TUI_READY\n");

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (raw) => {
  const line = raw.trim();
  if (line === "quit") {
    process.exit(0);
  }
  if (line.startsWith("rtt ")) {
    process.stdout.write(`PERF_RTT:${line.slice(4)}\n`);
    return;
  }
  if (line.startsWith("start ")) {
    const total = Number(line.slice(6));
    if (Number.isFinite(total) && total > 0) {
      emit(total);
    }
  }
});

function emit(total) {
  process.stdout.write(`PERF_DATA_BEGIN ${total}\n`);
  let sent = 0;
  const write = () => {
    while (sent < total) {
      const remaining = total - sent;
      const lineCount = Math.max(1, Math.ceil(remaining / LINE_BYTES));
      const chunk = LINE.repeat(Math.min(64, lineCount));
      const data = chunk.slice(0, Math.min(chunk.length, remaining));
      if (!process.stdout.write(data)) {
        process.stdout.once("drain", write);
        return;
      }
      sent += Buffer.byteLength(data);
    }
    process.stdout.write(`PERF_DATA_END ${sent}\n`);
  };
  write();
}
