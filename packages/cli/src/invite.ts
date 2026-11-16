export const INVITE_KEYS = ["f12", "ctrl-]", "off"] as const;
export type InviteKey = (typeof INVITE_KEYS)[number];
export type ActiveInviteKey = Exclude<InviteKey, "off">;

/** Human-readable key label used in the banner/status bar. */
export function inviteKeyLabel(key: ActiveInviteKey): string {
  return key === "f12" ? "F12" : "Ctrl-]";
}
