/**
 * v1 config/viewer JSON builders.
 *
 * Deliberately no passcode, JWT, invite, or expiresAt fields: this page is for
 * no-JWT multi-namespace relays with operator-issued static tokens.
 */

export interface HostConfigInput {
  readonly relayUrl: string;
  readonly token: string;
  readonly namespace: string;
  readonly session: string;
  readonly sessionToken: string;
  readonly windowSize?: string;
}

export interface ViewerConfigInput {
  readonly relayUrl: string;
  readonly session: string;
  readonly sessionToken: string;
  readonly windowSize?: string;
}

export interface WindowSize {
  readonly cols: number;
  readonly rows: number;
}

export function parseWindowSize(value: string | undefined): WindowSize | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (match === null) return undefined;
  const cols = Number.parseInt(match[1] ?? "", 10);
  const rows = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 1 || rows < 1) {
    return undefined;
  }
  return { cols, rows };
}

export function buildHostConfigEnvelope(input: HostConfigInput): string {
  const window = parseWindowSize(input.windowSize);
  return `${JSON.stringify(
    {
      v: 1,
      relayUrl: input.relayUrl,
      token: input.token,
      namespace: input.namespace,
      session: input.session,
      sessionToken: input.sessionToken,
      ...(window === undefined ? {} : { windowSize: input.windowSize }),
    },
    null,
    2,
  )}\n`;
}

export function buildViewerConfigJson(input: ViewerConfigInput): string {
  const window = parseWindowSize(input.windowSize);
  return `${JSON.stringify(
    {
      version: 1,
      relayUrl: input.relayUrl,
      session: input.session,
      sessionToken: input.sessionToken,
      ...(window === undefined ? {} : { window }),
    },
    null,
    2,
  )}\n`;
}
