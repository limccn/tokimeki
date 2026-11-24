/**
 * ACP catalog for the static onboarding page.
 *
 * Mirrors the CLI built-in catalog and TokiAPI's `ACP_COMMANDS` (9 entries).
 * Keep the three lists in sync; `custom` is handled by `tokimeki run -- <cmd>`.
 */

export interface AcpEntry {
  readonly id: string;
  readonly label: string;
  readonly command: string;
}

export const ACP_CATALOG: readonly AcpEntry[] = [
  { id: "claude", label: "Claude Code", command: "claude" },
  { id: "pi", label: "pi", command: "pi" },
  { id: "codex", label: "Codex CLI", command: "codex" },
  { id: "gemini", label: "Gemini CLI", command: "gemini" },
  { id: "cursor", label: "Cursor CLI", command: "cursor" },
  { id: "aider", label: "Aider", command: "aider" },
  { id: "opencode", label: "OpenCode", command: "opencode" },
  { id: "goose", label: "Goose", command: "goose" },
  { id: "amp", label: "Amp", command: "amp" },
];

export function findAcp(id: string): AcpEntry | undefined {
  return ACP_CATALOG.find((entry) => entry.id === id);
}
