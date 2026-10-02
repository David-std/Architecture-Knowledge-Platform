import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assessRetrievalAnswerability,
  assessRetrievalAnswerabilityWithVerifier,
  CONTEXTUAL_CROSS_ENCODER_DEFAULT_SUPPORT_SCORE,
  CONTEXTUAL_CROSS_ENCODER_MODEL,
  CONTEXTUAL_CROSS_ENCODER_REVISION,
  ContextualCrossEncoderEvidenceVerifier,
  contextualEvidenceText,
  OpenAICompatibleEvidenceReader,
  ReaderEvidenceVerifier,
  type CrossEncoderRuntimeFactory,
  EVIDENCE_READER_PROMPT_VERSION,
} from "../packages/retrieval/src/index.js";
import {
  evaluateEvidenceAdmission,
  evidenceAdmissionReport,
  loadEvidenceAdmissionPack,
  type EvidenceAdmitter,
  type Split,
  type summarizeEvidenceAdmission,
} from "./evidence-admission-pack.js";

import {
  CROSS_ENCODER_RECORDING_CONFIGURATION,
  recordedEvidenceScoreRuntime,
  recordedEvidenceReader,
  type RecordedEvidenceScores,
  type ReaderRecordingStats,
} from "./evidence-admission-recordings.js";

async function recordedRuntime(
  scoresPath: string,
): Promise<CrossEncoderRuntimeFactory> {
  const factory = recordedEvidenceScoreRuntime(
    JSON.parse(await readFile(scoresPath, "utf8")) as RecordedEvidenceScores,
  );
  // Validate before the product's fail-closed error handling. An incompatible
  // recording must fail the experiment, not masquerade as poor model recall.
  const runtime = await factory({
    model: CONTEXTUAL_CROSS_ENCODER_MODEL,
    revision: CONTEXTUAL_CROSS_ENCODER_REVISION,
    localFilesOnly: true,
    maxTokens: CROSS_ENCODER_RECORDING_CONFIGURATION.maxTokens,
    batchSize: CROSS_ENCODER_RECORDING_CONFIGURATION.batchSize,
  });
  for (const entry of cases) {
    await runtime.score(
      entry.hits.map((hit) => ({
        query: entry.question.query,
        passage: contextualEvidenceText({
          title: hit.title,
          headingPath: hit.headingPath ?? null,
          passage: hit.excerpt.trim(),
        }).text,
      })),
    );
  }
  return factory;
}

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

const requestedSplits = (
  process.env.AKP_EVIDENCE_ADMISSION_SPLITS ?? "development,heldout"
)
  .split(",")
  .map((split) => split.trim())
  .filter(
    (split): split is Split => split === "development" || split === "heldout",
  );
const { cases } = await loadEvidenceAdmissionPack(requestedSplits);
const verifierName =
  process.env.AKP_EVIDENCE_ADMISSION_VERIFIER ?? "deterministic";
let admitter: EvidenceAdmitter;
let label = verifierName;
let readerExecution: {
  stats: ReaderRecordingStats;
  provenanceHash: string;
} | null = null;
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
      ? { runtimeFactory: await recordedRuntime(scoresPath) }
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
} else if (verifierName === "cross-encoder-reader") {
  const scoresPath = process.env.AKP_CONTEXTUAL_EVIDENCE_SCORES;
  const shortlist = new ContextualCrossEncoderEvidenceVerifier({
    minimumSupportScore: CONTEXTUAL_CROSS_ENCODER_DEFAULT_SUPPORT_SCORE,
    ...(scoresPath
      ? { runtimeFactory: await recordedRuntime(scoresPath) }
      : {}),
    localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
  });
  const baseUrl = process.env.AKP_EVIDENCE_READER_BASE_URL;
  const model = process.env.AKP_EVIDENCE_READER_MODEL;
  if (!baseUrl || !model) {
    throw new Error(
      "AKP_EVIDENCE_READER_BASE_URL and AKP_EVIDENCE_READER_MODEL are required",
    );
  }
  const reader = new OpenAICompatibleEvidenceReader({
    baseUrl,
    model,
    timeoutMs: 120_000,
    maxOutputTokens: 256,
    jsonResponseFormat: true,
  });
  const shortlistSize = Number(process.env.AKP_EVIDENCE_READER_SHORTLIST ?? 4);
  const recordedReader = await recordedEvidenceReader(
    reader,
    process.env.AKP_EVIDENCE_READER_CACHE ??
      "reports/ci/evidence-reader-judgments.json",
    {
      modelRevision: process.env.AKP_EVIDENCE_READER_MODEL_REVISION ?? "",
      deploymentFingerprint:
        process.env.AKP_EVIDENCE_READER_DEPLOYMENT_FINGERPRINT ?? "",
      promptVersion: EVIDENCE_READER_PROMPT_VERSION,
      temperature: 0,
      maxOutputTokens: 256,
      jsonResponseFormat: true,
    },
  );
  readerExecution = {
    stats: recordedReader.stats,
    provenanceHash: recordedReader.provenanceHash,
  };
  const verifier = new ReaderEvidenceVerifier({
    reader: recordedReader.reader,
    shortlist,
    shortlistSize,
    concurrency: 1,
  });
  label = `${verifier.id} shortlist=${shortlistSize}${scoresPath ? " (recorded shortlist scores)" : ""}`;
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
if (readerExecution && readerExecution.stats.recordingErrors > 0)
  throw new Error("EVIDENCE_READER_RECORDING_FAILED");
const report = {
  ...evidenceAdmissionReport(results, label),
  ...(readerExecution
    ? {
        readerExecution: {
          ...readerExecution.stats,
          provenanceHash: readerExecution.provenanceHash,
          elapsedMsInterpretation:
            readerExecution.stats.cacheHits > 0
              ? "Includes policy replay of cached judgments; not end-to-end inference latency."
              : "Fresh judgments; elapsed query time includes reading and admission.",
        },
      }
    : {}),
};
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
