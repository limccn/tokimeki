/**
 * Local F12 connection-menu controller (v1.4-D, with the G resize/log items).
 *
 * Keys are consumed locally while the menu (or its resize editor) is open and
 * never reach the hosted PTY; bytes typed before the opening trigger in the
 * same chunk are forwarded. F11 toggles the full-screen log view even when the
 * menu is disabled (e.g. `TOKIMEKI_INVITE_KEY=off`).
 */

import type { ActiveInviteKey } from "../../invite.js";

export const F11_SEQUENCE = "\x1b[23~";
export const F12_SEQUENCE = "\x1b[24~";

export interface MenuItem {
  readonly id: string;
  readonly label: string;
}

export interface MenuModel {
  readonly title: string;
  readonly lines: readonly string[];
  readonly items: readonly MenuItem[];
}

export type MenuAction =
  | { readonly type: "copy-config" }
  | { readonly type: "copy-invite" }
  | { readonly type: "reconnect" }
  | { readonly type: "disconnect" }
  | { readonly type: "open-logs" }
  | { readonly type: "resize"; readonly cols: number; readonly rows: number };

export interface ResizeEditorOptions {
  readonly cols: number;
  readonly rows: number;
  readonly policy: string;
  readonly hint?: string;
}

export interface MenuControllerOptions {
  readonly key: ActiveInviteKey;
  /** False keeps F12/Ctrl-] as ordinary TUI input and only routes F11. */
  readonly menuEnabled?: boolean;
  readonly getModel: (options: { readonly revealToken: boolean }) => MenuModel;
  readonly onAction: (action: MenuAction) => void;
  readonly resize?: ResizeEditorOptions;
}

export interface MenuKeyResult {
  /** Bytes that may still be sent to the hosted TUI. */
  readonly remaining: Uint8Array;
  readonly open: boolean;
  /** True when the overlay content or open state changed. */
  readonly changed: boolean;
  /** F11 was pressed; open (or close) the full-screen log view. */
  readonly logToggle: boolean;
}

const ESC = 0x1b;
const CTRL_BRACKET = 0x1d;
const CTRL_C = 0x03;
const LOWER_C = 0x63;
const UPPER_C = 0x43;
const LOWER_S = 0x73;
const UPPER_S = 0x53;
const ENTER = 0x0d;
const NEWLINE = 0x0a;
const BACKSPACE = 0x08;
const DELETE = 0x7f;

export type SpecialKey =
  | "f11"
  | "f12"
  | "menu"
  | "up"
  | "down"
  | "left"
  | "right"
  | "pgup"
  | "pgdn"
  | "esc";

type Token =
  | { readonly kind: "byte"; readonly byte: number }
  | {
      readonly kind: "key";
      readonly key: SpecialKey;
    };

interface Scan {
  readonly tokens: readonly Token[];
  readonly pending: Uint8Array;
}

function pushRaw(tokens: Token[], bytes: Uint8Array): void {
  for (const byte of bytes) tokens.push({ kind: "byte", byte });
}

/** Parse CSI sequences for the keys the menu/log view understands. */
function scan(chunk: Uint8Array): Scan {
  const tokens: Token[] = [];
  let index = 0;
  while (index < chunk.byteLength) {
    const byte = chunk[index] ?? 0;
    if (byte === CTRL_BRACKET) {
      tokens.push({ kind: "key", key: "menu" });
      index += 1;
      continue;
    }
    if (byte !== ESC) {
      tokens.push({ kind: "byte", byte });
      index += 1;
      continue;
    }
    const next = chunk[index + 1];
    if (next === undefined) {
      return { tokens, pending: chunk.slice(index) };
    }
    if (next !== 0x5b) {
      tokens.push({ kind: "key", key: "esc" });
      index += 1;
      continue;
    }
    let end = index + 2;
    while (end < chunk.byteLength) {
      const current = chunk[end] ?? 0;
      if (current >= 0x40 && current <= 0x7e) break;
      end += 1;
    }
    if (end >= chunk.byteLength) {
      return { tokens, pending: chunk.slice(index) };
    }
    const final = chunk[end] ?? 0;
    const params = Buffer.from(chunk.subarray(index + 2, end)).toString("ascii");
    const primary = Number.parseInt(params.split(";")[0] ?? "", 10);
    if (final === 0x7e) {
      if (primary === 23) tokens.push({ kind: "key", key: "f11" });
      else if (primary === 24) tokens.push({ kind: "key", key: "f12" });
      else if (primary === 5) tokens.push({ kind: "key", key: "pgup" });
      else if (primary === 6) tokens.push({ kind: "key", key: "pgdn" });
      else pushRaw(tokens, chunk.subarray(index, end + 1));
    } else if (final === 0x41) tokens.push({ kind: "key", key: "up" });
    else if (final === 0x42) tokens.push({ kind: "key", key: "down" });
    else if (final === 0x43) tokens.push({ kind: "key", key: "right" });
    else if (final === 0x44) tokens.push({ kind: "key", key: "left" });
    else pushRaw(tokens, chunk.subarray(index, end + 1));
    index = end + 1;
  }
  return { tokens, pending: new Uint8Array(0) };
}

/** Parse only the special keys; used by the full-screen log-view key router. */
export function scanSpecialKeys(chunk: Uint8Array): {
  readonly keys: readonly SpecialKey[];
  readonly pending: Uint8Array;
} {
  const result = scan(chunk);
  return {
    keys: result.tokens
      .filter((token): token is { kind: "key"; key: SpecialKey } => token.kind === "key")
      .map((token) => token.key),
    pending: result.pending,
  };
}

/** Rebuild an unmodified key sequence for pass-through while the menu is closed. */
function keyBytes(key: SpecialKey): readonly number[] {
  switch (key) {
    case "esc":
      return [ESC];
    case "menu":
      return [CTRL_BRACKET];
    case "f12":
      return [ESC, 0x5b, 0x32, 0x34, 0x7e];
    case "f11":
      return [ESC, 0x5b, 0x32, 0x33, 0x7e];
    case "up":
      return [ESC, 0x5b, 0x41];
    case "down":
      return [ESC, 0x5b, 0x42];
    case "right":
      return [ESC, 0x5b, 0x43];
    case "left":
      return [ESC, 0x5b, 0x44];
    case "pgup":
      return [ESC, 0x5b, 0x35, 0x7e];
    case "pgdn":
      return [ESC, 0x5b, 0x36, 0x7e];
  }
}

export class MenuController {
  readonly #key: ActiveInviteKey;
  readonly #menuEnabled: boolean;
  readonly #getModel: MenuControllerOptions["getModel"];
  readonly #onAction: MenuControllerOptions["onAction"];
  readonly #resize: ResizeEditorOptions | null;
  #buffer: Uint8Array = new Uint8Array(0);
  #open = false;
  #revealToken = false;
  #editor: { cols: number; rows: number } | null = null;

  constructor(options: MenuControllerOptions) {
    this.#key = options.key;
    this.#menuEnabled = options.menuEnabled !== false;
    this.#getModel = options.getModel;
    this.#onAction = options.onAction;
    this.#resize = options.resize ?? null;
  }

  get open(): boolean {
    return this.#open;
  }

  get revealToken(): boolean {
    return this.#revealToken;
  }

  get editingResize(): boolean {
    return this.#editor !== null;
  }

  get hasPending(): boolean {
    return this.#buffer.byteLength > 0;
  }

  /** Release a held partial escape sequence as ordinary input. */
  flushPending(): Uint8Array {
    const pending = this.#buffer;
    this.#buffer = new Uint8Array(0);
    return pending;
  }

  /** Lines for the current overlay (menu or resize editor). */
  lines(): readonly string[] {
    if (this.#editor !== null) {
      const policy = this.#resize?.policy ?? "latest";
      const hint = this.#resize?.hint ?? "";
      return [
        "TOKIMEKI WINDOW SIZE",
        "",
        `current: ${this.#editor.cols} x ${this.#editor.rows}`,
        `policy: ${policy}`,
        ...(hint.length === 0 ? [] : ["", hint]),
        "",
        "left/right: cols  up/down: rows  PgUp/PgDn: +/-10",
        "Enter: apply    Esc: cancel",
      ];
    }
    const model = this.#getModel({ revealToken: this.#revealToken });
    const lines = [model.title, "", ...model.lines, ""];
    model.items.forEach((item, index) => {
      lines.push(`  ${index + 1}. ${item.label}`);
    });
    lines.push("");
    lines.push("1-9: select   c: copy config   s: show/hide token   Esc: close");
    return lines;
  }

  handle(chunk: Uint8Array): MenuKeyResult {
    let input: Uint8Array = chunk;
    if (this.#buffer.byteLength > 0) {
      const merged = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
      merged.set(this.#buffer, 0);
      merged.set(chunk, this.#buffer.byteLength);
      this.#buffer = new Uint8Array(0);
      input = merged;
    }
    const result = scan(input);
    this.#buffer = result.pending;
    let tokens: readonly Token[] = result.tokens;
    // A lone Esc keypress arrives as a single-byte chunk. While the menu is
    // modal we can close/cancel immediately instead of waiting for the flush
    // timer; a split CSI sequence would still start with ESC + '[' in its next
    // chunk and is treated as ordinary input on flush.
    if (this.#open && result.pending.byteLength === 1 && result.pending[0] === ESC) {
      tokens = [...tokens, { kind: "key", key: "esc" }];
      this.#buffer = new Uint8Array(0);
    }
    let changed = false;
    let logToggle = false;
    let consumeRest = false;
    const forwarded: number[] = [];

    for (const token of tokens) {
      if (this.#open) {
        if (token.kind === "byte") {
          changed = this.#handleOpenBytes(Uint8Array.of(token.byte)) || changed;
          continue;
        }
        if (token.key === "f11") {
          this.#close();
          changed = true;
          logToggle = true;
          consumeRest = true;
          continue;
        }
        if (token.key === "f12") {
          if (this.#key === "f12") {
            this.#close();
            changed = true;
          }
          continue;
        }
        if (token.key === "menu") {
          if (this.#key === "ctrl-]") {
            this.#close();
            changed = true;
          }
          continue;
        }
        changed = this.#handleOpenKey(token.key) || changed;
        continue;
      }
      if (consumeRest) continue;
      if (token.kind === "byte") {
        forwarded.push(token.byte);
        continue;
      }
      switch (token.key) {
        case "f11":
          logToggle = true;
          consumeRest = true;
          break;
        case "f12":
          if (this.#menuEnabled && this.#key === "f12") {
            this.#openMenu();
            changed = true;
          } else {
            for (const byte of keyBytes(token.key)) forwarded.push(byte);
          }
          break;
        case "menu":
          if (this.#menuEnabled && this.#key === "ctrl-]") {
            this.#openMenu();
            changed = true;
          } else {
            forwarded.push(CTRL_BRACKET);
          }
          break;
        default:
          for (const byte of keyBytes(token.key)) forwarded.push(byte);
          break;
      }
    }

    return {
      remaining: Uint8Array.from(forwarded),
      open: this.#open,
      changed: changed || logToggle,
      logToggle,
    };
  }

  /** Close the menu and forget transient reveal/editor state. */
  close(): void {
    this.#close();
  }

  #openMenu(): void {
    this.#open = true;
    this.#revealToken = false;
    this.#editor = null;
  }

  #close(): void {
    this.#open = false;
    this.#revealToken = false;
    this.#editor = null;
  }

  #handleOpenKey(key: SpecialKey): boolean {
    if (this.#editor !== null) {
      const editor = this.#editor;
      switch (key) {
        case "esc":
          this.#editor = null;
          return true;
        case "left":
          editor.cols = Math.max(1, editor.cols - 1);
          return true;
        case "right":
          editor.cols = Math.min(999, editor.cols + 1);
          return true;
        case "up":
          editor.rows = Math.min(999, editor.rows + 1);
          return true;
        case "down":
          editor.rows = Math.max(1, editor.rows - 1);
          return true;
        case "pgup":
          editor.rows = Math.min(999, editor.rows + 10);
          return true;
        case "pgdn":
          editor.rows = Math.max(1, editor.rows - 10);
          return true;
        default:
          return false;
      }
    }
    if (key === "esc") {
      this.#close();
      return true;
    }
    return false;
  }

  #handleOpenBytes(bytes: Uint8Array): boolean {
    let changed = false;
    for (const byte of bytes) {
      if (!this.#open) return changed;
      if (this.#editor !== null) {
        if (byte === ENTER || byte === NEWLINE) {
          const editor = this.#editor;
          this.#editor = null;
          this.#close();
          this.#onAction({ type: "resize", cols: editor.cols, rows: editor.rows });
          return true;
        }
        if (byte === BACKSPACE || byte === DELETE) {
          this.#editor = null;
          return true;
        }
        continue;
      }
      if (byte === ESC || byte === CTRL_C) {
        this.#close();
        return true;
      }
      if (byte === LOWER_C || byte === UPPER_C) {
        this.#onAction({ type: "copy-config" });
        continue;
      }
      if (byte === LOWER_S || byte === UPPER_S) {
        this.#revealToken = !this.#revealToken;
        changed = true;
        continue;
      }
      if (byte >= 0x31 && byte <= 0x39) {
        const index = byte - 0x31;
        const model = this.#getModel({ revealToken: this.#revealToken });
        const item = model.items[index];
        if (item === undefined) continue;
        if (item.id === "show-token") {
          this.#revealToken = !this.#revealToken;
          changed = true;
          continue;
        }
        if (item.id === "resize") {
          const size = this.#resize;
          if (size !== null) {
            this.#editor = { cols: size.cols, rows: size.rows };
            changed = true;
          }
          continue;
        }
        if (item.id === "status") continue;
        if (item.id === "copy-config") this.#onAction({ type: "copy-config" });
        else if (item.id === "copy-invite") this.#onAction({ type: "copy-invite" });
        else if (item.id === "reconnect") this.#onAction({ type: "reconnect" });
        else if (item.id === "disconnect") this.#onAction({ type: "disconnect" });
        else if (item.id === "open-logs") this.#onAction({ type: "open-logs" });
      }
    }
    return changed;
  }
}
