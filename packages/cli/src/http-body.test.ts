import { describe, expect, it } from "vitest";

import { readBodyCapped, readJsonObjectCapped } from "./http-body.js";

describe("capped HTTP body readers", () => {
  it("reads a small response", async () => {
    await expect(readBodyCapped(new Response("hello"), 10)).resolves.toBe("hello");
  });

  it("rejects an oversized streamed body", async () => {
    await expect(readBodyCapped(new Response("x".repeat(100)), 10)).rejects.toThrow(/too large/);
  });

  it("parses object JSON and ignores arrays/invalid JSON", async () => {
    await expect(readJsonObjectCapped(new Response('{"ok":true}'))).resolves.toEqual({
      ok: true,
    });
    await expect(readJsonObjectCapped(new Response("[1,2]"))).resolves.toBeNull();
    await expect(readJsonObjectCapped(new Response("not-json"))).resolves.toBeNull();
  });
});
