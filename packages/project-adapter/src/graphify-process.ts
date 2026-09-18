import { spawn } from "node:child_process";
import path from "node:path";

function graphifyError(code: string): Error {
  const value = new Error(code) as Error & { code?: string };
  value.code = code;
  return value;
}

export function safeGraphifyEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    TMPDIR: path.join(home, "tmp"),
    TEMP: path.join(home, "tmp"),
    TMP: path.join(home, "tmp"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    GRAPHIFY_QUERY_LOG_DISABLE: "1",
  };
  if (process.platform === "win32" && process.env.SystemRoot) {
    env.SystemRoot = process.env.SystemRoot;
  }
  return env;
}

export async function runBoundedProcess(
  executable: string,
  args: readonly string[],
  input: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes: number;
  },
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn(executable, [...args], {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timer: NodeJS.Timeout | undefined;

    const fail = (cause: unknown, code: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.kill("SIGKILL");
      const wrapped = graphifyError(code);
      (wrapped as Error & { cause?: unknown }).cause = cause;
      reject(wrapped);
    };

    const collect = (target: Buffer[], chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > input.maxOutputBytes) {
        fail(undefined, "GRAPHIFY_PROCESS_OUTPUT_LIMIT");
        return;
      }
      target.push(buffer);
    };

    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.once("error", (cause) => {
      fail(cause, "GRAPHIFY_PROCESS_START_FAILED");
    });
    timer = setTimeout(() => {
      fail(undefined, "GRAPHIFY_PROCESS_TIMEOUT");
    }, input.timeoutMs);

    child.once("close", (status, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (status !== 0) {
        const failure = graphifyError("GRAPHIFY_PROCESS_FAILED") as Error & {
          status?: number | null;
          signal?: NodeJS.Signals | null;
          stderr?: string;
        };
        failure.status = status;
        failure.signal = signal;
        failure.stderr = Buffer.concat(stderr).toString("utf8").slice(-8192);
        reject(failure);
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

export function parseGraphifyVersion(output: string): string {
  const match = /(?:graphify(?:y)?\s*)?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i.exec(
    output,
  );
  if (!match?.[1]) throw graphifyError("GRAPHIFY_VERSION_UNRECOGNIZED");
  return match[1];
}
