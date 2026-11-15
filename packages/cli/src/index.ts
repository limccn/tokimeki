#!/usr/bin/env node
import { main } from "./cli.js";

/**
 * tokimeki CLI entrypoint.
 *
 * All runtime configuration comes from the environment; the CLI itself only
 * exposes stateless flags (`--help`, `--version`).
 */

/**
 * Exit once buffered stdout/stderr writes have drained.
 *
 * node-pty keeps a ConPTY worker thread alive after a PTY exits (and the kill
 * path can be deferred forever when the child never produced output), so a
 * natural event-loop drain is not guaranteed. Waiting for a zero-length write
 * callback first keeps normal output, then exits deterministically.
 */
function flushAndExit(code: number): void {
  let remaining = 2;
  const done = (): void => {
    remaining -= 1;
    if (remaining <= 0) process.exit(code);
  };
  try {
    process.stdout.write("", done);
  } catch {
    done();
  }
  try {
    process.stderr.write("", done);
  } catch {
    done();
  }
}

const exitCode = await main(process.argv);
process.exitCode = exitCode;
flushAndExit(exitCode);
