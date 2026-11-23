/**
 * Full-screen viewport renderer.
 *
 * Draws the fixed logical TUI grid into the local terminal, letterboxing when
 * the local area is larger and following the cursor when it is smaller. The
 * bottom row is always a reverse-video status bar. In debug mode on a wide
 * terminal a 40x8 log area occupies the bottom-right corner; the TUI viewport
 * is then rendered as an L-shaped pair of slices over a merged camera.
 */

import { writeSync } from "node:fs";

import type { IBuffer, IBufferCell } from "@xterm/headless";
import type { TerminalMirror } from "../mirror.js";
import { CLEAR_SCREEN, ENTER_ALTERNATE_SCREEN, terminalRestoreSequence } from "../restore.js";
import {
  CORNER_EXIT_COLS,
  CORNER_MIN_COLS,
  computeCamera,
  computeViewportFrame,
  mapLogicalToLocal,
  type TerminalSize,
  type ViewportCamera,
  type ViewportFrame,
  visibleLogicalRect,
} from "./geometry.js";
import { LogRing } from "./log-ring.js";

const RENDER_INTERVAL_MS = 16;

export type ViewportRole = "host" | "viewer" | "listener";
export type ViewportRelayState = "connecting" | "ready" | "reconnecting" | "failed" | "closed";
export type ViewportTransport = "relay" | "p2p-direct" | "p2p-turn" | "p2p";

export interface ViewportStatus {
  readonly role: ViewportRole;
  readonly session: string;
  readonly relayState: ViewportRelayState;
  readonly viewers: number;
  readonly transport: ViewportTransport;
  /** Short local hint such as `f12:menu`; omitted for viewers. */
  readonly inviteHint?: string;
}

export interface ViewportRendererOptions {
  readonly mirror: TerminalMirror;
  readonly stdout: NodeJS.WriteStream;
  readonly logical: TerminalSize;
  /** Log-ring capacity; 0 disables the corner log area and the log view. */
  readonly logViewRows: number;
  readonly status: ViewportStatus;
  readonly isCursorVisible: () => boolean;
}

function writeStreamFd(stream: NodeJS.WriteStream): number | null {
  const fd = (stream as NodeJS.WriteStream & { fd?: number }).fd;
  return typeof fd === "number" ? fd : null;
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
  readonly #isCursorVisible: () => boolean;
  readonly #ring: LogRing;
  #logical: TerminalSize;
  #status: ViewportStatus;

  #local: TerminalSize;
  #frame: ViewportFrame;
  #camera: ViewportCamera;
  #cornerEnabled: boolean;
  #lastRows: string[] = [];
  #menuLines: readonly string[] | null = null;
  #logViewOpen = false;
  #logScroll = 0;

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
    this.#ring = new LogRing(options.logViewRows);
    this.#status = options.status;
    this.#isCursorVisible = options.isCursorVisible;
    this.#local = {
      cols: Math.max(1, options.stdout.columns ?? 80),
      rows: Math.max(1, options.stdout.rows ?? 24),
    };
    this.#cornerEnabled = this.#local.cols >= CORNER_MIN_COLS;
    this.#frame = this.#computeFrame();
    this.#camera = computeCamera(this.#logical, this.#frame.mergedViewport, { x: 0, y: 0 });
  }

  get layout(): { readonly frame: ViewportFrame; readonly camera: ViewportCamera } {
    return { frame: this.#frame, camera: this.#camera };
  }

  get logViewOpen(): boolean {
    return this.#logViewOpen;
  }

  get logCapacity(): number {
    return this.#ring.capacity;
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
    this.#cornerEnabled = this.#local.cols >= CORNER_MIN_COLS;
    this.#frame = this.#computeFrame();
    this.#write(ENTER_ALTERNATE_SCREEN + CLEAR_SCREEN);
    this.#forceFull = true;
    this.renderNow();
  }

  /** Change the logical grid size (host-side window resize). */
  setLogical(logical: TerminalSize): void {
    const cols = Math.max(1, Math.floor(logical.cols));
    const rows = Math.max(1, Math.floor(logical.rows));
    if (cols === this.#logical.cols && rows === this.#logical.rows) return;
    this.#logical = { cols, rows };
    this.#frame = this.#computeFrame();
    this.#forceFull = true;
    this.#dirtyViewport = true;
    this.#dirtyChrome = true;
    this.requestRender();
  }

  resize(local: TerminalSize): void {
    const cols = Math.max(1, Math.floor(local.cols));
    const rows = Math.max(1, Math.floor(local.rows));
    if (cols === this.#local.cols && rows === this.#local.rows) return;
    this.#local = { cols, rows };
    // Hysteresis prevents a 119/120-column flapping terminal from switching
    // layouts on every resize event.
    if (!this.#cornerEnabled && cols >= CORNER_MIN_COLS) this.#cornerEnabled = true;
    else if (this.#cornerEnabled && cols < CORNER_EXIT_COLS) this.#cornerEnabled = false;
    this.#frame = this.#computeFrame();
    this.#forceFull = true;
    this.#dirtyViewport = true;
    this.#dirtyChrome = true;
    if (this.#menuLines !== null || this.#logViewOpen) {
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
    if (!this.#ring.enabled) return;
    this.#ring.push(line);
    if (this.#logViewOpen) {
      this.#forceFull = true;
      this.renderNow();
      return;
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

  /** Show or hide the local connection-menu overlay. */
  setMenuOverlay(lines: readonly string[] | null): void {
    this.#menuLines = lines;
    this.#forceFull = true;
    this.#dirtyViewport = true;
    this.#dirtyChrome = true;
    if (lines !== null) {
      this.renderNow();
    } else {
      this.requestRender();
    }
  }

  /** Enter or leave the full-screen (tmux-style) log view. */
  setLogView(open: boolean): void {
    if (this.#logViewOpen === open) return;
    this.#logViewOpen = open;
    this.#logScroll = 0;
    this.#forceFull = true;
    this.#dirtyViewport = true;
    this.#dirtyChrome = true;
    this.renderNow();
  }

  scrollLogBy(delta: number): void {
    if (!this.#logViewOpen) return;
    const contentRows = Math.max(0, this.#local.rows - 1);
    const maxScroll = Math.max(0, this.#ring.length - contentRows);
    const next = Math.min(maxScroll, Math.max(0, this.#logScroll + delta));
    if (next === this.#logScroll) return;
    this.#logScroll = next;
    this.renderNow();
  }

  /** Copy text through OSC 52 (terminal-native clipboard). */
  copyText(text: string): void {
    if (text.length === 0) return;
    const encoded = Buffer.from(text, "utf8").toString("base64");
    this.#write(`\x1b]52;c;${encoded}\x07`);
  }

  /** Backwards-compatible alias used by the viewer-config copy action. */
  copyInvite(): void {
    this.copyText(this.#lastCopyText);
  }

  #lastCopyText = "";
  setCopyText(text: string): void {
    this.#lastCopyText = text;
  }

  /** Called by the mirror after parsing a chunk. */
  markViewportDirty(): void {
    this.#dirtyViewport = true;
    this.requestRender();
  }

  requestRender(): void {
    if (this.#disposed || this.#menuLines !== null || this.#logViewOpen) return;
    if (this.#timer !== null || this.#drainWaiting) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.renderNow();
    }, RENDER_INTERVAL_MS);
    this.#timer.unref?.();
  }

  renderNow(): void {
    if (this.#disposed || !this.#started) return;
    if (this.#logViewOpen) {
      this.#renderLogView();
      return;
    }
    if (this.#menuLines !== null) {
      this.#renderOverlay(this.#menuLines);
      return;
    }
    if (!this.#dirtyViewport && !this.#dirtyChrome && !this.#forceFull) return;

    const buffer = this.#mirror.term.buffer.active;
    const cursor = { x: buffer.cursorX, y: buffer.cursorY };
    const previousCamera = this.#camera;
    this.#camera = computeCamera(this.#logical, this.#frame.mergedViewport, cursor, previousCamera);

    if (this.#forceFull) {
      this.#write(CLEAR_SCREEN);
      this.#lastRows = [];
    }
    if (this.#dirtyViewport || this.#forceFull) {
      this.#renderViewport(buffer);
    }
    if (this.#dirtyChrome || this.#forceFull) {
      this.#renderCornerLog();
      this.#renderStatusBar();
    }
    this.#renderCursor(cursor);

    this.#dirtyViewport = false;
    this.#dirtyChrome = false;
    this.#forceFull = false;
  }

  #computeFrame(): ViewportFrame {
    return computeViewportFrame(this.#local, this.#logical, {
      corner: this.#cornerEnabled && this.#ring.enabled,
    });
  }

  #renderViewport(buffer: IBuffer): void {
    this.#renderSlice(buffer, this.#frame.viewport);
    if (this.#frame.cornerViewport !== null) {
      this.#renderSlice(buffer, this.#frame.cornerViewport);
    }
  }

  #renderSlice(
    buffer: IBuffer,
    rect: { readonly x: number; readonly y: number; readonly cols: number; readonly rows: number },
  ): void {
    const camera = this.#camera;
    const logical = this.#logical;
    const merged = this.#frame.mergedViewport;
    const cell = buffer.getNullCell();
    for (let screenRow = 0; screenRow < rect.rows; screenRow += 1) {
      const localY = rect.y + screenRow;
      const logicalY = localY - merged.y - camera.offsetY + camera.y;
      let content = "";
      let style = "\u0000";
      let lastWidth = 1;
      if (logicalY >= 0 && logicalY < logical.rows) {
        const line = buffer.getLine(buffer.baseY + logicalY);
        for (let screenCol = 0; screenCol < rect.cols; screenCol += 1) {
          const localX = rect.x + screenCol;
          const logicalX = localX - merged.x - camera.offsetX + camera.x;
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
          if (width === 2 && screenCol + 1 >= rect.cols) {
            content += " ";
            lastWidth = 1;
            continue;
          }
          const nextStyle = current === undefined ? "0" : cellSgr(current);
          if (nextStyle !== style) {
            content += `\x1b[0m\x1b[${nextStyle}m`;
            style = nextStyle;
          }
          content += chars;
          lastWidth = width;
        }
      }
      if (content.length === 0) {
        content = " ".repeat(rect.cols);
      }
      if (style !== "0") content += "\x1b[0m";
      if (this.#lastRows[localY] === content) continue;
      this.#lastRows[localY] = content;
      this.#write(`\x1b[${localY + 1};${rect.x + 1}H${content}`);
    }
  }

  #renderCornerLog(): void {
    const panel = this.#frame.logPanel;
    if (panel === null || panel.rows <= 0) return;
    const lines = this.#ring.tail(panel.rows);
    const first = Math.max(0, panel.rows - lines.length);
    for (let row = 0; row < panel.rows; row += 1) {
      const line = lines[row - first] ?? "";
      const text =
        line.length > panel.cols ? line.slice(0, panel.cols) : line.padEnd(panel.cols, " ");
      this.#write(`\x1b[${panel.y + row + 1};${panel.x + 1}H\x1b[2m${text}\x1b[0m`);
    }
  }

  #renderStatusBar(): void {
    const bar = this.#frame.statusBar;
    if (bar.rows <= 0 || bar.cols <= 0) return;
    const line = this.#statusLine(bar.cols);
    this.#write(`\x1b[${bar.y + 1};1H\x1b[7m${line}\x1b[0m`);
  }

  #statusLine(width: number): string {
    const visible = visibleLogicalRect(this.#logical, this.#frame.mergedViewport, this.#camera);
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

  #renderLogView(): void {
    const local = this.#local;
    if (local.cols <= 0 || local.rows <= 0) return;
    const contentRows = Math.max(0, local.rows - 1);
    const total = this.#ring.length;
    const maxScroll = Math.max(0, total - contentRows);
    this.#logScroll = Math.min(this.#logScroll, maxScroll);
    const lines = this.#ring.tail(contentRows, this.#logScroll);
    this.#write(CLEAR_SCREEN);
    for (let row = 0; row < contentRows; row += 1) {
      const line = lines[row] ?? "";
      const text =
        line.length > local.cols ? line.slice(0, local.cols) : line.padEnd(local.cols, " ");
      this.#write(`\x1b[${row + 1};1H\x1b[2m${text}\x1b[0m`);
    }
    if (local.rows > 0) {
      const footer = `LOGS ${total}  scroll ${this.#logScroll}/${maxScroll}  up/down scroll  F11/Esc close`;
      const text =
        footer.length > local.cols ? footer.slice(0, local.cols) : footer.padEnd(local.cols, " ");
      this.#write(`\x1b[${local.rows};1H\x1b[7m${text}\x1b[0m`);
    }
    this.#write("\x1b[?25l");
    this.#forceFull = false;
  }

  #renderOverlay(lines: readonly string[]): void {
    const local = this.#local;
    if (local.cols <= 0 || local.rows <= 0) return;
    const boxWidth = Math.max(20, Math.min(local.cols, 110));
    const inner = Math.max(1, boxWidth - 4);
    const content: string[] = [];
    for (const line of lines) {
      if (line.length <= inner) {
        content.push(line);
        continue;
      }
      for (let offset = 0; offset < line.length; offset += inner) {
        content.push(line.slice(offset, offset + inner));
      }
    }
    const maxContentRows = Math.max(0, local.rows - 2);
    const visible = content.slice(0, maxContentRows);
    const framed = [
      `+${"-".repeat(boxWidth - 2)}+`,
      ...visible.map((line) => `| ${line.padEnd(inner, " ")} |`),
      `+${"-".repeat(boxWidth - 2)}+`,
    ].slice(0, local.rows);
    const startRow = Math.max(0, Math.floor((local.rows - framed.length) / 2));
    const startCol = Math.max(0, Math.floor((local.cols - boxWidth) / 2));
    this.#write(CLEAR_SCREEN);
    for (let row = 0; row < framed.length; row += 1) {
      this.#write(`\x1b[${startRow + row + 1};${startCol + 1}H${framed[row] ?? ""}`);
    }
    this.#write("\x1b[?25l");
    this.#forceFull = false;
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
    this.#ring.clear();
    this.#lastRows = [];
  }
}
