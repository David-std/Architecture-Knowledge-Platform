import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrapOpenTelemetry,
  shutdownOpenTelemetry,
} from "@akp/observability";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

config({
  path: path.resolve(moduleDirectory, "../../../.env"),
});

bootstrapOpenTelemetry({ serviceName: "akp-mcp" });

// Stdio MCP processes normally terminate because the client closes stdin, not
// because the OS sends SIGTERM. Flush the SDK on that normal lifecycle path so
// short-lived operator/CI sessions do not silently lose their final spans.
const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
const isMcpEntrypoint =
  entrypoint === path.resolve(moduleDirectory, "server.ts") ||
  entrypoint === path.resolve(moduleDirectory, "server.js");

if (isMcpEntrypoint) {
  let shutdownPromise: Promise<void> | null = null;
  const flushTelemetry = (): Promise<void> => {
    shutdownPromise ??= shutdownOpenTelemetry();
    return shutdownPromise;
  };

  process.stdin.once("end", () => {
    void flushTelemetry();
  });
  process.once("beforeExit", () => {
    void flushTelemetry();
  });

  const shutdownFromSignal = (): void => {
    void flushTelemetry().finally(() => process.exit(0));
  };
  // Prepend so this handler acquires the live SDK before the compatibility
  // signal handlers in server.ts call shutdown a second time.
  process.prependOnceListener("SIGTERM", shutdownFromSignal);
  process.prependOnceListener("SIGINT", shutdownFromSignal);
}
