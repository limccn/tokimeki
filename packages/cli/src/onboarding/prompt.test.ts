import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { createPrompt, UserAbortError } from "./prompt.js";

function fakeTty(): PassThrough & { isTTY: boolean; setRawMode: (value: boolean) => void } {
  const stream = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (value: boolean) => void;
  };
  stream.isTTY = true;
  stream.setRawMode = () => {};
  return stream;
}

function asReadStream(stream: PassThrough): NodeJS.ReadStream {
  return stream as unknown as NodeJS.ReadStream;
}

function asWriteStream(stream: PassThrough): NodeJS.WriteStream {
  return stream as unknown as NodeJS.WriteStream;
}

describe("prompt EOF handling", () => {
  it("rejects a text question when stdin closes", async () => {
    const stdin = new PassThrough();
    const prompt = createPrompt({
      stdin: asReadStream(stdin),
      stderr: asWriteStream(new PassThrough()),
    });
    const pending = prompt.text({ message: "question" });
    stdin.end();
    await expect(pending).rejects.toBeInstanceOf(UserAbortError);
    prompt.close();
  });

  it("rejects a secret prompt when stdin closes", async () => {
    const stdin = fakeTty();
    const prompt = createPrompt({
      stdin: asReadStream(stdin),
      stderr: asWriteStream(new PassThrough()),
    });
    const pending = prompt.secret({ message: "secret" });
    stdin.end();
    await expect(pending).rejects.toBeInstanceOf(UserAbortError);
    prompt.close();
  });
});
