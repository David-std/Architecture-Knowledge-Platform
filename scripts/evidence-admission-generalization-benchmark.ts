import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { assessRetrievalAnswerability } from "../packages/retrieval/src/index.js";
import {
  evaluateEvidenceAdmission,
  evidenceAdmissionReport,
  loadEvidenceAdmissionPack,
  type EvidenceAdmitter,
  type summarizeEvidenceAdmission,
} from "./evidence-admission-pack.js";

const deterministicAdmitter: EvidenceAdmitter = async (hits, query) =>
  assessRetrievalAnswerability(hits, query).supportedCandidateKeys;

function formatRate(value: number | null): string {
  return value === null ? "  n/a" : `${(value * 100).toFixed(1).padStart(5)}%`;
}

function printSummary(
  name: string,
  summary: ReturnType<typeof summarizeEvidenceAdmission>,
): void {
  console.log(
    `${name.padEnd(28)} q=${String(summary.questions).padStart(3)} recall=${formatRate(summary.answerableRecall)} falseAccept=${formatRate(summary.falseAcceptanceRate)} precision=${formatRate(summary.admittedPrecision)} strict=${formatRate(summary.strictAccuracy)}`,
  );
}

const { cases } = await loadEvidenceAdmissionPack();
const results = await evaluateEvidenceAdmission(cases, deterministicAdmitter);
const report = evidenceAdmissionReport(results, "deterministic");
const outputPath = path.resolve(
  process.env.AKP_EVIDENCE_ADMISSION_GENERALIZATION_REPORT ??
    "reports/ci/evidence-admission-generalization.json",
);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
printSummary("development", report.development);
printSummary("heldout", report.heldout);
for (const [intent, summary] of Object.entries(report.byIntent)) {
  printSummary(`intent:${intent}`, summary);
}
for (const [challenge, summary] of Object.entries(report.byChallenge)) {
  printSummary(`challenge:${challenge}`, summary);
}
for (const [language, summary] of Object.entries(report.byLanguage)) {
  printSummary(`language:${language}`, summary);
}
