/**
 * Small, testable prompt layer used by the onboarding wizards.
 *
 * Prompts write to stderr so stdout stays reserved for terminal bytes/report
 * output. Secret prompts never echo the typed value. Ctrl-C aborts the wizard
 * (and therefore the command) without leaving raw mode enabled.
 */

import { createInterface } from "node:readline";

export class UserAbortError extends Error {
  override readonly name = "UserAbortError";
}

export interface PromptIO {
  text(options: { message: string; defaultValue?: string }): Promise<string>;
  secret(options: { message: string }): Promise<string>;
  confirm(options: { message: string; defaultYes?: boolean }): Promise<boolean>;
  select(options: {
    message: string;
    choices: readonly { readonly label: string; readonly value: string }[];
    defaultIndex?: number;
  }): Promise<string>;
  print(message: string): void;
  close(): void;
}

export interface NodePromptOptions {
  readonly stdin?: NodeJS.ReadStream;
  readonly stderr?: NodeJS.WriteStream;
}

export function createPrompt(options: NodePromptOptions = {}): PromptIO {
  const stdin = options.stdin ?? process.stdin;
  const stderr = options.stderr ?? process.stderr;
  const write = (text: string): void => {
    try {
      stderr.write(text);
    } catch {
      // stderr may be closed
    }
  };

  const askLine = (message: string): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const rl = createInterface({ input: stdin, output: stderr, terminal: stdin.isTTY === true });
      let settled = false;
      const onClose = (): void => {
        if (settled) return;
        finish();
        reject(new UserAbortError("input closed"));
      };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        process.removeListener("SIGINT", onSigint);
        stdin.removeListener("end", onClose);
        rl.removeListener("close", onClose);
        try {
          rl.close();
        } catch {
          // best effort
        }
      };
      const onSigint = (): void => {
        finish();
        write("\n");
        reject(new UserAbortError("interrupted"));
      };
      process.once("SIGINT", onSigint);
      rl.once("SIGINT", onSigint);
      rl.once("close", onClose);
      stdin.once("end", onClose);
      rl.question(message, (answer) => {
        finish();
        resolve(answer);
      });
      rl.once("error", (error) => {
        finish();
        reject(error);
      });
    });

  return {
    async text({ message, defaultValue }) {
      const suffix = defaultValue === undefined ? "" : ` [${defaultValue}]`;
      const answer = (await askLine(`${message}${suffix}: `)).trim();
      return answer.length > 0 ? answer : (defaultValue ?? "");
    },
    async secret({ message }) {
      if (stdin.isTTY !== true) {
        throw new UserAbortError("secret input requires a TTY");
      }
      write(message);
      const wasRaw = stdin.isRaw === true;
      let valueBytes: number[] = [];
      try {
        stdin.setRawMode(true);
      } catch {
        // raw mode is best effort; without it the value may echo.
      }
      stdin.resume();
      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        const cleanup = (): void => {
          if (settled) return;
          settled = true;
          stdin.removeListener("data", onData);
          stdin.removeListener("end", onEnd);
          stdin.removeListener("close", onEnd);
          process.removeListener("SIGINT", onSigint);
          try {
            stdin.setRawMode(wasRaw);
          } catch {
            // best effort
          }
          write("\n");
        };
        const onEnd = (): void => {
          cleanup();
          reject(new UserAbortError("input closed"));
        };
        const onSigint = (): void => {
          cleanup();
          reject(new UserAbortError("interrupted"));
        };
        const onData = (chunk: Buffer | string): void => {
          const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
          for (const byte of bytes) {
            if (byte === 0x03) {
              cleanup();
              reject(new UserAbortError("interrupted"));
              return;
            }
            if (byte === 0x0d || byte === 0x0a) {
              const value = Buffer.from(valueBytes).toString("utf8");
              cleanup();
              resolve(value);
              return;
            }
            if (byte === 0x7f || byte === 0x08) {
              valueBytes = valueBytes.slice(0, -1);
              continue;
            }
            if (byte < 0x20) continue; // ignore control/escape bytes
            valueBytes.push(byte);
          }
        };
        process.once("SIGINT", onSigint);
        stdin.once("end", onEnd);
        stdin.once("close", onEnd);
        stdin.on("data", onData);
      });
    },
    async confirm({ message, defaultYes = false }) {
      const hint = defaultYes ? "[Y/n]" : "[y/N]";
      for (;;) {
        const answer = (await askLine(`${message} ${hint}: `)).trim().toLowerCase();
        if (answer.length === 0) return defaultYes;
        if (["y", "yes"].includes(answer)) return true;
        if (["n", "no"].includes(answer)) return false;
      }
    },
    async select({ message, choices, defaultIndex = 0 }) {
      for (;;) {
        write(`${message}\n`);
        for (let index = 0; index < choices.length; index += 1) {
          const marker = index === defaultIndex ? "*" : " ";
          write(`  ${marker}${index + 1}. ${choices[index]?.label ?? ""}\n`);
        }
        const answer = (await askLine(`Choose 1-${choices.length} [${defaultIndex + 1}]`)).trim();
        if (answer.length === 0) return choices[defaultIndex]?.value ?? choices[0]?.value ?? "";
        const index = Number.parseInt(answer, 10) - 1;
        if (Number.isSafeInteger(index) && index >= 0 && index < choices.length) {
          return choices[index]?.value ?? "";
        }
      }
    },
    print(message) {
      write(`${message}\n`);
    },
    close() {
      // Prompt interfaces are created per question; nothing persistent remains.
    },
  };
}
