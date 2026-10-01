import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assessRetrievalAnswerability,
  assessRetrievalAnswerabilityWithVerifier,
  ContextualCrossEncoderEvidenceVerifier,
  contextualEvidenceText,
  type CrossEncoderRuntimeFactory,
} from "../packages/retrieval/src/index.js";
import {
  evaluateEvidenceAdmission,
  evidenceAdmissionReport,
  loadEvidenceAdmissionPack,
  type EvidenceAdmissionCase,
  type EvidenceAdmitter,
  type summarizeEvidenceAdmission,
} from "./evidence-admission-pack.js";

const deterministicAdmitter: EvidenceAdmitter = async (hits, query) =>
  assessRetrievalAnswerability(hits, query).supportedCandidateKeys;

/**
 * Replays cross-encoder scores recorded by contextual-evidence-pack-scores.ts
 * so thresholds can be compared through the product admission path without
 * reloading the model.
 */
async function recordedRuntime(
  cases: readonly EvidenceAdmissionCase[],
  scoresPath: string,
): Promise<CrossEncoderRuntimeFactory> {
  const recorded = JSON.parse(await readFile(scoresPath, "utf8")) as {
    rows: Array<{ questionId: string; unitId: string; contextual: number }>;
  };
  const byQuestionUnit = new Map(
    recorded.rows.map((row) => [
      `${row.questionId}\u0000${row.unitId}`,
      row.contextual,
    ]),
  );
  const byPair = new Map<string, number>();
  for (const entry of cases) {
    for (const hit of entry.hits) {
      const score = byQuestionUnit.get(
        `${entry.question.id}\u0000${hit.document.externalId}`,
      );
      if (score === undefined) continue;
      const passage = contextualEvidenceText({
        title: hit.title,
        headingPath: hit.headingPath ?? null,
        passage: hit.excerpt.trim(),
      }).text;
      byPair.set(`${entry.question.query}\u0000${passage}`, score);
    }
  }
  return async () => ({
    score: async (pairs) =>
      pairs.map((pair) => {
        const score = byPair.get(`${pair.query}\u0000${pair.passage}`);
        if (score === undefined) throw new Error("RECORDED_SCORE_MISSING");
        return score;
      }),
  });
}

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
const verifierName =
  process.env.AKP_EVIDENCE_ADMISSION_VERIFIER ?? "deterministic";
let admitter: EvidenceAdmitter;
let label = verifierName;
if (verifierName === "deterministic") {
  admitter = deterministicAdmitter;
} else if (verifierName === "contextual-cross-encoder") {
  const minimumSupportScore = Number(
    process.env.AKP_EVIDENCE_VERIFIER_MIN_SCORE ?? "",
  );
  const scoresPath = process.env.AKP_CONTEXTUAL_EVIDENCE_SCORES;
  const verifier = new ContextualCrossEncoderEvidenceVerifier({
    minimumSupportScore,
    ...(scoresPath
      ? { runtimeFactory: await recordedRuntime(cases, scoresPath) }
      : {}),
    localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
  });
  label = `${verifier.id} min=${minimumSupportScore}${scoresPath ? " (recorded scores)" : ""}`;
  admitter = async (hits, query) =>
    (
      await assessRetrievalAnswerabilityWithVerifier(hits, query, verifier, {
        mode: "ENFORCE",
        maxCandidates: 64,
      })
    ).supportedCandidateKeys;
} else {
  throw new Error(`Unknown AKP_EVIDENCE_ADMISSION_VERIFIER ${verifierName}`);
}

const results = await evaluateEvidenceAdmission(cases, admitter);
const report = evidenceAdmissionReport(results, label);
const outputPath = path.resolve(
  process.env.AKP_EVIDENCE_ADMISSION_GENERALIZATION_REPORT ??
    "reports/ci/evidence-admission-generalization.json",
);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(label);
printSummary("development", report.development);
printSummary("heldout", report.heldout);
if (process.env.AKP_EVIDENCE_ADMISSION_BREAKDOWN !== "0") {
  for (const [intent, summary] of Object.entries(report.byIntent)) {
    printSummary(`intent:${intent}`, summary);
  }
  for (const [challenge, summary] of Object.entries(report.byChallenge)) {
    printSummary(`challenge:${challenge}`, summary);
  }
  for (const [language, summary] of Object.entries(report.byLanguage)) {
    printSummary(`language:${language}`, summary);
  }
}
