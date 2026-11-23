import { describe, expect, it } from "vitest";

import { isInviteCode, parseAttachUrl } from "./attach-url.js";

describe("attach share-url parsing", () => {
  it("accepts https URLs with a #t- code fragment", () => {
    expect(parseAttachUrl("https://tokiapi.app/#t-abcDEF123_-.")).toEqual({
      origin: "https://tokiapi.app",
      code: "abcDEF123_-.",
    });
  });

  it("accepts loopback http for local testing", () => {
    expect(parseAttachUrl("http://127.0.0.1:8787/#t-code")).toEqual({
      origin: "http://127.0.0.1:8787",
      code: "code",
    });
  });

  it("rejects non-https hosts, credentials, and missing/oversized codes", () => {
    expect(() => parseAttachUrl("http://example.com/#t-code")).toThrow(/https/);
    expect(() => parseAttachUrl("https://user:pass@tokiapi.app/#t-code")).toThrow(/credentials/);
    expect(() => parseAttachUrl("https://tokiapi.app/")).toThrow(/fragment/);
    expect(() => parseAttachUrl("https://tokiapi.app/#x-code")).toThrow(/fragment/);
    expect(() => parseAttachUrl(`https://tokiapi.app/#t-${"a".repeat(65)}`)).toThrow(/invalid/);
    expect(() => parseAttachUrl("https://tokiapi.app/#t-a b")).toThrow(/invalid/);
  });

  it("does not echo the code in the error message", () => {
    try {
      parseAttachUrl(`https://tokiapi.app/#t-${"bad code"}`);
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain("bad code");
    }
  });

  it("recognizes bare invite codes for the wizard", () => {
    expect(isInviteCode("abcDEF123")).toBe(true);
    expect(isInviteCode("a b")).toBe(false);
    expect(isInviteCode("")).toBe(false);
  });
});
