/**
 * Thin wrapper over node-pty for the host process.
 *
 * Raw bytes only (`encoding: null`); local flow control is expressed as named
 * pause reasons so relay backpressure and slow local stdout can coexist.
 */

import { spawn as spawnProcess } from "node:child_process";

import pty from "@homebridge/node-pty-prebuilt-multiarch";

export interface PtyExitInfo {
  readonly exitCode: number;
  readonly signal?: number;
}

export interface HostPtyOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly name: string;
  readonly env: NodeJS.ProcessEnv;
  readonly onData: (chunk: Buffer) => void;
  readonly onExit: (info: PtyExitInfo) => void;
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  return Buffer.from(String(data), "utf8");
}

export class HostPty {
  readonly #pty: pty.IPty;
  readonly #platform: NodeJS.Platform;
  readonly #pauseReasons = new Set<string>();
  #exited = false;

  constructor(options: HostPtyOptions, platform: NodeJS.Platform = process.platform) {
    this.#platform = platform;
    this.#pty = pty.spawn(options.command, [...options.args], {
      name: options.name,
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: options.env,
      encoding: null,
    });
    this.#pty.onData((data: unknown) => {
      options.onData(toBuffer(data));
    });
    this.#pty.onExit((event) => {
      this.#exited = true;
      options.onExit({ exitCode: event.exitCode, signal: event.signal });
    });
  }

  get pid(): number {
    return this.#pty.pid;
  }

  get cols(): number {
    return this.#pty.cols;
  }

  get rows(): number {
    return this.#pty.rows;
  }

  get exited(): boolean {
    return this.#exited;
  }

  write(data: Uint8Array | string): void {
    if (this.#exited) return;
    try {
      this.#pty.write(typeof data === "string" ? data : Buffer.from(data));
    } catch {
      // Writes after PTY exit are expected during shutdown.
    }
  }

  /** Caller is responsible for the no-op skip (`shouldApplyResize`). */
  resize(cols: number, rows: number): void {
    if (this.#exited) return;
    try {
      this.#pty.resize(cols, rows);
    } catch {
      // ConPTY can throw while the child is exiting.
    }
  }

  pause(reason: string): void {
    if (this.#pauseReasons.has(reason)) return;
    this.#pauseReasons.add(reason);
    if (this.#pauseReasons.size === 1) {
      try {
        this.#pty.pause();
      } catch {
        // best effort
      }
    }
  }

  resume(reason: string): void {
    if (!this.#pauseReasons.delete(reason)) return;
    if (this.#pauseReasons.size === 0) {
      try {
        this.#pty.resume();
      } catch {
        // best effort
      }
    }
  }

  /** Best-effort termination, including the Windows process tree. */
  kill(): void {
    if (this.#exited) return;
    const pid = this.#pty.pid;
    try {
      this.#pty.kill();
    } catch {
      // best effort
    }
    if (this.#platform === "win32" && typeof pid === "number" && pid > 0) {
      try {
        const killer = spawnProcess("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.on("error", () => undefined);
        killer.unref();
      } catch {
        // best effort
      }
    }
  }
}
