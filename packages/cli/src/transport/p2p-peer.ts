/**
 * One WebRTC PeerConnection/DataChannel pair for the P2P data path.
 *
 * The host always creates the DataChannel and therefore the offer; a viewer
 * accepts the offer and answers. Signaling travels as protocol `signal`
 * control messages over the relay; terminal frames travel over the
 * DataChannel once it opens.
 *
 * Failure policy: any ICE/DataChannel failure settles the peer exactly once so
 * the session can fall back to the relay data path. Callers that close the
 * peer themselves receive no close callback.
 */

import {
  FRAME_TYPES,
  MAX_FRAME_BYTES,
  type SignalKind,
  type TransportMode,
} from "@limccn/tokimeki-protocol";
import type { SelectedCandidateInfo } from "node-datachannel";
import nodeDataChannel, { type DataChannel, type PeerConnection } from "node-datachannel";

import type { Logger } from "../logger.js";
import { FragmentReassembler, sendFragments } from "./fragmentation.js";
import { classifyCandidatePair, type NodeRtcConfig } from "./ice.js";
import {
  candidateBudgetBytes,
  canQueueCandidate,
  MAX_SIGNAL_CANDIDATE_BYTES,
  MAX_SIGNAL_SDP_BYTES,
  readBoundedMid,
  readBoundedString,
} from "./signal-limits.js";

const ICE_TIMEOUT_MS = 12_000;
const MODE_LOOKUP_ATTEMPTS = 5;
const MODE_LOOKUP_DELAY_MS = 100;
const DRAIN_THRESHOLD_BYTES = 1_048_576;
const MAX_PENDING_CANDIDATES = 256;
/** Leave headroom below the host's 4 MiB P2P high-water mark. */
const P2P_SEND_CAP = 4_194_304;

export interface P2PSignalPayload {
  readonly kind: SignalKind;
  readonly payload: unknown;
}

export interface P2POpenInfo {
  readonly mode: TransportMode;
  /** Human-readable candidate detail, e.g. `host->srflx`. */
  readonly detail: string;
  /** Diagnostic hint: both selected candidates are loopback/private/link-local. */
  readonly lan: boolean;
}

/**
 * DataChannel creation options for the host side.
 *
 * F1's TUN profile runs over `unordered: true` with no SCTP retransmissions;
 * the tunnel supplies its own selective-repeat ARQ. The v1 path leaves this
 * undefined so the channel stays reliable/ordered.
 */
export interface P2PDataChannelConfig {
  readonly unordered?: boolean;
  readonly maxRetransmits?: number;
  readonly maxPacketLifeTime?: number;
}

export interface P2PPeerOptions {
  readonly label: string;
  readonly role: "host" | "viewer";
  readonly rtcConfig: NodeRtcConfig;
  readonly logger: Logger;
  readonly sendSignal: (kind: SignalKind, payload: Record<string, unknown>) => void;
  readonly onFrame: (bytes: Uint8Array) => void;
  readonly onOpen: (info: P2POpenInfo) => void;
  readonly onFailed: (reason: string) => void;
  readonly onClosed: (reason: string) => void;
  /** Host only: DataChannel reliability/delivery options. */
  readonly dataChannelConfig?: P2PDataChannelConfig;
  /** Host only: extra fields merged into the `offer` signal payload. */
  readonly offerMetadata?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toBytes(message: unknown): Uint8Array | null {
  if (Buffer.isBuffer(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  }
  if (message instanceof ArrayBuffer) {
    return new Uint8Array(message);
  }
  return null;
}

function describePair(
  pair: {
    readonly local: SelectedCandidateInfo;
    readonly remote: SelectedCandidateInfo;
  } | null,
): P2POpenInfo | null {
  return classifyCandidatePair(pair);
}

export class P2PPeer {
  readonly #options: P2PPeerOptions;
  readonly #pc: PeerConnection;
  readonly #logger: Logger;
  readonly #reassembler: FragmentReassembler;

  #dc: DataChannel | null = null;
  #nextFragmentMessageId = 1;
  #open = false;
  #settled = false;
  #remoteDescriptionSet = false;
  #pendingCandidates: Array<{ candidate: string; mid: string }> = [];
  #pendingCandidateBytes = 0;
  #timeout: NodeJS.Timeout | null = null;
  #drainHandler: (() => void) | null = null;

  constructor(options: P2PPeerOptions) {
    this.#options = options;
    this.#logger = options.logger;
    this.#reassembler = new FragmentReassembler({ logger: options.logger });
    this.#pc = new nodeDataChannel.PeerConnection(options.label, {
      ...options.rtcConfig,
      iceServers: [...options.rtcConfig.iceServers],
    });
    this.#wirePeerConnection();
    this.#timeout = setTimeout(() => {
      this.#fail("ICE negotiation timed out");
    }, ICE_TIMEOUT_MS);
  }

  get isOpen(): boolean {
    return this.#open && this.#dc !== null && this.#dc.isOpen();
  }

  get bufferedAmount(): number {
    try {
      return this.#dc?.bufferedAmount() ?? 0;
    } catch {
      return 0;
    }
  }

  /** Host side: create the DataChannel (this triggers offer creation). */
  startOffer(): void {
    if (this.#options.role !== "host" || this.#dc !== null || this.#settled) return;
    try {
      // The native binding requires an object when the second argument is
      // present. Omit it entirely for the v1 reliable/ordered channel.
      const dc =
        this.#options.dataChannelConfig === undefined
          ? this.#pc.createDataChannel("tokimeki")
          : this.#pc.createDataChannel("tokimeki", this.#options.dataChannelConfig);
      this.#attachDataChannel(dc);
    } catch (error) {
      this.#fail(`failed to create data channel: ${String(error)}`);
    }
  }

  /**
   * Apply one relayed `signal` message. `offer` is only valid for viewers,
   * `answer` only for the host; anything unexpected is ignored.
   */
  handleSignal(signal: P2PSignalPayload): void {
    if (this.#settled) return;
    const payload = asRecord(signal.payload);
    if (payload === null) {
      this.#logger.debug(`ignoring malformed ${signal.kind} signal for ${this.#options.label}`);
      return;
    }
    switch (signal.kind) {
      case "offer": {
        if (this.#options.role !== "viewer") return;
        const sdp = readBoundedString(payload, "sdp", MAX_SIGNAL_SDP_BYTES);
        if (sdp === null) return;
        try {
          this.#pc.setRemoteDescription(sdp, "offer");
          this.#remoteDescriptionSet = true;
          this.#flushCandidates();
        } catch (error) {
          this.#fail(`failed to apply offer: ${String(error)}`);
        }
        return;
      }
      case "answer": {
        if (this.#options.role !== "host") return;
        const sdp = readBoundedString(payload, "sdp", MAX_SIGNAL_SDP_BYTES);
        if (sdp === null || this.#remoteDescriptionSet) return;
        try {
          this.#pc.setRemoteDescription(sdp, "answer");
          this.#remoteDescriptionSet = true;
          this.#flushCandidates();
        } catch (error) {
          this.#fail(`failed to apply answer: ${String(error)}`);
        }
        return;
      }
      case "ice": {
        const candidate = readBoundedString(payload, "candidate", MAX_SIGNAL_CANDIDATE_BYTES);
        const mid = readBoundedMid(payload);
        if (candidate === null) return;
        this.#addRemoteCandidate(candidate, mid);
        return;
      }
      default:
        return;
    }
  }

  /** Send one encoded terminal frame. Returns false when it was not queued. */
  send(bytes: Uint8Array): boolean {
    const dc = this.#dc;
    if (dc === null || !this.#open) return false;
    try {
      return dc.sendMessageBinary(Buffer.from(bytes));
    } catch (error) {
      this.#logger.debug(`p2p send failed for ${this.#options.label}: ${String(error)}`);
      return false;
    }
  }

  /**
   * Send a complete frame, splitting it into v1.1 `FRAGMENT` messages when it
   * exceeds the DataChannel message budget. Returns false when the frame was
   * not fully queued; the caller must fall back to the relay path.
   */
  sendFragmentableFrame(bytes: Uint8Array): boolean {
    if (!this.isOpen) return false;
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_FRAME_BYTES) return false;
    if (this.bufferedAmount + bytes.byteLength > P2P_SEND_CAP) return false;

    const messageId = this.#nextFragmentMessageId;
    this.#nextFragmentMessageId = messageId >= 0xffff_ffff ? 1 : messageId + 1;
    if (sendFragments((fragment) => this.send(fragment), bytes, messageId)) {
      return true;
    }
    this.#logger.debug(`p2p fragment send failed for ${this.#options.label}`);
    return false;
  }

  /** Register a callback for "buffer drained below the low-water mark". */
  onDrain(handler: () => void): void {
    this.#drainHandler = handler;
    try {
      this.#dc?.setBufferedAmountLowThreshold(DRAIN_THRESHOLD_BYTES);
    } catch {
      // best effort
    }
  }

  /** Close locally; suppresses `onClosed`. */
  close(reason: string): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#open = false;
    this.#clearTimer();
    this.#reassembler.dispose();
    try {
      this.#dc?.close();
    } catch {
      // best effort
    }
    try {
      this.#pc.close();
    } catch {
      // best effort
    }
    this.#logger.debug(`p2p peer ${this.#options.label} closed: ${reason}`);
  }

  #wirePeerConnection(): void {
    const pc = this.#pc;
    pc.onLocalDescription((sdp, type) => {
      if (this.#settled) return;
      if (type !== "offer" && type !== "answer") return;
      if (type === "offer" && this.#options.offerMetadata !== undefined) {
        // Metadata must never spoof the SDP fields; spread it first.
        this.#options.sendSignal(type, { ...this.#options.offerMetadata, sdp, type });
        return;
      }
      this.#options.sendSignal(type, { sdp, type });
    });
    pc.onLocalCandidate((candidate, mid) => {
      if (this.#settled || candidate.length === 0) return;
      this.#options.sendSignal("ice", { candidate, mid });
    });
    pc.onStateChange((state) => {
      if (state === "failed") {
        this.#fail("peer connection failed");
      } else if (state === "closed") {
        this.#remoteClosed("peer connection closed");
      }
    });
    pc.onIceStateChange((state) => {
      if (state === "failed") {
        this.#fail("ICE connection failed");
      }
    });
    pc.onDataChannel((dc) => {
      if (this.#options.role !== "viewer" || this.#dc !== null || this.#settled) {
        // The host never accepts an incoming channel: it owns the offer.
        if (this.#options.role === "host") {
          try {
            dc.close();
          } catch {
            // best effort
          }
        }
        return;
      }
      this.#attachDataChannel(dc);
    });
  }

  #attachDataChannel(dc: DataChannel): void {
    this.#dc = dc;
    dc.onOpen(() => {
      if (this.#settled) return;
      this.#open = true;
      this.#clearTimer();
      this.#resolveMode(0);
    });
    dc.onMessage((message) => {
      if (this.#settled) return;
      const bytes = toBytes(message);
      if (bytes === null) {
        this.#logger.debug(`ignoring non-binary message on ${this.#options.label}`);
        return;
      }
      if (bytes[0] === FRAME_TYPES.FRAGMENT) {
        const complete = this.#reassembler.accept(bytes);
        if (complete !== null) {
          this.#options.onFrame(complete);
        }
        return;
      }
      this.#options.onFrame(bytes);
    });
    dc.onError((error) => {
      this.#fail(`data channel error: ${error}`);
    });
    dc.onClosed(() => {
      this.#remoteClosed("data channel closed");
    });
    dc.onBufferedAmountLow(() => {
      this.#drainHandler?.();
    });
    try {
      dc.setBufferedAmountLowThreshold(DRAIN_THRESHOLD_BYTES);
    } catch {
      // best effort
    }
  }

  #resolveMode(attempt: number): void {
    if (this.#settled) return;
    let info: P2POpenInfo | null = null;
    try {
      info = describePair(this.#pc.getSelectedCandidatePair());
    } catch {
      info = null;
    }
    if (info !== null) {
      this.#options.onOpen(info);
      return;
    }
    if (attempt + 1 >= MODE_LOOKUP_ATTEMPTS) {
      this.#options.onOpen({ mode: "p2p-direct", detail: "unknown", lan: false });
      return;
    }
    setTimeout(() => this.#resolveMode(attempt + 1), MODE_LOOKUP_DELAY_MS);
  }

  #addRemoteCandidate(candidate: string, mid: string): void {
    if (!this.#remoteDescriptionSet) {
      const bytes = candidateBudgetBytes(candidate, mid);
      if (
        canQueueCandidate(
          this.#pendingCandidates.length,
          this.#pendingCandidateBytes,
          bytes,
          MAX_PENDING_CANDIDATES,
        )
      ) {
        this.#pendingCandidates.push({ candidate, mid });
        this.#pendingCandidateBytes += bytes;
      } else {
        this.#logger.debug("dropped remote ICE candidate: pending queue budget exhausted");
      }
      return;
    }
    try {
      this.#pc.addRemoteCandidate(candidate, mid);
    } catch (error) {
      // Candidates can race a failed/closed connection; keep the failure path
      // authoritative instead of treating this as fatal on its own.
      this.#logger.debug(`failed to add remote candidate: ${String(error)}`);
    }
  }

  #flushCandidates(): void {
    const pending = this.#pendingCandidates;
    this.#pendingCandidates = [];
    this.#pendingCandidateBytes = 0;
    for (const { candidate, mid } of pending) {
      this.#addRemoteCandidate(candidate, mid);
    }
  }

  #fail(reason: string): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#open = false;
    this.#clearTimer();
    this.#reassembler.dispose();
    try {
      this.#dc?.close();
    } catch {
      // best effort
    }
    try {
      this.#pc.close();
    } catch {
      // best effort
    }
    this.#logger.warn(`p2p ${this.#options.label} failed: ${reason}`);
    this.#options.onFailed(reason);
  }

  #remoteClosed(reason: string): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#open = false;
    this.#clearTimer();
    this.#reassembler.dispose();
    try {
      this.#pc.close();
    } catch {
      // best effort
    }
    this.#options.onClosed(reason);
  }

  #clearTimer(): void {
    if (this.#timeout !== null) {
      clearTimeout(this.#timeout);
      this.#timeout = null;
    }
  }
}
