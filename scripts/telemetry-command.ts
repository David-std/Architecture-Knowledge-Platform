import { spawn } from "node:child_process";
import { config } from "dotenv";
import {
  bootstrapOpenTelemetry,
  shutdownOpenTelemetry,
  withSpan,
} from "../packages/observability/src/index.js";

config();

const [operation, command, ...args] = process.argv.slice(2);
if (!operation || !command) {
  throw new Error(
    "usage: telemetry-command <backup|restore> <command> [arguments...]",
  );
}
if (operation !== "backup" && operation !== "restore") {
  throw new Error(`UNSUPPORTED_TELEMETRY_OPERATION:${operation}`);
}

bootstrapOpenTelemetry({
  serviceName: process.env.OTEL_SERVICE_NAME ?? "akp-operations",
  autoInstrument: false,
});

async function run(): Promise<void> {
  await withSpan(operation, { "akp.operation": operation }, async () => {
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: "inherit",
        shell: false,
        env: process.env,
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (signal) {
          reject(new Error(`${operation.toUpperCase()}_TERMINATED:${signal}`));
          return;
        }
        resolve(code ?? 1);
      });
    });
    if (exitCode !== 0) {
      throw new Error(`${operation.toUpperCase()}_FAILED:${exitCode}`);
    }
  });
}

try {
  await run();
} finally {
  await shutdownOpenTelemetry();
}
