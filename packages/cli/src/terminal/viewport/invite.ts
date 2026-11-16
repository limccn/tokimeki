/**
 * Local invite-overlay key handling.
 *
 * The key is consumed locally and never reaches the hosted TUI. While the
 * overlay is open the controller consumes all input except:
 * - the same key or Esc closes it,
 * - `c` requests an OSC 52 copy of the exact viewer config.
 */

import type { ActiveInviteKey } from "../../invite.js";

const ESC = 0x1b;
const BRACKET = 0x5b;
const TWO = 0x32;
const FOUR = 0x34;
const SEMI = 0x3b;
const TILDE = 0x7e;
const ZERO = 0x30;
const NINE = 0x39;
const CTRL_BRACKET = 0x1d;
const CTRL_C = 0x03;
const LOWER_C = 0x63;
const UPPER_C = 0x43;

const F12_PREFIX = [ESC, BRACKET, TWO, FOUR] as const;

export interface InviteKeyResult {
  /** Bytes that may still be sent to the hosted TUI. */
  readonly remaining: Uint8Array;
  readonly open: boolean;
  /** True when the overlay open state changed. */
  readonly changed: boolean;
  readonly copyRequested: boolean;
}

export class InviteKeyController {
  readonly #key: ActiveInviteKey;
  #buffer = new Uint8Array(0);
  #open = false;

  constructor(key: ActiveInviteKey) {
    this.#key = key;
  }

  get open(): boolean {
    return this.#open;
  }

  get hasPending(): boolean {
    return this.#buffer.byteLength > 0;
  }

  handle(chunk: Uint8Array): InviteKeyResult {
    if (this.#key === "ctrl-]") return this.#handleCtrlBracket(chunk);
    if (this.#buffer.byteLength > 0) {
      const merged = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
      merged.set(this.#buffer, 0);
      merged.set(chunk, this.#buffer.byteLength);
      this.#buffer = new Uint8Array(0);
      return this.#handleF12(merged);
    }
    return this.#handleF12(chunk);
  }

  /** Release a held partial F12 prefix as ordinary input. */
  flushPending(): Uint8Array {
    const pending = this.#buffer;
    this.#buffer = new Uint8Array(0);
    return pending;
  }

  #handleCtrlBracket(chunk: Uint8Array): InviteKeyResult {
    if (this.#open) {
      const close = chunk.includes(CTRL_BRACKET) || chunk.includes(ESC) || chunk.includes(CTRL_C);
      const copy = chunk.includes(LOWER_C) || chunk.includes(UPPER_C);
      if (close) this.#open = false;
      return {
        remaining: new Uint8Array(0),
        open: this.#open,
        changed: close,
        copyRequested: !close && copy,
      };
    }
    const trigger = chunk.indexOf(CTRL_BRACKET);
    if (trigger < 0) {
      return { remaining: chunk, open: false, changed: false, copyRequested: false };
    }
    this.#open = true;
    return {
      remaining: chunk.subarray(0, trigger),
      open: true,
      changed: true,
      copyRequested: false,
    };
  }

  #handleF12(chunk: Uint8Array): InviteKeyResult {
    if (this.#open) {
      const close = chunk.includes(ESC) || chunk.includes(CTRL_C);
      const copy = chunk.includes(LOWER_C) || chunk.includes(UPPER_C);
      if (close) this.#open = false;
      return {
        remaining: new Uint8Array(0),
        open: this.#open,
        changed: close,
        copyRequested: !close && copy,
      };
    }

    const output: number[] = [];
    let index = 0;
    while (index < chunk.byteLength) {
      const esc = chunk.indexOf(ESC, index);
      if (esc < 0) {
        for (let i = index; i < chunk.byteLength; i += 1) output.push(chunk[i] ?? 0);
        this.#buffer = new Uint8Array(0);
        return {
          remaining: Uint8Array.from(output),
          open: false,
          changed: false,
          copyRequested: false,
        };
      }

      let matched = 0;
      while (
        matched < F12_PREFIX.length &&
        esc + matched < chunk.byteLength &&
        chunk[esc + matched] === F12_PREFIX[matched]
      ) {
        matched += 1;
      }
      if (matched < F12_PREFIX.length) {
        if (esc + matched >= chunk.byteLength) {
          // The chunk ends inside a possible F12 prefix; hold it.
          for (let i = index; i < esc; i += 1) output.push(chunk[i] ?? 0);
          this.#buffer = chunk.slice(esc);
          return {
            remaining: Uint8Array.from(output),
            open: false,
            changed: false,
            copyRequested: false,
          };
        }
        // Not F12: pass the ESC and continue after it.
        for (let i = index; i <= esc; i += 1) output.push(chunk[i] ?? 0);
        index = esc + 1;
        continue;
      }

      let end = esc + F12_PREFIX.length;
      while (end < chunk.byteLength && chunk[end] !== TILDE) {
        const byte = chunk[end] ?? 0;
        const isModifier = byte === SEMI || (byte >= ZERO && byte <= NINE);
        if (!isModifier) break;
        end += 1;
      }
      if (end >= chunk.byteLength) {
        // Incomplete `ESC[24` / `ESC[24;...` sequence.
        for (let i = index; i < esc; i += 1) output.push(chunk[i] ?? 0);
        this.#buffer = chunk.slice(esc);
        return {
          remaining: Uint8Array.from(output),
          open: false,
          changed: false,
          copyRequested: false,
        };
      }
      if (chunk[end] !== TILDE) {
        // A different CSI such as ESC[24A: not our key.
        for (let i = index; i <= esc; i += 1) output.push(chunk[i] ?? 0);
        index = esc + 1;
        continue;
      }

      // F12: pass bytes before it, open the overlay, consume bytes after it.
      for (let i = index; i < esc; i += 1) output.push(chunk[i] ?? 0);
      this.#buffer = new Uint8Array(0);
      this.#open = true;
      return {
        remaining: Uint8Array.from(output),
        open: true,
        changed: true,
        copyRequested: false,
      };
    }

    this.#buffer = new Uint8Array(0);
    return {
      remaining: Uint8Array.from(output),
      open: false,
      changed: false,
      copyRequested: false,
    };
  }
}
