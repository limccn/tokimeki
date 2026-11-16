import { readFileSync } from "node:fs";

import type { ClientDescriptor } from "@limccn/tokimeki-protocol";

import type { HostConfig } from "./config.js";
import { type ActiveInviteKey, inviteKeyLabel } from "./invite.js";

let cachedVersion: string | null = null;

/** Read the CLI package version; safe for `--version` and hello tests. */
export function readCliVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    cachedVersion = typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

export interface ClientDescriptorOptions {
  readonly kind?: string;
  readonly platform?: NodeJS.Platform;
  readonly version?: string;
}

/** Build the User-Agent-like identity advertised in `hello.client`. */
export function buildClientDescriptor(options: ClientDescriptorOptions = {}): ClientDescriptor {
  return {
    name: "tokimeki-cli",
    version: options.version ?? readCliVersion(),
    kind: options.kind ?? "cli",
    platform: options.platform ?? process.platform,
    runtime: `node/${process.versions.node}`,
  };
}

/** JSON envelope a host gives to a viewer (never includes the master token). */
export interface ViewerConfig {
  readonly version: 1;
  readonly relayUrl: string;
  readonly session: string;
  readonly sessionToken: string;
  readonly window: { readonly cols: number; readonly rows: number };
}

export type ViewerConfigSource = Pick<
  HostConfig,
  "relayUrl" | "session" | "sessionToken" | "windowSize" | "ptySize"
>;

export function buildViewerConfig(config: ViewerConfigSource): ViewerConfig {
  const window = config.ptySize ?? config.windowSize;
  return {
    version: 1,
    relayUrl: config.relayUrl,
    session: config.session,
    sessionToken: config.sessionToken,
    window: { cols: window.cols, rows: window.rows },
  };
}

export function formatViewerConfigJson(config: ViewerConfigSource): string {
  return JSON.stringify(buildViewerConfig(config));
}

/** Lines shown in the host's local F12 invite overlay. */
export function buildInviteOverlayLines(
  config: ViewerConfigSource,
  key: ActiveInviteKey,
): string[] {
  const viewer = buildViewerConfig(config);
  return [
    `session: ${viewer.session}`,
    `relay: ${viewer.relayUrl}`,
    `window: ${viewer.window.cols}x${viewer.window.rows}`,
    `token: ${viewer.sessionToken}`,
    "",
    "viewer config (secret):",
    JSON.stringify(viewer),
    "",
    `c: copy exact JSON    ${inviteKeyLabel(key)}/Esc: close`,
  ];
}
