/**
 * Streaming terminal-mode tracker.
 *
 * `@xterm/addon-serialize` does not reproduce every private mode (notably SGR
 * mouse encoding `?1006` and Kitty keyboard flags), so the host parses PTY
 * output as it flows and re-applies the modes that are both active and safe to
 * replay after a snapshot.
 *
 * The parser works on raw bytes so escape sequences split across PTY chunks
 * are still recognized.
 */

export interface TrackedModes {
  altScreen: boolean;
  mouse1000: boolean;
  mouse1002: boolean;
  mouse1003: boolean;
  mouse1006: boolean;
  bracketedPaste: boolean;
  focusEvents: boolean;
  synchronizedOutput: boolean;
  cursorVisible: boolean;
  kittyDepth: number;
  kittyFlags: number;
}

const GROUND = 0;
const ESCAPE = 1;
const CONTROL_SEQUENCE = 2;

const MAX_PARAMS = 64;

function initialState(): TrackedModes {
  return {
    altScreen: false,
    mouse1000: false,
    mouse1002: false,
    mouse1003: false,
    mouse1006: false,
    bracketedPaste: false,
    focusEvents: false,
    synchronizedOutput: false,
    cursorVisible: true,
    kittyDepth: 0,
    kittyFlags: 0,
  };
}

export class ModeTracker {
  #modes: TrackedModes = initialState();
  #state = GROUND;
  #params = "";

  get modes(): Readonly<TrackedModes> {
    return this.#modes;
  }

  get synchronizedOutput(): boolean {
    return this.#modes.synchronizedOutput;
  }

  get cursorVisible(): boolean {
    return this.#modes.cursorVisible;
  }

  /** Reset all tracked modes (snapshot boundary / reconnect). */
  reset(): void {
    this.#modes = initialState();
    this.#state = GROUND;
    this.#params = "";
  }

  /** Feed raw PTY output. Incomplete escape sequences are buffered. */
  apply(chunk: Uint8Array): void {
    for (const byte of chunk) {
      this.#byte(byte);
    }
  }

  #byte(byte: number): void {
    switch (this.#state) {
      case GROUND:
        if (byte === 0x1b) {
          this.#state = ESCAPE;
        } else if (byte === 0x9b) {
          this.#state = CONTROL_SEQUENCE;
          this.#params = "";
        }
        return;
      case ESCAPE:
        if (byte === 0x5b) {
          this.#state = CONTROL_SEQUENCE;
          this.#params = "";
        } else {
          this.#state = GROUND;
        }
        return;
      case CONTROL_SEQUENCE:
        if (byte >= 0x20 && byte <= 0x3f) {
          if (this.#params.length < MAX_PARAMS) {
            this.#params += String.fromCharCode(byte);
          }
          return;
        }
        if (byte >= 0x40 && byte <= 0x7e) {
          this.#finish(this.#params, String.fromCharCode(byte));
          this.#state = GROUND;
          this.#params = "";
          return;
        }
        // Malformed sequence: reset rather than swallowing normal output.
        this.#state = GROUND;
        this.#params = "";
        return;
      default:
        this.#state = GROUND;
    }
  }

  #finish(params: string, final: string): void {
    if (final === "h" || final === "l") {
      const enabled = final === "h";
      if (params.startsWith("?")) {
        for (const raw of params.slice(1).split(";")) {
          if (raw === "") continue;
          const mode = Number.parseInt(raw, 10);
          if (!Number.isFinite(mode)) continue;
          this.#setPrivateMode(mode, enabled);
        }
      }
      return;
    }
    if (final !== "u") return;
    if (params.startsWith(">")) {
      const flags = Number.parseInt(params.slice(1).split(";")[0] ?? "0", 10);
      this.#modes.kittyDepth = Math.min(32, this.#modes.kittyDepth + 1);
      if (Number.isFinite(flags)) this.#modes.kittyFlags = flags;
      return;
    }
    if (params.startsWith("<")) {
      if (this.#modes.kittyDepth > 0) this.#modes.kittyDepth -= 1;
      return;
    }
    if (params.startsWith("=")) {
      const flags = Number.parseInt(params.slice(1).split(";")[0] ?? "0", 10);
      if (Number.isFinite(flags)) this.#modes.kittyFlags = flags;
    }
  }

  #setPrivateMode(mode: number, enabled: boolean): void {
    switch (mode) {
      case 25:
        this.#modes.cursorVisible = enabled;
        return;
      case 47:
      case 1047:
      case 1049:
        this.#modes.altScreen = enabled;
        return;
      case 1000:
        this.#modes.mouse1000 = enabled;
        return;
      case 1002:
        this.#modes.mouse1002 = enabled;
        return;
      case 1003:
        this.#modes.mouse1003 = enabled;
        return;
      case 1004:
        this.#modes.focusEvents = enabled;
        return;
      case 1006:
        this.#modes.mouse1006 = enabled;
        return;
      case 2004:
        this.#modes.bracketedPaste = enabled;
        return;
      case 2026:
        this.#modes.synchronizedOutput = enabled;
        return;
      default:
    }
  }

  /**
   * ANSI sequence re-applying the modes a serialized snapshot does not carry.
   *
   * `@xterm/addon-serialize` already restores the active buffer (including the
   * alternate-screen switch) and mouse/paste/focus modes, so re-entering the
   * alternate screen here would risk clearing the snapshot content on real
   * terminals. `?2026` is intentionally never enabled: the host only takes
   * snapshots outside synchronized-output blocks, so the block must not be
   * re-entered by a replay.
   */
  replaySequence(): string {
    const modes = this.#modes;
    const parts: string[] = [];
    if (modes.mouse1003) {
      parts.push("\x1b[?1003h");
    } else if (modes.mouse1002) {
      parts.push("\x1b[?1002h");
    } else if (modes.mouse1000) {
      parts.push("\x1b[?1000h");
    }
    if (modes.mouse1006) parts.push("\x1b[?1006h");
    parts.push(modes.bracketedPaste ? "\x1b[?2004h" : "\x1b[?2004l");
    parts.push(modes.focusEvents ? "\x1b[?1004h" : "\x1b[?1004l");
    parts.push(modes.cursorVisible ? "\x1b[?25h" : "\x1b[?25l");
    if (modes.kittyDepth > 0) parts.push(`\x1b[>${modes.kittyFlags}u`);
    return parts.join("");
  }
}
