/**
 * Mouse input translation for the local viewport.
 *
 * The local terminal is put into SGR mouse mode (`?1006`) so the CLI receives
 * unambiguous `ESC [ < b ; x ; y M/m` events. Those coordinates are mapped from
 * the local viewport into the fixed logical grid, then re-encoded in the
 * encoding the hosted TUI actually enabled (SGR or legacy X10).
 */

import {
  type LogicalPoint,
  mapLocalToLogical,
  type ViewportCamera,
  type ViewportFrame,
} from "./geometry.js";

const ESC = 0x1b;
const BRACKET = 0x5b;
const SGR_PREFIX = 0x3c;
const X10_PREFIX = 0x4d;
const FINAL_M = 0x4d;
const FINAL_m = 0x6d;
const MAX_BUFFER_BYTES = 64;

export interface MouseTranslationMap {
  readonly frame: ViewportFrame;
  readonly camera: ViewportCamera;
}

interface ParsedMouse {
  readonly button: number;
  readonly x: number; // 1-based
  readonly y: number; // 1-based
  final: number;
}

function encodeMouse(parsed: ParsedMouse, encodeSgr: boolean): Uint8Array | null {
  if (encodeSgr) {
    return new TextEncoder().encode(
      `\x1b[<${parsed.button};${parsed.x};${parsed.y}${String.fromCharCode(parsed.final)}`,
    );
  }
  // Legacy X10: three bytes after ESC [ M. Coordinates above 223 cannot be
  // represented; dropping is safer than clicking the wrong cell. An SGR
  // release has no X10 final byte and must become button 3 (release).
  if (parsed.x > 223 || parsed.y > 223) return null;
  const button = parsed.final === FINAL_m ? 3 : parsed.button;
  return Uint8Array.of(ESC, BRACKET, X10_PREFIX, 32 + button, 32 + parsed.x, 32 + parsed.y);
}

function parseSgrParams(raw: string): ParsedMouse | null {
  const parts = raw.split(";");
  if (parts.length < 3) return null;
  const button = Number.parseInt(parts[0] ?? "", 10);
  const x = Number.parseInt(parts[1] ?? "", 10);
  const y = Number.parseInt(parts[2] ?? "", 10);
  if (!Number.isFinite(button) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { button, x, y, final: FINAL_M };
}

export class MouseInputTranslator {
  #buffer = new Uint8Array(0);
  #map: MouseTranslationMap | null = null;
  #encodeSgr = true;

  setMap(map: MouseTranslationMap | null): void {
    this.#map = map;
  }

  setEncodeSgr(enabled: boolean): void {
    this.#encodeSgr = enabled;
  }

  get hasPending(): boolean {
    return this.#buffer.byteLength > 0;
  }

  /** Translate a stdin chunk; incomplete mouse prefixes stay buffered. */
  translate(chunk: Uint8Array): Uint8Array {
    if (chunk.byteLength > 0) {
      const merged = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
      merged.set(this.#buffer, 0);
      merged.set(chunk, this.#buffer.byteLength);
      this.#buffer = merged;
    }
    return this.#drain(false);
  }

  /** Flush an incomplete prefix as ordinary input (short timeout / exit). */
  flushPending(): Uint8Array {
    return this.#drain(true);
  }

  #drain(flush: boolean): Uint8Array {
    const input = this.#buffer;
    const output: number[] = [];
    let index = 0;
    let heldFrom = input.byteLength;

    while (index < input.byteLength) {
      if (input[index] !== ESC) {
        output.push(input[index] ?? 0);
        index += 1;
        continue;
      }
      if (index + 1 >= input.byteLength) {
        heldFrom = index;
        break;
      }
      if (input[index + 1] !== BRACKET) {
        output.push(ESC);
        index += 1;
        continue;
      }
      if (index + 2 >= input.byteLength) {
        heldFrom = index;
        break;
      }
      if (input[index + 2] === X10_PREFIX) {
        if (index + 5 >= input.byteLength) {
          heldFrom = index;
          break;
        }
        const parsed: ParsedMouse = {
          button: (input[index + 3] ?? 32) - 32,
          x: (input[index + 4] ?? 32) - 32,
          y: (input[index + 5] ?? 32) - 32,
          final: FINAL_M,
        };
        const encoded = this.#mapMouse(parsed);
        if (encoded !== null) output.push(...encoded);
        index += 6;
        continue;
      }
      if (input[index + 2] !== SGR_PREFIX) {
        output.push(ESC);
        index += 1;
        continue;
      }
      let end = index + 3;
      while (end < input.byteLength && input[end] !== FINAL_M && input[end] !== FINAL_m) {
        end += 1;
      }
      if (end >= input.byteLength) {
        heldFrom = index;
        break;
      }
      const rawParams = new TextDecoder().decode(input.subarray(index + 3, end));
      const parsed = parseSgrParams(rawParams);
      if (parsed === null) {
        // Malformed SGR mouse: pass the bytes through rather than dropping
        // arbitrary input.
        for (let i = index; i <= end; i += 1) output.push(input[i] ?? 0);
      } else {
        parsed.final = input[end] ?? FINAL_M;
        const encoded = this.#mapMouse(parsed);
        if (encoded !== null) output.push(...encoded);
      }
      index = end + 1;
    }

    if (index < heldFrom) {
      for (let i = index; i < heldFrom; i += 1) output.push(input[i] ?? 0);
    }
    const rest = heldFrom < input.byteLength ? input.subarray(heldFrom) : new Uint8Array(0);
    if (flush && rest.byteLength > 0) {
      for (const byte of rest) output.push(byte);
      this.#buffer = new Uint8Array(0);
    } else if (rest.byteLength > MAX_BUFFER_BYTES) {
      for (const byte of rest) output.push(byte);
      this.#buffer = new Uint8Array(0);
    } else {
      this.#buffer = Uint8Array.from(rest);
    }
    return Uint8Array.from(output);
  }

  #mapMouse(parsed: ParsedMouse): Uint8Array | null {
    const map = this.#map;
    if (map === null) {
      return encodeMouse(parsed, this.#encodeSgr);
    }
    const logical: LogicalPoint | null = mapLocalToLogical(
      map.frame,
      map.camera,
      parsed.x - 1,
      parsed.y - 1,
    );
    if (logical === null) return null;
    return encodeMouse({ ...parsed, x: logical.x + 1, y: logical.y + 1 }, this.#encodeSgr);
  }
}
