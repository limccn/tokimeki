import { relayWorkersConfig } from "./vitest.shared.js";

/**
 * Session TTL/hard-quota tests.
 *
 * These tests surgically edit live DO storage and intentionally delete whole
 * sessions. On Windows the `isolatedStorage` stack copies intermittently fail
 * with EBUSY / unexpected `-wal`/`-journal` files when that happens alongside
 * many other DO-heavy files, so this suite runs in its own process without
 * per-test storage isolation. Every test uses a unique session id.
 */
export default relayWorkersConfig({
  include: ["test/quotas-ttl.test.ts"],
  isolatedStorage: false,
});
