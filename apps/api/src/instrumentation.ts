import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapOpenTelemetry } from "@akp/observability";

config({
  path: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../.env",
  ),
});

bootstrapOpenTelemetry({ serviceName: "akp-api" });
