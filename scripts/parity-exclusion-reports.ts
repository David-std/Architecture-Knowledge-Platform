import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  evaluateParityExclusions,
  renderParityExclusionDomainMarkdown,
  renderParityExclusionIndexMarkdown,
  type CapabilityAcceptanceReport,
  type ParityExclusionManifest,
} from "../packages/evaluation/src/index.js";

const root = path.resolve(import.meta.dirname, "..");
const manifestPath = path.resolve(
  root,
  process.env.AKP_PARITY_EXCLUSION_MANIFEST ??
    "evals/registered/v0.4-parity-exclusions.json",
);
const capabilityPath = path.resolve(
  root,
  process.env.AKP_CAPABILITY_ACCEPTANCE_JSON ??
    "reports/ci/capability-acceptance.json",
);
const outputDirectory = path.resolve(
  root,
  process.env.AKP_PARITY_EXCLUSION_DIR ?? "reports/ci/parity-exclusions",
);

const [manifestRaw, capabilityRaw] = await Promise.all([
  readFile(manifestPath, "utf8"),
  readFile(capabilityPath, "utf8"),
]);
const manifest = JSON.parse(manifestRaw) as ParityExclusionManifest;
const capability = JSON.parse(capabilityRaw) as CapabilityAcceptanceReport;
const report = evaluateParityExclusions(manifest, capability);

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(
    path.join(outputDirectory, "index.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  ),
  writeFile(
    path.join(outputDirectory, "index.md"),
    renderParityExclusionIndexMarkdown(report),
    "utf8",
  ),
  ...report.domains.map((domain) =>
    writeFile(
      path.join(outputDirectory, `${domain.id}.md`),
      renderParityExclusionDomainMarkdown(report, domain.id),
      "utf8",
    ),
  ),
]);

console.log(
  JSON.stringify(
    {
      status: report.status,
      release: report.release,
      commit: report.commit,
      domains: report.domains.map((domain) => ({
        id: domain.id,
        status: domain.status,
        supported: domain.items.filter((item) => item.status === "SUPPORTED")
          .length,
        excluded: domain.items.filter((item) => item.status === "EXCLUDED")
          .length,
      })),
      failures: report.failures,
      outputDirectory,
    },
    null,
    2,
  ),
);
if (report.status !== "PASSED") process.exitCode = 1;
