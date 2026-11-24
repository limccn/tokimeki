/**
 * Shell command generation for the no-JWT onboarding page.
 *
 * Only conservative single-line values are accepted; the validation layer
 * rejects quotes, percent signs, control characters, and other shell
 * metacharacters before a value reaches these templates.
 */

import { findAcp } from "./acp.js";
import { SiteError, validateCustomCommand } from "./validate.js";

export type Shell = "bash" | "zsh" | "sh" | "fish" | "pwsh" | "powershell" | "cmd";

export const SHELLS: readonly Shell[] = ["bash", "zsh", "sh", "fish", "pwsh", "powershell", "cmd"];

export interface HostCommandInput {
  readonly relayUrl: string;
  readonly token: string;
  readonly namespace: string;
  readonly session: string;
  readonly sessionToken: string;
  readonly acpId: string;
  readonly customCommand?: string;
  readonly shell: Shell;
  readonly windowSize?: string;
}

export interface AttachCommandInput {
  readonly relayUrl: string;
  readonly session: string;
  readonly sessionToken: string;
  readonly shell: Shell;
  readonly listener: boolean;
}

export function shellEnvLine(shell: Shell, key: string, value: string): string {
  switch (shell) {
    case "fish":
      return `set -gx ${key} '${value}'`;
    case "pwsh":
    case "powershell":
      return `$env:${key} = '${value}'`;
    case "cmd":
      return `set "${key}=${value}"`;
    default:
      return `export ${key}='${value}'`;
  }
}

export function acpInvocation(acpId: string, customCommand?: string): string {
  if (acpId === "custom") {
    const command = (customCommand ?? "").trim();
    validateCustomCommand(command);
    return `tokimeki run -- ${command}`;
  }
  const entry = findAcp(acpId);
  if (entry === undefined) {
    throw new SiteError("Unknown ACP application");
  }
  if (entry.command === "claude" || entry.command === "pi") {
    return `tokimeki ${entry.command}`;
  }
  return `tokimeki run -- ${entry.command}`;
}

function hostLines(input: HostCommandInput): Array<[string, string]> {
  const entries: Array<[string, string]> = [
    ["TOKIMEKI_RELAY_URL", input.relayUrl],
    ["TOKIMEKI_TOKEN", input.token],
    ["TOKIMEKI_NAMESPACE", input.namespace],
    ["TOKIMEKI_SESSION", input.session],
    ["TOKIMEKI_SESSION_TOKEN", input.sessionToken],
  ];
  if (input.windowSize !== undefined && input.windowSize.length > 0) {
    entries.push(["TOKIMEKI_WINDOW", "on"]);
    entries.push(["TOKIMEKI_WINDOW_SIZE", input.windowSize]);
  }
  return entries;
}

export function generateHostCommand(input: HostCommandInput): string {
  const lines = hostLines(input).map(([key, value]) => shellEnvLine(input.shell, key, value));
  lines.push(acpInvocation(input.acpId, input.customCommand));
  return lines.join("\n");
}

export function generateAttachCommand(input: AttachCommandInput): string {
  const lines = [
    shellEnvLine(input.shell, "TOKIMEKI_RELAY_URL", input.relayUrl),
    shellEnvLine(input.shell, "TOKIMEKI_SESSION", input.session),
    shellEnvLine(input.shell, "TOKIMEKI_SESSION_TOKEN", input.sessionToken),
    input.listener ? "tokimeki attach --listen" : "tokimeki attach",
  ];
  return lines.join("\n");
}
