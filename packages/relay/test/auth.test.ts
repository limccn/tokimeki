import { describe, expect, it } from "vitest";

import { isMasterTokenValid } from "../src/auth.js";

describe("isMasterTokenValid", () => {
  it("rejects a missing or empty presented token", async () => {
    expect(await isMasterTokenValid(null, "master-secret")).toBe(false);
    expect(await isMasterTokenValid("", "master-secret")).toBe(false);
  });

  it("fails closed when no master token is configured", async () => {
    expect(await isMasterTokenValid("master-secret", undefined)).toBe(false);
    expect(await isMasterTokenValid("master-secret", "")).toBe(false);
  });

  it("rejects a wrong token and accepts the exact token", async () => {
    expect(await isMasterTokenValid("master-secret", "other-secret")).toBe(false);
    expect(await isMasterTokenValid("master-secret", "master-secret")).toBe(true);
  });
});
