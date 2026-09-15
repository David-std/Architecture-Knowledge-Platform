import fs from "node:fs";
import path from "node:path";

const requiredSpans = [
  "ingest.receive",
  "raw.store",
  "extract.request",
  "extract.process",
  "compile.retrieve_existing",
  "compile.plan",
  "compile.validate",
  "review.publish",
  "review.rollback",
  "outbox.append",
  "outbox.deliver",
  "index.incremental",
  "index.embedding",
  "retrieve.exact",
  "retrieve.lexical",
  "retrieve.vector",
  "retrieve.graph",
  "retrieve.fuse",
  "context.build",
  "mcp.tool",
  "backup",
  "restore",
];

const requiredMetrics = [
  "ingest_jobs_total",
  "ingest_job_age",
  "outbox_deliveries",
  "outbox_retry_age",
  "outbox_quarantined",
  "index_revision_mismatch",
  "retrieval_requests",
  "retrieval_channel_latency",
  "retrieval_candidates",
  "context_packet_tokens",
  "context_packet_sections",
  "provider_failures",
  "extract_latency",
];

const roots = ["apps", "packages"];
const extensions = new Set([".ts", ".tsx", ".js", ".mjs"]);
const ignoredDirectories = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  "coverage",
]);
const files = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(candidate);
    else if (extensions.has(path.extname(entry.name))) files.push(candidate);
  }
}

for (const root of roots) {
  if (fs.existsSync(root)) walk(root);
}
const telemetryCommand = path.join("scripts", "telemetry-command.ts");
if (fs.existsSync(telemetryCommand)) files.push(telemetryCommand);

const sources = files.map((file) => ({
  file,
  content: fs.readFileSync(file, "utf8"),
}));

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function evidenceFor(name) {
  const quotedLiteral = new RegExp(`["'\\x60]${escapeRegExp(name)}["'\\x60]`);
  return sources
    .filter(({ content }) => quotedLiteral.test(content))
    .map(({ file }) => file)
    .sort();
}

const spanEvidence = Object.fromEntries(
  requiredSpans.map((name) => [name, evidenceFor(name)]),
);
const metricEvidence = Object.fromEntries(
  requiredMetrics.map((name) => [name, evidenceFor(name)]),
);
const missingSpans = requiredSpans.filter(
  (name) => spanEvidence[name].length === 0,
);
const missingMetrics = requiredMetrics.filter(
  (name) => metricEvidence[name].length === 0,
);

let runtimeChecks = null;
const collectorLog = process.env.AKP_OTEL_COLLECTOR_LOG;
if (collectorLog) {
  const log = fs.readFileSync(collectorLog, "utf8");
  // The Collector debug exporter aligns labels with padding, e.g.
  // `Name           : backup`. Match semantic label/value boundaries instead
  // of depending on a particular amount of formatting whitespace.
  runtimeChecks = {
    resourceSpans: /ResourceSpans|ScopeSpans|Span #/i.test(log),
    resourceMetrics: /ResourceMetrics|ScopeMetrics|Metric #/i.test(log),
    apiService: /service\.name\s*:\s*Str\(akp-api\)/i.test(log),
    workerService: /service\.name\s*:\s*Str\(akp-worker\)/i.test(log),
    mcpService: /service\.name\s*:\s*Str\(akp-mcp\)/i.test(log),
    retrievalMetric: /\bName\s*:\s*retrieval_requests\b/i.test(log),
    workerSmokeSpan: /\bName\s*:\s*worker\.telemetry\.smoke\b/i.test(log),
    mcpToolSpan: /\bName\s*:\s*mcp\.tool\b/i.test(log),
    backupSpan: /\bName\s*:\s*backup\b/i.test(log),
    restoreSpan: /\bName\s*:\s*restore\b/i.test(log),
  };
}

const failedRuntimeChecks = runtimeChecks
  ? Object.entries(runtimeChecks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
  : [];
const report = {
  missingSpans,
  missingMetrics,
  spanEvidence,
  metricEvidence,
  runtimeChecks,
  failedRuntimeChecks,
};

// Always emit one machine-readable report. CI can retain this exact payload as
// evidence even when verification fails, instead of splitting the failure
// details across stdout/stderr.
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (
  missingSpans.length > 0 ||
  missingMetrics.length > 0 ||
  failedRuntimeChecks.length > 0
) {
  process.exitCode = 1;
}
