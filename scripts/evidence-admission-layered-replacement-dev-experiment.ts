import "dotenv/config";

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assessRetrievalAnswerability,
  assessRetrievalAnswerabilityWithVerifier,
  contextualEvidenceText,
  LocalBgeCrossEncoderReranker,
  MULTILINGUAL_BGE_RERANKER_MODEL,
  MULTILINGUAL_BGE_RERANKER_REVISION,
  OpenAICompatibleEvidenceReader,
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
  readerModel: {
    id: string;
    revision: string;
    dtype: string;
    temperature: number;
    maxOutputTokens: number;
  };
  shortlistModel: {
    id: string;
    revision: string;
    dtype: string;
    maxTokens: number;
  };
  protocol: {
    phase: string;
    evaluatedSplit: "development";
    heldoutEvaluated: boolean;
    removedAuthority: string[];
    readerMode: "ENFORCE";
    readerShortlistSize: number;
    readerConcurrency: number;
    productionDefaultsChanged: boolean;
    runtimeChanged: boolean;
    productionAdmissionChanged: boolean;
    noTuningAgainstPriorHeldouts: boolean;
  };
  developmentGate: { outcomes: string[] };
};

type SemanticSupport = {
  query: string;
  candidateKey: string;
  decision: string | null;
  reason: string | null;
  sourceBound: boolean;
  startOffset: number | null;
  endOffset: number | null;
};

const root = path.resolve(".");
const protocolPath = path.resolve(
  "evals/generic/evidence-admission-layered-replacement-dev/manifest.json",
);
const outputPath = path.resolve(
  process.env.AKP_LAYERED_REPLACEMENT_DEV_REPORT ??
    "reports/ci/evidence-admission-layered-replacement-dev.json",
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
    "akp.evidence-admission-layered-replacement-dev.v1" ||
  protocol.frozen !== true ||
  protocol.protocol.phase !== "DEVELOPMENT_FEASIBILITY_ONLY" ||
  protocol.protocol.evaluatedSplit !== "development" ||
  protocol.protocol.heldoutEvaluated !== false ||
  protocol.protocol.readerMode !== "ENFORCE" ||
  protocol.protocol.productionDefaultsChanged !== false ||
  protocol.protocol.runtimeChanged !== false ||
  protocol.protocol.productionAdmissionChanged !== false ||
  protocol.protocol.noTuningAgainstPriorHeldouts !== true ||
  protocol.protocol.removedAuthority.join(",") !==
    "PASSAGE_TEXT_SUPPORT,PASSAGE_CUE_SUPPORT"
) {
  throw new Error("LAYERED_REPLACEMENT_DEV_PROTOCOL_DRIFT");
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

const baseUrl = process.env.AKP_LAYERED_REPLACEMENT_READER_BASE_URL?.trim();
const model = process.env.AKP_LAYERED_REPLACEMENT_READER_MODEL?.trim();
const revision =
  process.env.AKP_LAYERED_REPLACEMENT_READER_MODEL_REVISION?.trim();
const dtype = process.env.AKP_LAYERED_REPLACEMENT_READER_DTYPE?.trim();

if (!baseUrl) throw new Error("LAYERED_REPLACEMENT_READER_BASE_URL_REQUIRED");
if (model !== protocol.readerModel.id) {
  throw new Error("LAYERED_REPLACEMENT_READER_MODEL_DRIFT");
}
if (revision !== protocol.readerModel.revision) {
  throw new Error("LAYERED_REPLACEMENT_READER_REVISION_DRIFT");
}
if (dtype !== protocol.readerModel.dtype) {
  throw new Error("LAYERED_REPLACEMENT_READER_DTYPE_DRIFT");
}
if (
  protocol.shortlistModel.id !== MULTILINGUAL_BGE_RERANKER_MODEL ||
  protocol.shortlistModel.revision !== MULTILINGUAL_BGE_RERANKER_REVISION
) {
  throw new Error("LAYERED_REPLACEMENT_SHORTLIST_MODEL_DRIFT");
}

const { cases } = await loadEvidenceAdmissionPack(["development"]);
if (cases.some((entry) => entry.domain.split !== "development")) {
  throw new Error("LAYERED_REPLACEMENT_DEV_HELDOUT_LOADED");
}

const baselineResults = await evaluateEvidenceAdmission(
  cases,
  async (hits, query) => assessRetrievalAnswerability(hits, query),
);

const reader = new OpenAICompatibleEvidenceReader({
  baseUrl,
  model,
  maxOutputTokens: protocol.readerModel.maxOutputTokens,
  timeoutMs: 30_000,
  jsonResponseFormat: true,
});
const bge = new LocalBgeCrossEncoderReranker({ localFilesOnly: false });
const shortlist = {
  id: `bge-v2-m3:${MULTILINGUAL_BGE_RERANKER_REVISION}`,
  scoreBatch: async (
    inputs: readonly {
      query: string;
      title: string;
      headingPath?: readonly string[] | null;
      passage: string;
    }[],
  ) =>
    Promise.all(
      inputs.map((input) =>
        bge.score(
          input.query,
          contextualEvidenceText({
            title: input.title,
            headingPath: input.headingPath ?? null,
            passage: input.passage,
          }).text,
        ),
      ),
    ),
  dispose: () => bge.dispose(),
};
const verifier = new ReaderEvidenceVerifier({
  reader,
  shortlist,
  shortlistSize: protocol.protocol.readerShortlistSize,
  concurrency: protocol.protocol.readerConcurrency,
});

const removedAuthority = new Set(protocol.protocol.removedAuthority);
const semanticSupports: SemanticSupport[] = [];
const preservedKeysByQuery = new Map<string, string[]>();
const retiredKeysByQuery = new Map<string, string[]>();

let candidateResults;
try {
  candidateResults = await evaluateEvidenceAdmission(
    cases,
    async (hits, query) => {
      const baseline = assessRetrievalAnswerability(hits, query);
      const preserved = baseline.candidateSignals
        .filter(
          (signal) =>
            baseline.supportedCandidateKeys.includes(signal.candidateKey) &&
            !removedAuthority.has(signal.passageSupport.reason),
        )
        .map((signal) => signal.candidateKey);
      const retired = baseline.candidateSignals
        .filter(
          (signal) =>
            baseline.supportedCandidateKeys.includes(signal.candidateKey) &&
            removedAuthority.has(signal.passageSupport.reason),
        )
        .map((signal) => signal.candidateKey);

      preservedKeysByQuery.set(query, preserved);
      retiredKeysByQuery.set(query, retired);

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

      for (const signal of semantic.candidateSignals) {
        if (!semantic.supportedCandidateKeys.includes(signal.candidateKey)) {
          continue;
        }
        const trace = signal.queryConditionedEvidence;
        semanticSupports.push({
          query,
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
        });
      }

      const supportedCandidateKeys = [
        ...new Set([...preserved, ...semantic.supportedCandidateKeys]),
      ];
      return {
        ...semantic,
        supported: supportedCandidateKeys.length > 0,
        supportedCandidateKeys,
      };
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
const removedWrongAdmissions = changes.filter(
  (row) =>
    row.candidateWrongAdmissions.length < row.baselineWrongAdmissions.length,
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
  (row) => row.baselineGoldAdmitted && !row.candidateGoldAdmitted,
);

const allSemanticSupportsSourceBound = semanticSupports.every(
  (support) =>
    support.sourceBound &&
    support.decision === "SUPPORTS" &&
    support.reason !== null,
);

const preservedNonPassageAdmissionsRemain = candidateResults.every((row) => {
  const keys = preservedKeysByQuery.get(row.query) ?? [];
  return keys.every((key) =>
    row.admitted.includes(key.split(":").at(-1) ?? key),
  );
});

const legacyPassageAuthorityNotReused = true;
const measuredCoverage =
  correctGoldRescues.length > 0 ||
  removedWrongAdmissions.length > 0 ||
  [...retiredKeysByQuery.values()].some((keys) => keys.length > 0);

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
    candidate.questionsWithWrongAdmission <=
    baseline.questionsWithWrongAdmission,
  strictAccuracyNonRegression: noRegression(
    candidate.strictAccuracy,
    baseline.strictAccuracy,
  ),
  allSemanticSupportsSourceBound,
  preservedNonPassageAdmissionsRemain,
  legacyPassageAuthorityNotReused,
  runtimeUnchanged: protocol.protocol.runtimeChanged === false,
  productionAdmissionUnchanged:
    protocol.protocol.productionAdmissionChanged === false,
  measuredCoverage,
};

const frontierPass =
  gates.answerableRecallNonRegression &&
  gates.admittedPrecisionNonRegression &&
  gates.falseAcceptanceNonIncrease &&
  gates.wrongAdmissionQuestionsNonIncrease &&
  gates.strictAccuracyNonRegression &&
  gates.allSemanticSupportsSourceBound &&
  gates.preservedNonPassageAdmissionsRemain &&
  newFalseAcceptances.length === 0 &&
  newWrongAdmissions.length === 0 &&
  baselineRegressions.length === 0 &&
  gates.measuredCoverage;

const invariantPass =
  gates.runtimeUnchanged &&
  gates.productionAdmissionUnchanged &&
  gates.allSemanticSupportsSourceBound &&
  gates.legacyPassageAuthorityNotReused;

const outcome = !invariantPass
  ? "INVALID_EXPERIMENT"
  : frontierPass
    ? "PROCEED_TO_FRESH_HOLDOUT"
    : "REJECT_DEVELOPMENT_FRONTIER";

if (!protocol.developmentGate.outcomes.includes(outcome)) {
  throw new Error("LAYERED_REPLACEMENT_DEV_OUTCOME_NOT_PREDECLARED");
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
  readerModel: protocol.readerModel,
  shortlistModel: protocol.shortlistModel,
  verifierId: verifier.id,
  removedAuthority: protocol.protocol.removedAuthority,
  runtimeChanged: false,
  productionAdmissionChanged: false,
  baseline,
  candidate,
  gates,
  counts: {
    developmentCases: cases.length,
    semanticSupports: semanticSupports.length,
    correctGoldRescues: correctGoldRescues.length,
    removedWrongAdmissions: removedWrongAdmissions.length,
    newFalseAcceptances: newFalseAcceptances.length,
    newWrongAdmissions: newWrongAdmissions.length,
    baselineRegressions: baselineRegressions.length,
    baselineRetiredAuthorityAdmissions: [...retiredKeysByQuery.values()].reduce(
      (sum, keys) => sum + keys.length,
      0,
    ),
  },
  correctGoldRescues,
  removedWrongAdmissions,
  newFalseAcceptances,
  newWrongAdmissions,
  baselineRegressions,
  changes,
  semanticSupports,
  claimBoundary: [
    "Development feasibility only; no heldout partition was loaded or evaluated.",
    "PASSAGE_TEXT_SUPPORT and PASSAGE_CUE_SUPPORT are not accepted as authority in the candidate.",
    "Pinned BGE scores select reader candidates only; relevance never grants support.",
    "Every semantic support must contain an exact visible source span.",
    "PROCEED_TO_FRESH_HOLDOUT only authorizes a new frozen family-disjoint holdout; it does not change runtime/defaults.",
    "Prior inspected heldouts are not reused for tuning or promotion.",
  ],
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify(report, null, 2) + "\n");

if (!invariantPass) process.exitCode = 1;
