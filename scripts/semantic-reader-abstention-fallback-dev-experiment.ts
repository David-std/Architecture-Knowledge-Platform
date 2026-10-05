import "dotenv/config";

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assessRetrievalAnswerability,
  assessRetrievalAnswerabilityWithVerifier,
  OpenAICompatibleEvidenceReader,
  projectRequestedAnswerSlot,
  ReaderEvidenceVerifier,
} from "../packages/retrieval/src/index.js";
import {
  evaluateEvidenceAdmission,
  loadEvidenceAdmissionPack,
  summarizeEvidenceAdmission,
} from "./evidence-admission-pack.js";

type FrozenInput = { path: string; gitBlobSha: string };

type ExperimentManifest = {
  schemaVersion: string;
  frozen: boolean;
  baselineSha: string;
  inputs: FrozenInput[];
  model: {
    id: string;
    revision: string;
    dtype: string;
    temperature: number;
    maxOutputTokens: number;
  };
  protocol: {
    phase: string;
    evaluatedSplit: "development";
    heldoutEvaluated: boolean;
    readerReceivesRequestedAnswerSlot: boolean;
    slotUsedAsEvidenceAuthority: boolean;
    readerMode: "ENFORCE";
    readerShortlistSize: number;
    readerConcurrency: number;
    providerDefaultsChanged: boolean;
    runtimeChanged: boolean;
    productionAdmissionChanged: boolean;
    noTuningAgainstPriorHeldouts: boolean;
  };
  developmentGate: {
    outcomes: string[];
  };
};

type SemanticAttempt = {
  query: string;
  slot: ReturnType<typeof projectRequestedAnswerSlot>;
  supportedCandidateKeys: string[];
  supports: Array<{
    candidateKey: string;
    decision: string | null;
    reason: string | null;
    sourceBound: boolean;
    startOffset: number | null;
    endOffset: number | null;
  }>;
};

const root = path.resolve(".");
const protocolPath = path.resolve(
  "evals/generic/semantic-reader-abstention-fallback-dev/manifest.json",
);
const outputPath = path.resolve(
  process.env.AKP_SEMANTIC_READER_FALLBACK_DEV_REPORT ??
    "reports/ci/semantic-reader-abstention-fallback-dev.json",
);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function gitBlobSha(filePath: string): string {
  return execFileSync("git", ["hash-object", filePath], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function assertAncestor(sha: string): void {
  execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
    cwd: root,
    stdio: "ignore",
  });
}

function currentCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function noRegression(candidate: number | null, baseline: number | null) {
  if (baseline === null) return candidate === null;
  return candidate !== null && candidate >= baseline;
}

function noIncrease(candidate: number | null, baseline: number | null) {
  if (baseline === null) return candidate === null;
  return candidate !== null && candidate <= baseline;
}

const protocolRaw = await readFile(protocolPath, "utf8");
const protocol = JSON.parse(protocolRaw) as ExperimentManifest;
if (
  protocol.schemaVersion !==
    "akp.semantic-reader-abstention-fallback-dev.v1" ||
  protocol.frozen !== true ||
  protocol.protocol.phase !== "DEVELOPMENT_FEASIBILITY_ONLY" ||
  protocol.protocol.evaluatedSplit !== "development" ||
  protocol.protocol.heldoutEvaluated !== false ||
  protocol.protocol.readerReceivesRequestedAnswerSlot !== false ||
  protocol.protocol.slotUsedAsEvidenceAuthority !== false ||
  protocol.protocol.readerMode !== "ENFORCE" ||
  protocol.protocol.providerDefaultsChanged !== false ||
  protocol.protocol.runtimeChanged !== false ||
  protocol.protocol.productionAdmissionChanged !== false ||
  protocol.protocol.noTuningAgainstPriorHeldouts !== true
) {
  throw new Error("SEMANTIC_READER_FALLBACK_DEV_PROTOCOL_DRIFT");
}
assertAncestor(protocol.baselineSha);

const sourceHashes: Record<string, string> = {};
for (const input of protocol.inputs) {
  const absolute = path.resolve(input.path);
  if (gitBlobSha(absolute) !== input.gitBlobSha) {
    throw new Error("FROZEN_INPUT_CHANGED:" + input.path);
  }
  sourceHashes[input.path] = sha256(await readFile(absolute, "utf8"));
}

const baseUrl = process.env.AKP_SEMANTIC_READER_FALLBACK_DEV_BASE_URL?.trim();
const model = process.env.AKP_SEMANTIC_READER_FALLBACK_DEV_MODEL?.trim();
const revision =
  process.env.AKP_SEMANTIC_READER_FALLBACK_DEV_MODEL_REVISION?.trim();
const dtype = process.env.AKP_SEMANTIC_READER_FALLBACK_DEV_DTYPE?.trim();

if (!baseUrl) throw new Error("SEMANTIC_READER_FALLBACK_DEV_BASE_URL_REQUIRED");
if (model !== protocol.model.id) {
  throw new Error("SEMANTIC_READER_FALLBACK_DEV_MODEL_DRIFT");
}
if (revision !== protocol.model.revision) {
  throw new Error("SEMANTIC_READER_FALLBACK_DEV_REVISION_DRIFT");
}
if (dtype !== protocol.model.dtype) {
  throw new Error("SEMANTIC_READER_FALLBACK_DEV_DTYPE_DRIFT");
}

const { cases } = await loadEvidenceAdmissionPack(["development"]);
if (cases.some((entry) => entry.domain.split !== "development")) {
  throw new Error("SEMANTIC_READER_FALLBACK_DEV_HELDOUT_LOADED");
}

const baselineResults = await evaluateEvidenceAdmission(
  cases,
  async (hits, query) => assessRetrievalAnswerability(hits, query),
);

const reader = new OpenAICompatibleEvidenceReader({
  baseUrl,
  model,
  maxOutputTokens: protocol.model.maxOutputTokens,
  timeoutMs: 30_000,
  jsonResponseFormat: true,
});
const verifier = new ReaderEvidenceVerifier({
  reader,
  shortlistSize: protocol.protocol.readerShortlistSize,
  concurrency: protocol.protocol.readerConcurrency,
});

const semanticAttempts: SemanticAttempt[] = [];
const preservedBaselineQueries = new Set<string>();
const slotRejectedQueries = new Set<string>();

let candidateResults;
try {
  candidateResults = await evaluateEvidenceAdmission(
    cases,
    async (hits, query) => {
      const baseline = assessRetrievalAnswerability(hits, query);
      if (baseline.supported) {
        preservedBaselineQueries.add(query);
        return baseline;
      }

      const slot = projectRequestedAnswerSlot(query);
      if (!slot) {
        slotRejectedQueries.add(query);
        return baseline;
      }

      const semantic = await assessRetrievalAnswerabilityWithVerifier(
        hits,
        query,
        verifier,
        {
          mode: "ENFORCE",
          maxCandidates: 64,
          maxConcurrency: protocol.protocol.readerConcurrency,
        },
        {},
        { comparisonHits: hits },
      );

      const supports = semantic.candidateSignals
        .filter((signal) =>
          semantic.supportedCandidateKeys.includes(signal.candidateKey),
        )
        .map((signal) => {
          const trace = signal.queryConditionedEvidence;
          return {
            candidateKey: signal.candidateKey,
            decision: trace?.decision ?? null,
            reason: trace?.reason ?? null,
            sourceBound:
              trace?.decision === "SUPPORTS" &&
              trace.evidenceSpan !== null &&
              trace.evidenceSpan !== undefined &&
              Number.isSafeInteger(trace.evidenceSpan.startOffset) &&
              Number.isSafeInteger(trace.evidenceSpan.endOffset) &&
              trace.evidenceSpan.startOffset >= 0 &&
              trace.evidenceSpan.endOffset > trace.evidenceSpan.startOffset,
            startOffset: trace?.evidenceSpan?.startOffset ?? null,
            endOffset: trace?.evidenceSpan?.endOffset ?? null,
          };
        });

      semanticAttempts.push({
        query,
        slot,
        supportedCandidateKeys: [...semantic.supportedCandidateKeys],
        supports,
      });

      return semantic;
    },
  );
} finally {
  await verifier.dispose();
}

const baseline = summarizeEvidenceAdmission(baselineResults);
const candidate = summarizeEvidenceAdmission(candidateResults);
const baselineById = new Map(baselineResults.map((row) => [row.id, row]));
const changes = candidateResults.flatMap((row) => {
  const before = baselineById.get(row.id);
  if (!before) throw new Error("BASELINE_RESULT_MISSING:" + row.id);
  if (before.admitted.join("\n") === row.admitted.join("\n")) return [];
  return [
    {
      id: row.id,
      domain: row.domain,
      intent: row.intent,
      language: row.language,
      challenges: row.challenges,
      answerable: row.answerable,
      baselineAdmitted: before.admitted,
      candidateAdmitted: row.admitted,
      baselineGoldAdmitted: before.goldAdmitted,
      candidateGoldAdmitted: row.goldAdmitted,
      baselineWrongAdmissions: before.wrongAdmissions,
      candidateWrongAdmissions: row.wrongAdmissions,
      baselineStrictCorrect: before.strictCorrect,
      candidateStrictCorrect: row.strictCorrect,
    },
  ];
});

const correctGoldRescues = changes.filter(
  (row) =>
    row.answerable &&
    !row.baselineGoldAdmitted &&
    row.candidateGoldAdmitted &&
    row.candidateWrongAdmissions.length === 0,
);
const newFalseAcceptances = changes.filter(
  (row) =>
    !row.answerable &&
    row.baselineAdmitted.length === 0 &&
    row.candidateAdmitted.length > 0,
);
const newWrongAdmissions = changes.filter(
  (row) =>
    row.candidateWrongAdmissions.length > row.baselineWrongAdmissions.length,
);
const baselineRegressions = changes.filter(
  (row) =>
    row.baselineGoldAdmitted && !row.candidateGoldAdmitted,
);
const semanticSupports = semanticAttempts.flatMap((row) => row.supports);
const allSemanticSupportsSourceBound = semanticSupports.every(
  (support) =>
    support.sourceBound &&
    support.decision === "SUPPORTS" &&
    support.reason !== null,
);

const gates = {
  answerableRecallNonRegression: noRegression(
    candidate.answerableRecall,
    baseline.answerableRecall,
  ),
  admittedPrecisionNonRegression: noRegression(
    candidate.admittedPrecision,
    baseline.admittedPrecision,
  ),
  falseAcceptanceNonIncrease: noIncrease(
    candidate.falseAcceptanceRate,
    baseline.falseAcceptanceRate,
  ),
  wrongAdmissionQuestionsNonIncrease:
    candidate.questionsWithWrongAdmission <= baseline.questionsWithWrongAdmission,
  strictAccuracyNonRegression: noRegression(
    candidate.strictAccuracy,
    baseline.strictAccuracy,
  ),
  allSemanticSupportsSourceBound,
  readerInvokedOnlyAfterBaselineAbstention:
    semanticAttempts.every(
      (attempt) => !preservedBaselineQueries.has(attempt.query),
    ),
  readerInvokedOnlyWithSafeSlotProjection: semanticAttempts.every(
    (attempt) => attempt.slot !== null,
  ),
  baselineSupportedCasesPreserved: baselineRegressions.length === 0,
  correctGoldRescuePresent: correctGoldRescues.length > 0,
  runtimeUnchanged: protocol.protocol.runtimeChanged === false,
  productionAdmissionUnchanged:
    protocol.protocol.productionAdmissionChanged === false,
};

const frontierPass =
  gates.answerableRecallNonRegression &&
  gates.admittedPrecisionNonRegression &&
  gates.falseAcceptanceNonIncrease &&
  gates.wrongAdmissionQuestionsNonIncrease &&
  gates.strictAccuracyNonRegression &&
  gates.allSemanticSupportsSourceBound &&
  gates.readerInvokedOnlyAfterBaselineAbstention &&
  gates.readerInvokedOnlyWithSafeSlotProjection &&
  gates.baselineSupportedCasesPreserved &&
  newFalseAcceptances.length === 0 &&
  newWrongAdmissions.length === 0;

const invariantPass =
  gates.runtimeUnchanged &&
  gates.productionAdmissionUnchanged &&
  gates.readerInvokedOnlyAfterBaselineAbstention &&
  gates.readerInvokedOnlyWithSafeSlotProjection &&
  gates.baselineSupportedCasesPreserved &&
  gates.allSemanticSupportsSourceBound;

const outcome = !invariantPass
  ? "INVALID_EXPERIMENT"
  : frontierPass && gates.correctGoldRescuePresent
    ? "PROCEED_TO_FRESH_HOLDOUT"
    : "REJECT_DEVELOPMENT_FRONTIER";

if (!protocol.developmentGate.outcomes.includes(outcome)) {
  throw new Error("SEMANTIC_READER_FALLBACK_DEV_OUTCOME_NOT_PREDECLARED");
}

const report = {
  schemaVersion: protocol.schemaVersion,
  generatedAt: new Date().toISOString(),
  candidateCommit: currentCommit(),
  baselineSha: protocol.baselineSha,
  protocolHash: sha256(protocolRaw),
  sourceHashes,
  outcome,
  phase: protocol.protocol.phase,
  heldoutEvaluated: false,
  model: protocol.model,
  verifierId: verifier.id,
  readerReceivesRequestedAnswerSlot: false,
  slotUsedAsEvidenceAuthority: false,
  runtimeChanged: false,
  productionAdmissionChanged: false,
  baseline,
  candidate,
  gates,
  counts: {
    developmentCases: cases.length,
    preservedBaselineQueries: preservedBaselineQueries.size,
    slotRejectedQueries: slotRejectedQueries.size,
    semanticReaderInvocations: semanticAttempts.length,
    semanticSupports: semanticSupports.length,
    correctGoldRescues: correctGoldRescues.length,
    newFalseAcceptances: newFalseAcceptances.length,
    newWrongAdmissions: newWrongAdmissions.length,
  },
  correctGoldRescues,
  newFalseAcceptances,
  newWrongAdmissions,
  changes,
  semanticAttempts,
  claimBoundary: [
    "Development feasibility only; no heldout partition was loaded or evaluated.",
    "RequestedAnswerSlot gates reader invocation only and is not passed into the reader prompt.",
    "Existing deterministic support is preserved unchanged by construction.",
    "Every newly admitted semantic support must be source-bound to an exact visible span.",
    "PROCEED_TO_FRESH_HOLDOUT only authorizes creation of a new frozen family-disjoint holdout; it does not change runtime/defaults.",
    "Existing #68/#70/#71/#90 heldouts are not reused for tuning or promotion.",
  ],
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify(report, null, 2) + "\n");

if (!invariantPass) process.exitCode = 1;
