/**
 * Built-in ACP application catalog (v1.4-I).
 *
 * Source of truth in this repository. Keep in sync with TokiAPI's
 * `app/modules/tokimeki/lib/host-command.ts` ACP_COMMANDS (9 entries plus
 * `custom` handled by `tokimeki run -- <cmd>`). This catalog only drives
 * explicit `tokimeki <acp>` dispatch and `acp list`; it never executes a
 * detected binary.
 */

export interface AcpEntry {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  /** Extra executable names used by read-only PATH detection only. */
  readonly aliases?: readonly string[];
}

export const ACP_CATALOG: readonly AcpEntry[] = [
  { id: "claude", label: "Claude Code", command: "claude" },
  { id: "pi", label: "pi", command: "pi" },
  { id: "codex", label: "Codex CLI", command: "codex" },
  { id: "gemini", label: "Gemini CLI", command: "gemini" },
  { id: "cursor", label: "Cursor CLI", command: "cursor", aliases: ["cursor-agent"] },
  { id: "aider", label: "Aider", command: "aider" },
  { id: "opencode", label: "OpenCode", command: "opencode" },
  { id: "goose", label: "Goose", command: "goose" },
  { id: "amp", label: "Amp", command: "amp" },
];

/** Commands that opt into the fixed TUI window by default. */
export const ACP_COMMANDS: readonly string[] = ACP_CATALOG.map((entry) => entry.command);

export function findAcp(idOrCommand: string): AcpEntry | undefined {
  const normalized = idOrCommand.toLowerCase();
  return ACP_CATALOG.find(
    (entry) =>
      entry.id === normalized ||
      entry.command === normalized ||
      (entry.aliases ?? []).some((alias) => alias.toLowerCase() === normalized),
  );
}
