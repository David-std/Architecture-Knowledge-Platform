import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  evaluateCapabilityAcceptance,
  renderCapabilityAcceptanceMarkdown,
  type CapabilityAcceptanceManifest,
  type CapabilityEvidenceLedger,
} from "../packages/evaluation/src/index.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.resolve(
  repositoryRoot,
  process.env.AKP_CAPABILITY_ACCEPTANCE_MANIFEST ??
    "evals/registered/v0.4-capability-acceptance.json",
);
const ledgerPath = path.resolve(
  repositoryRoot,
  process.env.AKP_CAPABILITY_EVIDENCE_LEDGER ??
    "reports/ci/release-assurance-evidence.json",
);
const jsonOutput = path.resolve(
  repositoryRoot,
  process.env.AKP_CAPABILITY_ACCEPTANCE_JSON ??
    "reports/ci/capability-acceptance.json",
);
const markdownOutput = path.resolve(
  repositoryRoot,
  process.env.AKP_CAPABILITY_ACCEPTANCE_MARKDOWN ??
    "reports/ci/capability-acceptance.md",
);

function objectRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function validateManifest(raw: unknown): CapabilityAcceptanceManifest {
  const root = objectRecord(raw, "capability acceptance manifest");
  if (root.schemaVersion !== 1 || root.release !== "v0.4.0") {
    throw new Error("Unsupported capability acceptance manifest.");
  }
  if (!Array.isArray(root.capabilities) || root.capabilities.length === 0) {
    throw new Error("Capability acceptance manifest has no capabilities.");
  }
  for (const value of root.capabilities) {
    const capability = objectRecord(value, "capability");
    if ("maturity" in capability || "maturityStage" in capability) {
      throw new Error(
        `Capability ${String(capability.id ?? "<unknown>")} contains a forbidden manual maturity field.`,
      );
    }
  }
  return raw as CapabilityAcceptanceManifest;
}

function validateLedger(raw: unknown): CapabilityEvidenceLedger {
  const root = objectRecord(raw, "capability evidence ledger");
  if (
    root.schemaVersion !== 1 ||
    typeof root.commit !== "string" ||
    !/^[a-f0-9]{40}$/i.test(root.commit) ||
    typeof root.generatedAt !== "string"
  ) {
    throw new Error("Capability evidence ledger header is invalid.");
  }
  objectRecord(root.evidence, "capability evidence ledger.evidence");
  return raw as CapabilityEvidenceLedger;
}

const [manifestRaw, ledgerRaw] = await Promise.all([
  readFile(manifestPath, "utf8"),
  readFile(ledgerPath, "utf8"),
]);
const manifest = validateManifest(JSON.parse(manifestRaw));
const ledger = validateLedger(JSON.parse(ledgerRaw));
const report = evaluateCapabilityAcceptance(manifest, ledger);
const markdown = renderCapabilityAcceptanceMarkdown(report);

await Promise.all([
  mkdir(path.dirname(jsonOutput), { recursive: true }),
  mkdir(path.dirname(markdownOutput), { recursive: true }),
]);
await Promise.all([
  writeFile(jsonOutput, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  writeFile(markdownOutput, markdown, "utf8"),
]);

console.log(
  JSON.stringify(
    {
      status: report.status,
      release: report.release,
      commit: report.commit,
      capabilities: report.summary.total,
      productized: report.summary.productized,
      mandatoryNotProductized: report.summary.mandatoryNotProductized,
      jsonOutput,
      markdownOutput,
    },
    null,
    2,
  ),
);

if (report.status !== "PASSED") process.exitCode = 1;
