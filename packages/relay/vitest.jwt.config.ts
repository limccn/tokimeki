import { relayWorkersConfig } from "./vitest.shared.js";

/**
 * Host JWT suite: namespace tokens plus JWT verification bindings.
 *
 * The JWKS endpoint is mocked per test with `fetchMock` from `cloudflare:test`,
 * so no outbound network access happens. Fallback-token rejection is asserted
 * here too because namespace mode is active in this configuration.
 */
export default relayWorkersConfig({
  include: ["test/worker-jwt.test.ts", "test/worker-session-jwt.test.ts"],
  namespaceTokens: true,
  jwtBindings: true,
  // See vitest.shared.ts for the Windows alarm rationale.
  sessionMaxTtlSeconds: "0",
});
