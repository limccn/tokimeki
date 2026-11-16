/**
 * TUN profile endpoint: AEAD records + selective-repeat ARQ over one P2P
 * DataChannel.
 *
 * Only terminal frames are carried. Control messages, snapshots, resize,
 * signaling, and relay ACK flow-control stay on their existing v1 paths.
 * The relay never forwards `TUNNEL` frames, so this endpoint is P2P-only.
 */

import {
  encodeFrame,
  TUNNEL_INPUT_PAYLOAD_MAX_BYTES,
  TUNNEL_MAX_FRAME_BYTES,
  type TunnelKeyMode,
  type TunnelRecordType,
} from "@limccn/tokimeki-protocol";

import type { Logger } from "../../logger.js";
import {
  type ArqFailureReason,
  type ArqTimers,
  SelectiveRepeatReceiver,
  SelectiveRepeatSender,
} from "./arq.js";
import { deriveTunnelKeys, TunnelCipher, TunnelCryptoError } from "./crypto.js";

/** Consecutive failed AEAD opens before the tunnel is declared unusable. */
export const TUNNEL_MAX_CONSECUTIVE_DECRYPT_FAILURES = 16;
/** Default drain low-water for the sender's unacknowledged byte queue. */
export const TUNNEL_DRAIN_LOW_WATER_BYTES = 131_072;
/**
 * Bounded application-frame queue used while the ARQ window is full.
 *
 * A single PTY chunk can exceed the 64-record window; queueing it keeps the
 * tunnel from failing on a normal burst. The PTY is paused well before this
 * limit, and crossing it fails closed to the relay path.
 */
export const TUNNEL_MAX_OUTBOUND_BYTES = 4_194_304;

export interface TunnelTransportOptions {
  readonly role: "host" | "viewer";
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly keyMode: TunnelKeyMode;
  /** Required for `shared-secret` mode. */
  readonly secret?: string | null;
  readonly logger: Logger;
  /** Send one complete `TUNNEL` frame over the DataChannel. */
  readonly sendFrame: (bytes: Uint8Array) => boolean;
  /** A complete decrypted terminal frame (INPUT/OUTPUT bytes). */
  readonly onFrame: (bytes: Uint8Array) => void;
  /** Tunnel must be torn down and the session returned to the relay path. */
  readonly onFailure: (reason: string) => void;
  /** Low-water mark for the unacknowledged send queue (default 128 KiB). */
  readonly drainLowWaterBytes?: number;
  /** Bounded queue for frames that arrive while the ARQ window is full. */
  readonly maxOutboundBytes?: number;
  readonly timers?: ArqTimers;
  readonly now?: () => number;
  readonly nonceSource?: (size: number) => Uint8Array;
  readonly maxConsecutiveDecryptFailures?: number;
}

export interface TunnelStats {
  readonly sentRecords: number;
  readonly receivedRecords: number;
  readonly retransmits: number;
  readonly decryptFailures: number;
  readonly deliveredFrames: number;
  readonly droppedReplays: number;
}

export class TunnelTransport {
  readonly #options: TunnelTransportOptions;
  readonly #cipher: TunnelCipher;
  readonly #sender: SelectiveRepeatSender;
  readonly #receiver: SelectiveRepeatReceiver;
  readonly #maxConsecutiveDecryptFailures: number;
  readonly #drainLowWaterBytes: number;
  readonly #maxOutboundBytes: number;
  readonly #outbound: Uint8Array[] = [];

  #outboundBytes = 0;
  #drainHandler: (() => void) | null = null;

  #controlSeq = 0;
  #sentRecords = 0;
  #receivedRecords = 0;
  #retransmits = 0;
  #decryptFailures = 0;
  #consecutiveDecryptFailures = 0;
  #deliveredFrames = 0;
  #droppedReplays = 0;
  #failed = false;
  #disposed = false;
  #failureReason: string | null = null;

  constructor(options: TunnelTransportOptions) {
    this.#options = options;
    this.#maxConsecutiveDecryptFailures =
      options.maxConsecutiveDecryptFailures ?? TUNNEL_MAX_CONSECUTIVE_DECRYPT_FAILURES;
    this.#drainLowWaterBytes = options.drainLowWaterBytes ?? TUNNEL_DRAIN_LOW_WATER_BYTES;
    this.#maxOutboundBytes = options.maxOutboundBytes ?? TUNNEL_MAX_OUTBOUND_BYTES;

    const keys = deriveTunnelKeys({
      keyMode: options.keyMode,
      sessionId: options.sessionId,
      sessionToken: options.sessionToken,
      secret: options.secret ?? null,
    });
    this.#cipher = new TunnelCipher({
      keys,
      sendDirection: options.role === "host" ? "hostToViewer" : "viewerToHost",
      sessionId: options.sessionId,
      nonceSource: options.nonceSource,
    });
    this.#sender = new SelectiveRepeatSender({
      sealAndSend: (record) =>
        this.#sealAndSend(record.seq, record.ackSeq, record.ackBits, record.plaintext),
      onFailure: (reason) => this.#fail(`arq:${reason}`),
      onRetransmit: (pendingCount) => {
        this.#retransmits += pendingCount;
        options.logger.debug(`tunnel retransmitted ${pendingCount} record(s)`);
      },
      onAck: () => {
        this.#drainOutbound();
        if (this.pendingBytes <= this.#drainLowWaterBytes) {
          this.#drainHandler?.();
        }
      },
      timers: options.timers,
      now: options.now,
    });
    this.#receiver = new SelectiveRepeatReceiver({
      onFailure: (reason) => this.#fail(`arq:${reason}`),
      timers: options.timers,
      now: options.now,
    });
  }

  get keyMode(): TunnelKeyMode {
    return this.#options.keyMode;
  }

  /** Unacknowledged data records plus queued application frames. */
  get pendingCount(): number {
    return this.#sender.pendingCount + this.#outbound.length;
  }

  get pendingBytes(): number {
    return this.#sender.pendingBytes + this.#outboundBytes;
  }

  get failed(): boolean {
    return this.#failed;
  }

  get failureReason(): string | null {
    return this.#failureReason;
  }

  /** Register a callback for "unacknowledged queue drained below low water". */
  onDrain(handler: () => void): void {
    this.#drainHandler = handler;
  }

  get stats(): TunnelStats {
    return {
      sentRecords: this.#sentRecords,
      receivedRecords: this.#receivedRecords,
      retransmits: this.#retransmits,
      decryptFailures: this.#decryptFailures,
      deliveredFrames: this.#deliveredFrames,
      droppedReplays: this.#droppedReplays,
    };
  }

  /** Queue one complete terminal frame for reliable delivery. */
  send(frameBytes: Uint8Array): boolean {
    if (this.#failed || this.#disposed) return false;
    if (!(frameBytes instanceof Uint8Array) || frameBytes.byteLength > TUNNEL_MAX_FRAME_BYTES) {
      this.#fail("frame_too_large");
      return false;
    }
    if (this.#sender.sendFrame(frameBytes)) return true;
    if (this.#sender.failed) {
      // The sender already reported a concrete failure.
      return false;
    }
    if (this.#sender.seqExhausted) {
      this.#fail("seq_exhausted");
      return false;
    }
    if (this.#outboundBytes + frameBytes.byteLength > this.#maxOutboundBytes) {
      this.#fail("outbound_queue_full");
      return false;
    }
    this.#outbound.push(frameBytes);
    this.#outboundBytes += frameBytes.byteLength;
    return true;
  }

  /**
   * Split raw terminal input into INPUT frames that fit one tunnel record.
   *
   * Large pastes must be split before encoding; otherwise a single frame would
   * exceed the DataChannel message budget and be rejected.
   */
  sendTerminalInput(payload: Uint8Array): boolean {
    if (this.#failed || this.#disposed) return false;
    if (payload.byteLength === 0) return true;
    const frameCount = Math.ceil(payload.byteLength / TUNNEL_INPUT_PAYLOAD_MAX_BYTES);
    // Each split INPUT frame adds one frame-type byte.
    const encodedBytes = payload.byteLength + frameCount;
    // Fail before any chunk reaches the unreliable channel when the whole
    // payload cannot fit in the bounded queue. A mid-split failure would make
    // the caller resend the entire payload over the relay and duplicate the
    // prefix that was already handed to the tunnel.
    if (this.#outboundBytes + encodedBytes > this.#maxOutboundBytes) {
      this.#fail("outbound_queue_full");
      return false;
    }
    for (let offset = 0; offset < payload.byteLength; offset += TUNNEL_INPUT_PAYLOAD_MAX_BYTES) {
      const chunk = payload.subarray(
        offset,
        Math.min(offset + TUNNEL_INPUT_PAYLOAD_MAX_BYTES, payload.byteLength),
      );
      if (!this.send(encodeFrame({ type: "input", payload: chunk }))) {
        return false;
      }
    }
    return true;
  }

  /** Accept one `TUNNEL 0x06` payload (record bytes). */
  receive(recordBytes: Uint8Array): void {
    if (this.#failed || this.#disposed) return;
    const opened = this.#cipher.open(recordBytes);
    if (opened === null) {
      this.#decryptFailures += 1;
      this.#consecutiveDecryptFailures += 1;
      if (this.#consecutiveDecryptFailures >= this.#maxConsecutiveDecryptFailures) {
        this.#fail("decrypt_failed");
      }
      return;
    }
    this.#consecutiveDecryptFailures = 0;
    this.#receivedRecords += 1;

    switch (opened.header.type) {
      case "data": {
        // Piggybacked ACK state on data records also advances the sender.
        this.#sender.receiveAck(opened.header.ackSeq, opened.header.ackBits);
        const result = this.#receiver.accept(opened.header.seq, opened.plaintext);
        if (result === null) {
          this.#droppedReplays += 1;
          return;
        }
        this.#sender.setAckState(result.ack.ackSeq, result.ack.ackBits);
        if (result.failure !== undefined) {
          this.#fail(`arq:${result.failure}`);
          return;
        }
        for (const frame of result.delivered) {
          this.#deliveredFrames += 1;
          this.#options.onFrame(frame);
        }
        if (result.shouldAck) {
          this.#sendAck(result.ack.ackSeq, result.ack.ackBits);
        }
        return;
      }
      case "ack":
        this.#sender.receiveAck(opened.header.ackSeq, opened.header.ackBits);
        return;
      case "fec":
      case "ping":
        // XOR FEC is deferred; ping has no F1 runtime behavior.
        this.#options.logger.debug(`ignoring unused tunnel record type ${opened.header.type}`);
        return;
      default:
        return;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#outbound.length = 0;
    this.#outboundBytes = 0;
    this.#sender.dispose();
    this.#receiver.dispose();
  }

  #drainOutbound(): void {
    if (this.#failed || this.#disposed) return;
    while (this.#outbound.length > 0) {
      const next = this.#outbound[0];
      if (next === undefined) return;
      if (!this.#sender.sendFrame(next)) return;
      this.#outbound.shift();
      this.#outboundBytes -= next.byteLength;
    }
  }

  #sealAndSend(seq: number, ackSeq: number, ackBits: number, plaintext: Uint8Array): boolean {
    try {
      const sealed = this.#cipher.seal({
        type: "data" satisfies TunnelRecordType,
        seq,
        ackSeq,
        ackBits,
        plaintext,
      });
      return this.#sendTunnelRecord(sealed);
    } catch (error) {
      if (error instanceof TunnelCryptoError) {
        this.#options.logger.warn(`tunnel seal failed: ${error.reason}`);
      } else {
        this.#options.logger.warn("tunnel seal failed");
      }
      return false;
    }
  }

  #sendAck(ackSeq: number, ackBits: number): void {
    if (this.#failed || this.#disposed) return;
    const seq = this.#controlSeq;
    this.#controlSeq = seq >= 0xffff_ffff ? 0 : seq + 1;
    try {
      const sealed = this.#cipher.seal({
        type: "ack",
        seq,
        ackSeq,
        ackBits,
        plaintext: new Uint8Array(0),
      });
      if (!this.#sendTunnelRecord(sealed)) {
        this.#options.logger.debug("tunnel ACK could not be queued");
      }
    } catch {
      this.#options.logger.debug("tunnel ACK seal failed");
    }
  }

  #sendTunnelRecord(record: Uint8Array): boolean {
    let frame: Uint8Array;
    try {
      frame = encodeFrame({ type: "tunnel", payload: record });
    } catch {
      return false;
    }
    if (!this.#options.sendFrame(frame)) return false;
    this.#sentRecords += 1;
    return true;
  }

  #fail(reason: string): void {
    if (this.#failed || this.#disposed) return;
    this.#failed = true;
    this.#failureReason = reason;
    this.#outbound.length = 0;
    this.#outboundBytes = 0;
    this.#sender.dispose();
    this.#receiver.dispose();
    this.#options.logger.debug(`tunnel failed: ${reason}`);
    this.#options.onFailure(reason);
  }
}

export type TunnelFailureReason =
  | ArqFailureReason
  | "decrypt_failed"
  | "frame_too_large"
  | "outbound_queue_full"
  | "seq_exhausted";
