/**
 * Structured-ish stderr logger for the tokimeki CLI.
 *
 * Rules that the rest of the CLI relies on:
 * - Everything is written to stderr; stdout is reserved for terminal bytes.
 * - Known secret values are redacted from every line.
 * - While an attach session owns the local screen, output can be muted so log
 *   lines never corrupt raw terminal byte streams.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Strip terminal-control characters from text that may come from a remote
 * peer or provider. Keeps tabs/newlines as spaces so log records cannot forge
 * a second line or emit ANSI/OSC/C1/bidi control sequences.
 */
export function sanitizeLogText(text: string): string {
  let result = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      result += " ";
      continue;
    }
    if (
      code < 0x20 ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0x061c ||
      code === 0x200e ||
      code === 0x200f
    ) {
      continue;
    }
    result += char;
  }
  return result;
}

/**
 * Build a function that replaces every occurrence of a secret with a marker.
 *
 * Longest secrets are replaced first so that a secret containing another
 * secret cannot leave a partial value behind.
 */
export function createRedactor(secrets: readonly (string | undefined)[]): (text: string) => string {
  const values = [...new Set(secrets.filter((value): value is string => Boolean(value)))]
    .filter((value) => value.length >= 4)
    .sort((a, b) => b.length - a.length);
  if (values.length === 0) {
    return (text) => text;
  }
  return (text) => {
    let result = text;
    for (const value of values) {
      result = result.split(value).join("[redacted]");
    }
    return result;
  };
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly write?: (line: string) => void;
  readonly redact?: (text: string) => string;
}

export class Logger {
  readonly #level: LogLevel;
  readonly #defaultWrite: (line: string) => void;
  readonly #redact: (text: string) => string;
  #write: (line: string) => void;
  #muted = false;

  constructor(options: LoggerOptions) {
    this.#level = options.level;
    this.#defaultWrite = options.write ?? ((line) => void process.stderr.write(`${line}\n`));
    this.#write = this.#defaultWrite;
    this.#redact = options.redact ?? ((text) => text);
  }

  get level(): LogLevel {
    return this.#level;
  }

  /**
   * Redirect redacted log lines to a local sink (viewport log panel).
   * Passing null restores the constructor write target.
   */
  setSink(sink: ((line: string) => void) | null): void {
    this.#write = sink ?? this.#defaultWrite;
  }

  /** Suppress all output (used while an attach session is drawing). */
  setMuted(muted: boolean): void {
    this.#muted = muted;
  }

  debug(message: string): void {
    this.#log("debug", message);
  }

  info(message: string): void {
    this.#log("info", message);
  }

  warn(message: string): void {
    this.#log("warn", message);
  }

  error(message: string): void {
    this.#log("error", message);
  }

  /** Write a line without the level prefix and without muting (session info). */
  raw(message: string): void {
    this.#write(sanitizeLogText(this.#redact(message)));
  }

  #log(level: Exclude<LogLevel, "silent">, message: string): void {
    if (this.#muted) return;
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#level]) return;
    this.#write(sanitizeLogText(this.#redact(`[tokimeki] ${level}: ${message}`)));
  }
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
