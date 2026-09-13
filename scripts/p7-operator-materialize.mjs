import fs from "node:fs";

const path = "apps/api/src/routes/operator.ts";
let source = fs.readFileSync(path, "utf8");

function replaceOnce(before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`P7_PATCH_MISSING:${label}`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`P7_PATCH_AMBIGUOUS:${label}`);
  }
  source = source.replace(before, after);
}

replaceOnce(
  'import type { FastifyInstance } from "fastify";\n',
  'import type { FastifyInstance } from "fastify";\nimport { getOpenTelemetryStatus } from "@akp/observability";\n',
  "otel-import",
);

replaceOnce(
  '      const status =\n        database && rawStore.ok && extractor.ok ? "UP" : "DEGRADED";\n      return sanitizeOperationalValue({',
  '      const telemetry = getOpenTelemetryStatus();\n      const status =\n        database && rawStore.ok && extractor.ok ? "UP" : "DEGRADED";\n      return sanitizeOperationalValue({',
  "telemetry-status",
);

replaceOnce(
  '        providers: providerCapabilities.ok ? providerCapabilities.body : null,\n        indexes: indexes.rows,',
  '        providers: providerCapabilities.ok ? providerCapabilities.body : null,\n        observability: {\n          enabled: telemetry.enabled,\n          started: telemetry.started,\n          serviceName: telemetry.serviceName,\n          tracesExporter: telemetry.tracesExporter,\n          metricsExporter: telemetry.metricsExporter,\n          endpointConfigured: Boolean(telemetry.endpoint),\n          protocol: telemetry.protocol,\n          w3cTraceContext: telemetry.w3cTraceContext,\n          logs: telemetry.logs,\n          lastError: telemetry.lastError,\n        },\n        indexes: indexes.rows,',
  "health-output",
);

fs.writeFileSync(path, source);
