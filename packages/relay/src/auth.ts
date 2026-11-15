import { constantTimeEqual } from "./crypto-utils.js";

/**
 * Constant-time host master-token check.
 *
 * A blank or absent expected token means host authentication is disabled:
 * every presented master token is rejected. The Worker therefore never treats
 * an unset `TOKIMEKI_MASTER_TOKEN` as "allow all hosts".
 */
export async function isMasterTokenValid(
  provided: string | null,
  expected: string | undefined,
): Promise<boolean> {
  if (provided === null || provided.length === 0) {
    return false;
  }
  if (expected === undefined || expected.length === 0) {
    return false;
  }
  return constantTimeEqual(provided, expected);
}
