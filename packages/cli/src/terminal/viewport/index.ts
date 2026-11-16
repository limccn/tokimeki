/**
 * Local viewport bundle shared by the host and attach sessions.
 *
 * It connects the headless mirror, terminal-mode tracker, renderer, and mouse
 * translator. The session owns transport/input; this class owns presentation.
 */

import type { ActiveInviteKey } from "../../invite.js";
import type { TerminalMirror } from "../mirror.js";
import type { ModeTracker } from "../mode-tracker.js";
import type { TerminalSize } from "./geometry.js";
import { InviteKeyController } from "./invite.js";
import { ModeSynchronizer, readTerminalInputModes } from "./modes.js";
import { MouseInputTranslator, type MouseTranslationMap } from "./mouse.js";
import { ViewportRenderer, type ViewportRendererOptions, type ViewportStatus } from "./renderer.js";

export type { ViewportCamera, ViewportFrame } from "./geometry.js";
export type {
  ViewportRelayState,
  ViewportRole,
  ViewportStatus,
  ViewportTransport,
} from "./renderer.js";
export { ViewportRenderer } from "./renderer.js";

export interface LocalInviteOptions {
  readonly key: ActiveInviteKey;
  readonly lines: readonly string[];
  readonly copyText: string;
}

export interface LocalViewportOptions {
  readonly mirror: TerminalMirror;
  readonly tracker: ModeTracker;
  readonly stdout: NodeJS.WriteStream;
  readonly logRows: number;
  readonly status: ViewportStatus;
  /** Host-only local viewer-config overlay. */
  readonly invite?: LocalInviteOptions;
  /** Called with translated terminal input (keyboard + mapped mouse). */
  readonly onInput: (data: Uint8Array) => void;
}

const MOUSE_FLUSH_MS = 50;

export class LocalViewport {
  readonly #mirror: TerminalMirror;
  readonly #tracker: ModeTracker;
  readonly #onInput: (data: Uint8Array) => void;
  readonly #mouse = new MouseInputTranslator();
  readonly #modes = new ModeSynchronizer();
  readonly #renderer: ViewportRenderer;
  readonly #invite: InviteKeyController | null;
  readonly #inviteLines: readonly string[];
  readonly #inviteCopyText: string;
  #flushTimer: NodeJS.Timeout | null = null;
  #disposed = false;
  #started = false;

  constructor(options: LocalViewportOptions) {
    this.#mirror = options.mirror;
    this.#tracker = options.tracker;
    this.#onInput = options.onInput;
    this.#invite = options.invite === undefined ? null : new InviteKeyController(options.invite.key);
    this.#inviteLines = options.invite?.lines ?? [];
    this.#inviteCopyText = options.invite?.copyText ?? "";
    this.#renderer = new ViewportRenderer({
      mirror: options.mirror,
      stdout: options.stdout,
      logical: { cols: options.mirror.cols, rows: options.mirror.rows },
      logRows: options.logRows,
      status: options.status,
      isCursorVisible: () => this.#tracker.modes.cursorVisible,
    } satisfies ViewportRendererOptions);
    this.#mirror.setOnParsed(() => this.#handleParsed());
  }

  get mirror(): TerminalMirror {
    return this.#mirror;
  }

  get tracker(): ModeTracker {
    return this.#tracker;
  }

  get renderer(): ViewportRenderer {
    return this.#renderer;
  }

  get layout(): MouseTranslationMap {
    return this.#renderer.layout;
  }

  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    this.#renderer.start();
    this.#handleParsed();
  }

  /** Feed hosted output into the mirror (snapshot/reset handled separately). */
  write(data: Uint8Array): void {
    this.#tracker.apply(data);
    this.#mirror.write(data);
  }

  /** Reset the mirror at a snapshot boundary and apply the snapshot payload. */
  resetAndWriteSnapshot(data: Uint8Array): void {
    this.#tracker.reset();
    this.#mirror.resetAndWrite(data);
    this.#tracker.apply(data);
    this.#renderer.invalidate();
  }

  /** Route local stdin through the local invite overlay and mouse translation. */
  handleInput(chunk: Uint8Array): Uint8Array {
    let input = chunk;
    if (this.#invite !== null) {
      const result = this.#invite.handle(input);
      if (result.changed) {
        this.#renderer.setInviteOverlay(
          result.open ? this.#inviteLines : null,
          this.#inviteCopyText,
        );
      }
      if (result.copyRequested) this.#renderer.copyInvite();
      input = result.remaining;
      if (result.open) {
        // Bytes typed before the trigger in the same chunk still belong to
        // the TUI; bytes after it were already consumed by the controller.
        if (input.byteLength > 0) this.#forwardInput(input);
        return new Uint8Array(0);
      }
      if (input.byteLength === 0) return input;
    }
    return this.#forwardInput(input);
  }

  resizeLocal(local: TerminalSize): void {
    this.#renderer.resize(local);
  }

  setStatus(status: ViewportStatus): void {
    this.#renderer.setStatus(status);
  }

  appendLog(line: string): void {
    this.#renderer.appendLog(line);
  }

  restoreSync(): void {
    if (this.#disposed) return;
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    const reset = this.#modes.reset();
    if (reset.length > 0) this.#renderer.writeControl(reset);
    this.#renderer.dispose();
    this.#mirror.setOnParsed(null);
    this.#disposed = true;
  }

  dispose(): void {
    this.restoreSync();
  }

  #handleParsed(): void {
    if (this.#disposed) return;
    this.#syncModes();
    this.#renderer.markViewportDirty();
  }

  #syncModes(): void {
    if (this.#disposed || !this.#started) return;
    const sequence = this.#modes.update(readTerminalInputModes(this.#mirror.term, this.#tracker));
    if (sequence.length > 0) this.#renderer.writeControl(sequence);
  }

  #forwardInput(chunk: Uint8Array): Uint8Array {
    this.#syncModes();
    this.#mouse.setMap(this.#renderer.layout);
    this.#mouse.setEncodeSgr(this.#tracker.modes.mouse1006);
    const translated = this.#mouse.translate(chunk);
    if (translated.byteLength > 0) this.#onInput(translated);
    if (this.#mouse.hasPending || this.#invite?.hasPending === true) {
      this.#scheduleFlush();
    }
    return translated;
  }

  #scheduleFlush(): void {
    if (this.#flushTimer !== null || this.#disposed) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      if (this.#disposed) return;
      const invitePending = this.#invite?.flushPending() ?? new Uint8Array(0);
      if (invitePending.byteLength > 0) this.#forwardInput(invitePending);
      const pending = this.#mouse.flushPending();
      if (pending.byteLength > 0) this.#onInput(pending);
    }, MOUSE_FLUSH_MS);
    this.#flushTimer.unref?.();
  }
}
