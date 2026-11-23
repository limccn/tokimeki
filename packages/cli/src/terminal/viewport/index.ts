/**
 * Local viewport bundle shared by the host and attach sessions.
 *
 * It connects the headless mirror, terminal-mode tracker, renderer, key router,
 * and mouse translator. The session owns transport/input; this class owns
 * presentation and local-only overlays (connection menu, resize editor,
 * full-screen log view).
 */

import type { ActiveInviteKey } from "../../invite.js";
import type { TerminalMirror } from "../mirror.js";
import type { ModeTracker } from "../mode-tracker.js";
import type { TerminalSize } from "./geometry.js";
import {
  type MenuAction,
  MenuController,
  type MenuModel,
  type ResizeEditorOptions,
  scanSpecialKeys,
} from "./menu.js";
import { ModeSynchronizer, readTerminalInputModes } from "./modes.js";
import { MouseInputTranslator, type MouseTranslationMap } from "./mouse.js";
import { ViewportRenderer, type ViewportRendererOptions, type ViewportStatus } from "./renderer.js";

export type { ViewportCamera, ViewportFrame } from "./geometry.js";
export type { MenuAction, MenuItem, MenuModel } from "./menu.js";
export type {
  ViewportRelayState,
  ViewportRole,
  ViewportStatus,
  ViewportTransport,
} from "./renderer.js";
export { ViewportRenderer } from "./renderer.js";

export interface LocalMenuOptions {
  readonly key: ActiveInviteKey;
  readonly role: "host" | "viewer" | "listener";
  readonly getModel: (options: { readonly revealToken: boolean }) => MenuModel;
  readonly onAction: (action: MenuAction) => void;
  /** Exact viewer-config JSON copied by `c` / the copy item. */
  readonly copyText: string;
  /** Hosted anonymous invite URL (capability secret, memory only). */
  readonly inviteUrl?: string;
  readonly resize?: ResizeEditorOptions;
}

export interface LocalViewportOptions {
  readonly mirror: TerminalMirror;
  readonly tracker: ModeTracker;
  readonly stdout: NodeJS.WriteStream;
  /** Log-ring capacity; 0 disables the corner log area and log view. */
  readonly logViewRows: number;
  readonly status: ViewportStatus;
  /** Local connection menu (F12/Ctrl-]). */
  readonly menu?: LocalMenuOptions;
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
  readonly #menu: MenuController;
  readonly #menuOptions: LocalMenuOptions | null;
  #logBuffer: Uint8Array = new Uint8Array(0);
  #flushTimer: NodeJS.Timeout | null = null;
  #disposed = false;
  #started = false;

  constructor(options: LocalViewportOptions) {
    this.#mirror = options.mirror;
    this.#tracker = options.tracker;
    this.#onInput = options.onInput;
    this.#menuOptions = options.menu ?? null;
    // The controller always exists so F11 can toggle the log view even when
    // the connection menu is disabled.
    this.#menu = new MenuController({
      key: options.menu?.key ?? "f12",
      menuEnabled: options.menu !== undefined,
      getModel: options.menu?.getModel ?? (() => ({ title: "", lines: [], items: [] })),
      onAction: (action) => this.#handleMenuAction(action),
      ...(options.menu?.resize === undefined ? {} : { resize: options.menu.resize }),
    });
    this.#renderer = new ViewportRenderer({
      mirror: options.mirror,
      stdout: options.stdout,
      logical: { cols: options.mirror.cols, rows: options.mirror.rows },
      logViewRows: options.logViewRows,
      status: options.status,
      isCursorVisible: () => this.#tracker.modes.cursorVisible,
    } satisfies ViewportRendererOptions);
    this.#renderer.setCopyText(options.menu?.copyText ?? "");
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

  /** Route local stdin through the local menu/log view and mouse translation. */
  handleInput(chunk: Uint8Array): Uint8Array {
    let input = chunk;
    if (this.#renderer.logViewOpen) {
      this.#handleLogViewInput(input);
      return new Uint8Array(0);
    }
    const result = this.#menu.handle(input);
    if (result.logToggle) {
      // Bytes typed before F11 still belong to the TUI.
      if (result.remaining.byteLength > 0) this.#forwardInput(result.remaining);
      this.#renderer.setMenuOverlay(null);
      this.#renderer.setLogView(true);
      return new Uint8Array(0);
    }
    if (result.changed) {
      this.#renderer.setMenuOverlay(this.#menu.open ? this.#menu.lines() : null);
    }
    if (result.open) {
      if (result.remaining.byteLength > 0) this.#forwardInput(result.remaining);
      return new Uint8Array(0);
    }
    input = result.remaining;
    if (input.byteLength === 0) return input;
    return this.#forwardInput(input);
  }

  resizeLocal(local: TerminalSize): void {
    this.#renderer.resize(local);
  }

  /** Change the logical grid after a host-side window resize. */
  resizeLogical(logical: TerminalSize): void {
    this.#renderer.setLogical(logical);
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

  #handleMenuAction(action: MenuAction): void {
    if (action.type === "copy-config") {
      this.#renderer.copyText(this.#menuOptions?.copyText ?? "");
      return;
    }
    if (action.type === "copy-invite") {
      const url = this.#menuOptions?.inviteUrl;
      if (url !== undefined) this.#renderer.copyText(url);
      return;
    }
    if (action.type === "open-logs") {
      this.#menu?.close();
      this.#renderer.setMenuOverlay(null);
      this.#renderer.setLogView(true);
      return;
    }
    // reconnect/resize/disconnect close the menu before acting.
    this.#menu?.close();
    this.#renderer.setMenuOverlay(null);
    this.#menuOptions?.onAction(action);
  }

  #handleLogViewInput(chunk: Uint8Array): void {
    let input: Uint8Array = chunk;
    if (this.#logBuffer.byteLength > 0) {
      const merged = new Uint8Array(this.#logBuffer.byteLength + chunk.byteLength);
      merged.set(this.#logBuffer, 0);
      merged.set(chunk, this.#logBuffer.byteLength);
      this.#logBuffer = new Uint8Array(0);
      input = merged;
    }
    const result = scanSpecialKeys(input);
    this.#logBuffer = result.pending;
    for (const key of result.keys) {
      if (key === "f11" || key === "esc") {
        this.#renderer.setLogView(false);
        this.#logBuffer = new Uint8Array(0);
        return;
      }
      if (key === "up") this.#renderer.scrollLogBy(1);
      else if (key === "down") this.#renderer.scrollLogBy(-1);
      else if (key === "pgup") this.#renderer.scrollLogBy(10);
      else if (key === "pgdn") this.#renderer.scrollLogBy(-10);
    }
    // Plain bytes are consumed while the log view owns the local screen.
    if (result.pending.byteLength > 0) {
      this.#scheduleFlush();
    }
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
    if (this.#mouse.hasPending || this.#menu.hasPending || this.#logBuffer.byteLength > 0) {
      this.#scheduleFlush();
    }
    return translated;
  }

  #scheduleFlush(): void {
    if (this.#flushTimer !== null || this.#disposed) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      if (this.#disposed) return;
      const pending = this.#menu.flushPending();
      if (pending.byteLength > 0) this.#forwardInput(pending);
      // A partial escape sequence inside the log view is local-only input.
      this.#logBuffer = new Uint8Array(0);
      const pendingMouse = this.#mouse.flushPending();
      if (pendingMouse.byteLength > 0) this.#onInput(pendingMouse);
    }, MOUSE_FLUSH_MS);
    this.#flushTimer.unref?.();
  }
}
