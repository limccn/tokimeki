import { spawn } from "node:child_process";
import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REMOTE_HOSTS = {
  jp: { host: "root@139.162.68.167", jump: null },
  us: { host: "root@172.236.233.158", jump: "root@139.162.68.167" },
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const REMOTE_ROOT = "/opt/tokimeki";
const REMOTE_PERF = `${REMOTE_ROOT}/scripts/perf`;

export function sshArgs({ host, jump, port = 22, tty = false }) {
  const args = [
    tty ? "-tt" : "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=10",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-p",
    String(port),
  ];
  if (jump !== null) {
    args.push("-J", jump);
  }
  args.push(host);
  return args;
}

function scpArgs({ host, jump, port = 22 }) {
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-P", String(port)];
  if (jump !== null) {
    args.push("-J", jump);
  }
  return args;
}

/** Run a remote command through the user's ssh-agent; never pass secrets in argv. */
export function runRemote({ remote, command, input = null, timeoutMs = 60_000 }) {
  const target = REMOTE_HOSTS[remote];
  if (target === undefined) {
    throw new Error(`unknown remote: ${remote}`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...sshArgs(target), command], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (data) => {
      stdout += data.toString("utf8");
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString("utf8");
    });
    // ssh can exit before consuming stdin (banner/auth failures); an EPIPE on
    // the child stdin must not surface as an uncaught stream error.
    child.stdin.on("error", () => {
      // best effort
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`remote ${remote}: timeout after ${timeoutMs}ms`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
    if (input !== null) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

/** Spawn a long-lived remote viewer; token is written to stdin, never argv. */
export function spawnRemoteViewer({ remote, args, token, timeoutMs = 120_000 }) {
  const target = REMOTE_HOSTS[remote];
  if (target === undefined) {
    throw new Error(`unknown remote: ${remote}`);
  }
  if (token === undefined || token === null) {
    throw new Error("remote viewer token is required");
  }
  const command = `cd ${REMOTE_ROOT} && node scripts/perf/remote/remote-viewer.mjs ${args}`;
  const child = spawn("ssh", [...sshArgs(target), command], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let exited = false;
  let exitCode = null;
  let readySettled = false;
  let readyResolve;
  let readyReject;
  let doneResolve;
  let doneReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const done = new Promise((resolve, reject) => {
    doneResolve = resolve;
    doneReject = reject;
  });
  // A caller may stop awaiting `done` after another viewer fails; keep the
  // rejection observed so a later timeout cannot crash the CLI process.
  done.catch(() => {
    // handled by the caller when it awaits `done`
  });
  ready.catch(() => {
    // handled by the caller when it awaits `ready`
  });
  const timer = setTimeout(() => {
    if (!exited) {
      child.kill();
      if (!readySettled) {
        readySettled = true;
        readyReject(new Error(`remote viewer ${remote}: ready timeout`));
      }
      doneReject(new Error(`remote viewer ${remote}: timeout after ${timeoutMs}ms`));
    }
  }, timeoutMs);

  child.stdout.on("data", (data) => {
    stdout += data.toString("utf8");
    if (!readySettled && stdout.includes("REMOTE_VIEWER_READY")) {
      readySettled = true;
      readyResolve();
    }
  });
  child.stderr.on("data", (data) => {
    stderr += data.toString("utf8");
  });
  child.on("error", (error) => {
    clearTimeout(timer);
    if (!readySettled) {
      readySettled = true;
      readyReject(error);
    }
    doneReject(error);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    exited = true;
    exitCode = code;
    if (!readySettled) {
      readySettled = true;
      readyReject(new Error(`remote viewer ${remote}: exited before ready (${code})`));
    }
    doneResolve({ code, stdout, stderr });
  });

  child.stdin.on("error", () => {
    // ssh may exit before reading the token; never crash on EPIPE.
  });
  child.stdin.write(`${token}\n`);
  child.stdin.end();

  return {
    ready,
    done,
    close: () => {
      if (!exited) {
        child.kill();
      }
    },
    get output() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    get exitCode() {
      return exitCode;
    },
  };
}

/** Copy the minimal perf harness to the remote host (idempotent). */
export async function ensureRemoteHarness(remote) {
  if (process.env.TOKIMEKI_PERF_SKIP_REMOTE_COPY === "1") {
    return;
  }
  const mkdir = await runRemote({
    remote,
    command: `mkdir -p ${REMOTE_PERF}/harness ${REMOTE_PERF}/remote`,
    timeoutMs: 30_000,
  });
  if (mkdir.code !== 0) {
    throw new Error(`remote ${remote}: mkdir failed: ${mkdir.stderr}`);
  }
  const target = REMOTE_HOSTS[remote];
  const copies = [
    ["scripts/perf/harness/relay-viewer.mjs", `${REMOTE_PERF}/harness/relay-viewer.mjs`],
    ["scripts/perf/harness/metrics.mjs", `${REMOTE_PERF}/harness/metrics.mjs`],
    ["scripts/perf/remote/remote-viewer.mjs", `${REMOTE_PERF}/remote/remote-viewer.mjs`],
    ["scripts/perf/remote/remote-attach-pty.mjs", `${REMOTE_PERF}/remote/remote-attach-pty.mjs`],
  ];
  for (const [local, remotePath] of copies) {
    let lastError = "unknown scp error";
    let copied = false;
    for (let attempt = 0; attempt < 2 && !copied; attempt += 1) {
      const result = await new Promise((resolve, reject) => {
        const child = spawn("scp", [...scpArgs(target), local, `${target.host}:${remotePath}`], {
          cwd: root,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, 30_000);
        child.stderr.on("data", (data) => {
          stderr += data.toString("utf8");
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({
            code: timedOut ? -1 : code,
            stderr: timedOut ? `${stderr}\nscp timeout` : stderr,
          });
        });
      });
      if (result.code === 0) {
        copied = true;
      } else {
        // scp is unreliable on the cross-border link; fall back to SSH stdin.
        const fallback = await runRemote({
          remote,
          command: `cat > ${remotePath}`,
          input: fs.readFileSync(resolve(root, local), "utf8"),
          timeoutMs: 30_000,
        });
        if (fallback.code === 0) {
          copied = true;
        } else {
          lastError = fallback.stderr || result.stderr;
        }
      }
    }
    if (!copied) {
      throw new Error(`remote ${remote}: scp ${local} failed: ${lastError}`);
    }
  }
}
