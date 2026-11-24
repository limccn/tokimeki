import { relayWorkersConfig } from "./vitest.shared.js";

/**
 * Session passcode suite (v1.2-D).
 *
 * Kept in its own process without isolated storage: the concurrent-lockout
 * test opens several Durable Object sockets at once, and on Windows
 * isolated-storage teardown intermittently fails with EBUSY. Every test uses a
 * unique session id, so no state isolation is required.
 */
export default relayWorkersConfig({
  include: ["test/worker-passcode.test.ts"],
  isolatedStorage: false,
  sessionMaxTtlSeconds: "0",
});
