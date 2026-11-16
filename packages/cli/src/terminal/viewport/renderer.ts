/**
 * Full-screen viewport renderer.
 *
 * Draws the fixed logical TUI grid into the local terminal, letterboxing when
 * the local area is larger and following the cursor when it is smaller. The
 * bottom row is always a reverse-video status bar; an optional log panel sits
 * above it in debug mode.
 */

import { writeSync } from "node:fs";

import type { IBuffer, IBufferCell } from "@xterm/headless";
import type { TerminalMirror } from "../mirror.js";
import { CLEAR_SCREEN, ENTER_ALTERNATE_SCREEN, terminalRestoreSequence } from "../restore.js";
import {
  computeCamera,
  computeViewportFrame,
  mapLogicalToLocal,
  type TerminalSize,
  type ViewportCamera,
  type ViewportFrame,
  visibleLogicalRect,
} from "./geometry.js";

const RENDER_INTERVAL_MS = 16;
const LOG_RING_LINES = 256;
const LOG_LINE_MAX_CHARS = 4096;

export type ViewportRole = "host" | "viewer" | "listener";
export type ViewportRelayState = "connecting" | "ready" | "reconnecting" | "failed" | "closed";
export type ViewportTransport = "relay" | "p2p-direct" | "p2p-turn" | "p2p";

export interface ViewportStatus {
  readonly role: ViewportRole;
  readonly session: string;
  readonly relayState: ViewportRelayState;
  readonly viewers: number;
  readonly transport: ViewportTransport;
  /** Short local hint such as `f12:invite`; omitted for viewers. */
  readonly inviteHint?: string;
}

export interface ViewportRendererOptions {
  readonly mirror: TerminalMirror;
  readonly stdout: NodeJS.WriteStream;
  readonly logical: TerminalSize;
  readonly logRows: number;
  readonly status: ViewportStatus;
  readonly isCursorVisible: () => boolean;
}

function writeStreamFd(stream: NodeJS.WriteStream): number | null {
  const fd = (stream as NodeJS.WriteStream & { fd?: number }).fd;
  return typeof fd === "number" ? fd : null;
}

function sanitizeLogLine(line: string): string {
  let result = "";
  for (const char of line) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      result += code === 0x09 ? " " : "";
    } else {
      result += char;
    }
    if (result.length >= LOG_LINE_MAX_CHARS) break;
  }
  return result;
}

function cellSgr(cell: IBufferCell): string {
  if (cell.isAttributeDefault()) return "0";
  const parts: string[] = [];
  if (cell.isBold()) parts.push("1");
  if (cell.isDim()) parts.push("2");
  if (cell.isItalic()) parts.push("3");
  if (cell.isUnderline()) parts.push("4");
  if (cell.isBlink()) parts.push("5");
  if (cell.isInverse()) parts.push("7");
  if (cell.isInvisible()) parts.push("8");
  if (cell.isStrikethrough()) parts.push("9");
  if (cell.isOverline()) parts.push("53");
  if (cell.isFgRGB()) {
    const value = cell.getFgColor();
    parts.push(`38;2;${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}`);
  } else if (cell.isFgPalette()) {
    const value = cell.getFgColor();
    if (value < 8) parts.push(`${30 + value}`);
    else if (value < 16) parts.push(`${90 + value - 8}`);
    else parts.push(`38;5;${value}`);
  }
  if (cell.isBgRGB()) {
    const value = cell.getBgColor();
    parts.push(`48;2;${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}`);
  } else if (cell.isBgPalette()) {
    const value = cell.getBgColor();
    if (value < 8) parts.push(`${40 + value}`);
    else if (value < 16) parts.push(`${100 + value - 8}`);
    else parts.push(`48;5;${value}`);
  }
  return parts.length === 0 ? "0" : parts.join(";");
}

export class ViewportRenderer {
  readonly #mirror: TerminalMirror;
  readonly #stdout: NodeJS.WriteStream;
  readonly #logical: TerminalSize;
  readonly #logRows: number;
  readonly #isCursorVisible: () => boolean;
  #status: ViewportStatus;

  #local: TerminalSize;
  #frame: ViewportFrame;
  #camera: ViewportCamera;
  #lastRows: string[] = [];
  #logs: string[] = [];
  #inviteLines: readonly string[] | null = null;
  #inviteCopyText = "";

  #dirtyViewport = true;
  #dirtyChrome = true;
  #forceFull = true;
  #timer: NodeJS.Timeout | null = null;
  #drainWaiting = false;
  #disposed = false;
  #started = false;

  constructor(options: ViewportRendererOptions) {
    this.#mirror = options.mirror;
    this.#stdout = options.stdout;
    this.#logical = options.logical;
    this.#logRows = Math.max(0, Math.floor(options.logRows));
    this.#status = options.status;
    this.#isCursorVisible = options.isCursorVisible;
    this.#local = {
      cols: Math.max(1, options.stdout.columns ?? 80),
      rows: Math.max(1, options.stdout.rows ?? 24),
    };
    this.#frame = computeViewportFrame(this.#local, this.#logical, this.#logRows);
    this.#camera = computeCamera(this.#logical, this.#frame.viewport, { x: 0, y: 0 });
  }

  get layout(): { readonly frame: ViewportFrame; readonly camera: ViewportCamera } {
    return { frame: this.#frame, camera: this.#camera };
  }

  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    // The terminal may have been resized between construction (PTY startup)
    // and entering the alternate screen.
    this.#local = {
      cols: Math.max(1, this.#stdout.columns ?? this.#local.cols),
      rows: Math.max(1, this.#stdout.rows ?? this.#local.rows),
    };
    this.#frame = computeViewportFrame(this.#local, this.#logical, this.#logRows);
    this.#write(ENTER_ALTERNATE_SCREEN + CLEAR_SCREEN);
    this.#forceFull = true;
    this.renderNow();
  }

  resize(local: TerminalSize): void {
    const cols = Math.max(1, Math.floor(local.cols));
    const rows = Math.max(1, Math.floor(local.rows));
    if (cols === this.#local.cols && rows === this.#local.rows) return;
    this.#local = { cols, rows };
    this.#frame = computeViewportFrame(this.#local, this.#logical, this.#logRows);
    this.#forceFull = true;
    this.#dirtyViewport = true;
    this.#dirtyChrome = true;
    if (this.#inviteLines !== null) {
      this.renderNow();
    } else {
      this.requestRender();
    }
  }

  setStatus(status: ViewportStatus): void {
    this.#status = status;
    this.#dirtyChrome = true;
    this.requestRender();
  }

  appendLog(line: string): void {
    for (const part of sanitizeLogLine(line).split(/\r?\n/)) {
      this.#logs.push(part);
    }
    if (this.#logs.length > LOG_RING_LINES) {
      this.#logs.splice(0, this.#logs.length - LOG_RING_LINES);
    }
    this.#dirtyChrome = true;
    this.requestRender();
  }

  /** Force a full repaint (snapshot boundary or geometry change). */
  invalidate(): void {
    this.#forceFull = true;
    this.#dirtyViewport = true;
    this.#dirtyChrome = true;
    this.requestRender();
  }

  /** Show or hide the local viewer-config overlay. */
  setInviteOverlay(lines: readonly string[] | null, copyText = ""): void {
    this.#inviteCopyText = copyText;
    this.#inviteLines = lines;
    this.#forceFull = true;
    this.#dirtyViewport = true;
    this.#dirtyChrome = true;
    if (lines !== null) {
      this.renderNow();
    } else {
      this.requestRender();
    }
  }

  /** Copy the exact viewer config through OSC 52 (terminal-native clipboard). */
  copyInvite(): void {
    if (this.#inviteCopyText.length === 0) return;
    const encoded = Buffer.from(this.#inviteCopyText, "utf8").toString("base64");
    this.#write(`\x1b]52;c;${encoded}\x07`);
  }

  /** Called by the mirror after parsing a chunk. */
  markViewportDirty(): void {
    this.#dirtyViewport = true;
    this.requestRender();
  }

  requestRender(): void {
    if (this.#disposed || this.#inviteLines !== null) return;
    if (this.#timer !== null || this.#drainWaiting) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.renderNow();
    }, RENDER_INTERVAL_MS);
    this.#timer.unref?.();
  }

  renderNow(): void {
    if (this.#disposed || !this.#started) return;
    if (!this.#dirtyViewport && !this.#dirtyChrome && !this.#forceFull) return;
    if (this.#inviteLines !== null) {
      this.#renderInviteOverlay();
      return;
    }

    const buffer = this.#mirror.term.buffer.active;
    const cursor = { x: buffer.cursorX, y: buffer.cursorY };
    const previousCamera = this.#camera;
    this.#camera = computeCamera(this.#logical, this.#frame.viewport, cursor, previousCamera);

    if (this.#forceFull) {
      this.#write(CLEAR_SCREEN);
      this.#lastRows = [];
    }
    if (this.#dirtyViewport || this.#forceFull) {
      this.#renderViewport(buffer);
    }
    if (this.#dirtyChrome || this.#forceFull) {
      this.#renderLogPanel();
      this.#renderStatusBar();
    }
    this.#renderCursor(cursor);

    this.#dirtyViewport = false;
    this.#dirtyChrome = false;
    this.#forceFull = false;
  }

  #renderViewport(buffer: IBuffer): void {
    const frame = this.#frame;
    const camera = this.#camera;
    const logical = this.#logical;
    const cell = buffer.getNullCell();
    for (let screenRow = 0; screenRow < frame.viewport.rows; screenRow += 1) {
      const logicalY = screenRow - camera.offsetY + camera.y;
      let content = "";
      let style = "\u0000";
      let lastWidth = 1;
      if (logicalY >= 0 && logicalY < logical.rows) {
        const line = buffer.getLine(buffer.baseY + logicalY);
        for (let screenCol = 0; screenCol < frame.viewport.cols; screenCol += 1) {
          const logicalX = screenCol - camera.offsetX + camera.x;
          if (logicalX < 0 || logicalX >= logical.cols || line === undefined) {
            if (style !== "0") {
              content += "\x1b[0m";
              style = "0";
            }
            content += " ";
            lastWidth = 1;
            continue;
          }
          const current = line.getCell(logicalX, cell);
          const width = current?.getWidth() ?? 1;
          if (width === 0) {
            if (lastWidth !== 2) content += " ";
            continue;
          }
          const chars = current?.getChars() || " ";
          if (width === 2 && screenCol + 1 >= frame.viewport.cols) {
            content += " ";
            lastWidth = 1;
            continue;
          }
          const nextStyle = current === undefined ? "0" : cellSgr(current);
          if (nextStyle !== style) {
            // Reset first so default/bold-only cells do not inherit a color
            // from the previous cell.
            content += `\x1b[0m\x1b[${nextStyle}m`;
            style = nextStyle;
          }
          content += chars;
          lastWidth = width;
        }
      }
      if (content.length === 0) {
        content = " ".repeat(frame.viewport.cols);
      }
      if (style !== "0") content += "\x1b[0m";
      if (this.#lastRows[screenRow] === content) continue;
      this.#lastRows[screenRow] = content;
      this.#write(`\x1b[${screenRow + 1};1H${content}`);
    }
  }

  #renderLogPanel(): void {
    const panel = this.#frame.logPanel;
    if (panel === null || panel.rows <= 0) return;
    const first = Math.max(0, this.#logs.length - panel.rows);
    for (let row = 0; row < panel.rows; row += 1) {
      const line = this.#logs[first + row] ?? "";
      const text =
        line.length > panel.cols ? line.slice(0, panel.cols) : line.padEnd(panel.cols, " ");
      this.#write(`\x1b[${panel.y + row + 1};1H\x1b[2m${text}\x1b[0m`);
    }
  }

  #renderStatusBar(): void {
    const bar = this.#frame.statusBar;
    if (bar.rows <= 0 || bar.cols <= 0) return;
    const line = this.#statusLine(bar.cols);
    this.#write(`\x1b[${bar.y + 1};1H\x1b[7m${line}\x1b[0m`);
  }

  #statusLine(width: number): string {
    const visible = visibleLogicalRect(this.#logical, this.#frame.viewport, this.#camera);
    const view =
      this.#camera.fitsX && this.#camera.fitsY
        ? "view:fit"
        : `view:${visible.cols}x${visible.rows}@${this.#camera.x},${this.#camera.y}`;
    const session =
      this.#status.session.length > 16
        ? `${this.#status.session.slice(0, 15)}~`
        : this.#status.session;
    interface Field {
      readonly text: string;
      readonly drop: number;
    }
    const fields: Field[] = [
      { text: "tokimeki", drop: 99 },
      { text: this.#status.role, drop: 99 },
      { text: `session=${session}`, drop: 1 },
      { text: `relay=${this.#status.relayState}`, drop: 99 },
      ...(this.#status.role === "host" && this.#status.viewers > 0
        ? [{ text: `viewers=${this.#status.viewers}`, drop: 2 }]
        : []),
      { text: this.#status.transport, drop: 3 },
      { text: `${this.#logical.cols}x${this.#logical.rows}`, drop: 4 },
      ...(this.#status.inviteHint === undefined
        ? []
        : [{ text: this.#status.inviteHint, drop: 5 }]),
      { text: view, drop: 99 },
    ];
    let selected = fields;
    let text = selected.map((field) => field.text).join("  ");
    for (let drop = 1; drop <= 5 && text.length > width; drop += 1) {
      selected = selected.filter((field) => field.drop !== drop);
      text = selected.map((field) => field.text).join("  ");
    }
    return text.length > width ? text.slice(0, width) : text.padEnd(width, " ");
  }

  #renderInviteOverlay(): void {
    const local = this.#local;
    if (local.cols <= 0 || local.rows <= 0) return;
    const boxWidth = Math.max(20, Math.min(local.cols, 120));
    const inner = Math.max(1, boxWidth - 4);
    const content: string[] = [];
    for (const line of this.#inviteLines ?? []) {
      if (line.length <= inner) {
        content.push(line);
        continue;
      }
      for (let offset = 0; offset < line.length; offset += inner) {
        content.push(line.slice(offset, offset + inner));
      }
    }
    const maxContentRows = Math.max(0, local.rows - 3);
    const visible = content.slice(0, maxContentRows);
    const lines = [
      `+${"-".repeat(boxWidth - 2)}+`,
      `| ${"TOKIMEKI VIEWER CONFIG (SECRET)".slice(0, inner).padEnd(inner, " ")} |`,
      ...visible.map((line) => `| ${line.padEnd(inner, " ")} |`),
      `+${"-".repeat(boxWidth - 2)}+`,
    ].slice(0, local.rows);
    const startRow = Math.max(0, Math.floor((local.rows - lines.length) / 2));
    const startCol = Math.max(0, Math.floor((local.cols - boxWidth) / 2));
    this.#write(CLEAR_SCREEN);
    for (let row = 0; row < lines.length; row += 1) {
      this.#write(`\x1b[${startRow + row + 1};${startCol + 1}H${lines[row] ?? ""}`);
    }
    this.#write("\x1b[?25l");
  }

  #renderCursor(cursor: { x: number; y: number }): void {
    if (!this.#isCursorVisible()) {
      this.#write("\x1b[?25l");
      return;
    }
    const position = mapLogicalToLocal(this.#frame, this.#camera, cursor.x, cursor.y);
    if (position === null) {
      this.#write("\x1b[?25l");
      return;
    }
    this.#write(`\x1b[${position.y + 1};${position.x + 1}H\x1b[?25h`);
  }

  #write(data: string): void {
    try {
      const flushed = this.#stdout.write(data);
      if (!flushed && !this.#drainWaiting) {
        this.#drainWaiting = true;
        this.#stdout.once("drain", () => {
          this.#drainWaiting = false;
          this.requestRender();
        });
      }
    } catch {
      // stdout is gone; the session will finish shortly.
    }
  }

  /** Write a local terminal control sequence (mode sync) without a repaint. */
  writeControl(sequence: string): void {
    if (sequence.length === 0 || this.#disposed) return;
    this.#write(sequence);
  }

  /** Restore the local terminal synchronously (signal/exit paths). */
  restoreSync(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const sequence = terminalRestoreSequence();
    const fd = writeStreamFd(this.#stdout);
    if (fd !== null) {
      try {
        writeSync(fd, sequence);
        return;
      } catch {
        // fall through to the stream write
      }
    }
    try {
      this.#stdout.write(sequence);
    } catch {
      // best effort
    }
  }

  dispose(): void {
    this.restoreSync();
    this.#logs = [];
    this.#lastRows = [];
  }
}
