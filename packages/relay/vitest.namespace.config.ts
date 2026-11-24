import { relayWorkersConfig } from "./vitest.shared.js";

/**
 * Static namespace-token suite (no JWT bindings).
 *
 * Runs with `TOKIMEKI_NAMESPACE_TOKENS` bound, which disables the fallback
 * master token: only namespace tokens (and, with JWT configured, Host JWTs)
 * can authenticate hosts here.
 */
export default relayWorkersConfig({
  include: ["test/worker-namespace.test.ts", "test/session-namespace.test.ts"],
  namespaceTokens: true,
  // See vitest.shared.ts for the Windows alarm rationale.
  sessionMaxTtlSeconds: "0",
});
