/**
 * Terminal sequences used by the attach client.
 *
 * Attach stdout only ever carries remote TUI bytes; these constants are the
 * few local-mode sequences the client is allowed to emit around them.
 */

/** Enter the alternate screen and hide the cursor. */
export const ENTER_ALTERNATE_SCREEN = "\x1b[?1049h\x1b[?25l";

/** Clear the remote screen before writing a snapshot. */
export const CLEAR_SCREEN = "\x1b[2J\x1b[H";

/**
 * Full local-terminal reset.
 *
 * Leaves the alternate screen, restores the cursor and SGR state, disables
 * mouse tracking (including SGR encoding), bracketed paste, focus reporting,
 * synchronized output, and pops Kitty keyboard flags.
 */
export function terminalRestoreSequence(): string {
  return (
    "\x1b[?1049l" +
    "\x1b[?25h" +
    "\x1b[0m" +
    "\x1b[?1000l" +
    "\x1b[?1002l" +
    "\x1b[?1003l" +
    "\x1b[?1006l" +
    "\x1b[?2004l" +
    "\x1b[?1004l" +
    "\x1b[?2026l" +
    "\x1b[<u"
  );
}
