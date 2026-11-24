/**
 * Daemon-mode event stream (`tokimeki-event: ` + one-line JSON, stderr only).
 *
 * stdout stays reserved for terminal bytes (attach), the doctor report, or
 * host-local output; events never contaminate it. Events use a dedicated
 * writer: log levels, `Logger.setMuted`, or a viewport sink cannot swallow
 * them. JSON is emitted from stringified fields, so CR/LF/control characters
 * are always escaped and cannot forge a second event line.
 */

import { formatError } from "./logger.js";

export const CLI_EVENT_PREFIX = "tokimeki-event: ";
export const CLI_EVENT_VERSION = 1;

export type CliEventErrorCode =
  | "config_invalid"
  | "unauthorized"
  | "session_not_found"
  | "host_offline"
  | "passcode_required"
  | "rate_limited"
  | "network"
  | "unavailable"
  | "unknown";

export type CliEventConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

export type CliEventTransport = "relay" | "p2p" | "turn" | "tunnel";

export interface ReadyEventInput {
  readonly command: "host" | "attach";
  readonly role: "host" | "viewer" | "listener";
  readonly relay: string;
  readonly namespace?: string;
  readonly session: string;
  readonly listener?: boolean;
  readonly transport?: CliEventTransport;
  readonly pid?: number;
}

export interface StatusEventInput {
  readonly connection: {
    readonly state: CliEventConnectionState;
    readonly transport?: CliEventTransport;
  };
  readonly configured?: boolean;
  readonly relay?: string;
  readonly namespace?: string;
  readonly session?: string;
}

export interface ErrorEventInput {
  readonly code: CliEventErrorCode;
  readonly message: string;
  readonly retryable?: boolean;
  readonly exitCode?: number;
}

export interface ReportCheck {
  readonly name: string;
  readonly status: "ok" | "warn" | "fail";
  readonly message?: string;
}

export interface ReportEventInput {
  readonly ok: boolean;
  readonly checks: readonly ReportCheck[];
}

export interface CliEventWriter {
  readonly enabled: boolean;
  ready(event: ReadyEventInput): void;
  status(event: StatusEventInput): void;
  error(event: ErrorEventInput): void;
  report(event: ReportEventInput): void;
}

export interface CliEventWriterOptions {
  readonly enabled: boolean;
  readonly write?: (line: string) => void;
  readonly redact?: (text: string) => string;
  readonly now?: () => Date;
}

function mapStrings(value: unknown, transform: (text: string) => string): unknown {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, transform));
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = mapStrings(entry, transform);
    }
    return output;
  }
  return value;
}

export function createCliEventWriter(options: CliEventWriterOptions): CliEventWriter {
  const write =
    options.write ??
    ((line: string): void => {
      try {
        process.stderr.write(`${line}\n`);
      } catch {
        // stderr may be closed
      }
    });
  const redact = options.redact ?? ((text: string) => text);
  const now = options.now ?? (() => new Date());

  const emit = (type: string, fields: Record<string, unknown>): void => {
    if (!options.enabled) return;
    const redacted = mapStrings(fields, redact) as Record<string, unknown>;
    const event = {
      v: CLI_EVENT_VERSION,
      type,
      at: now().toISOString(),
      ...redacted,
    };
    let line: string;
    try {
      line = JSON.stringify(event);
    } catch {
      // Defensive: an event must never crash a live session.
      line = JSON.stringify({
        v: CLI_EVENT_VERSION,
        type: "error",
        at: now().toISOString(),
        code: "unknown",
        message: "event serialization failed",
      });
    }
    write(`${CLI_EVENT_PREFIX}${line}`);
  };

  return {
    enabled: options.enabled,
    ready(event) {
      emit("ready", { ...event });
    },
    status(event) {
      emit("status", { ...event });
    },
    error(event) {
      emit("error", {
        code: event.code,
        message: redact(event.message),
        ...(event.retryable === undefined ? {} : { retryable: event.retryable }),
        ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
      });
    },
    report(event) {
      emit("report", { ...event });
    },
  };
}

export function errorMessage(error: unknown): string {
  return formatError(error);
}

/** Map relay/protocol error codes to the stable daemon event codes. */
export function mapRelayErrorCode(code: string): CliEventErrorCode {
  switch (code) {
    case "unauthorized":
      return "unauthorized";
    case "invalid_session":
    case "session_not_found":
      return "session_not_found";
    case "host_offline":
      return "host_offline";
    case "passcode_required":
    case "passcode_invalid":
    case "passcode_locked":
    case "passcode_mismatch":
      return "passcode_required";
    case "rate_limited":
    case "session_full":
      return "rate_limited";
    case "network":
    case "network_error":
      return "network";
    case "unavailable":
    case "jwks_unavailable":
    case "not_implemented":
      return "unavailable";
    default:
      return "unknown";
  }
}

/** Map the viewport's transport label to the daemon event vocabulary. */
export function eventTransport(value: string): CliEventTransport | undefined {
  switch (value) {
    case "relay":
      return "relay";
    case "p2p":
    case "p2p-direct":
      return "p2p";
    case "p2p-turn":
      return "turn";
    case "tunnel":
      return "tunnel";
    default:
      return undefined;
  }
}

/** Map the viewport relay state to the daemon event vocabulary. */
export function eventConnectionState(value: string): CliEventConnectionState {
  switch (value) {
    case "ready":
      return "connected";
    case "reconnecting":
      return "reconnecting";
    case "failed":
    case "closed":
      return "disconnected";
    default:
      return "connecting";
  }
}
