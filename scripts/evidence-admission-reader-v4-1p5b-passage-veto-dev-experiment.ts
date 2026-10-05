import "dotenv/config";

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assessRetrievalAnswerability,
  assessRetrievalAnswerabilityWithVerifier,
  EVIDENCE_READER_PROMPT_VERSION,
  OpenAICompatibleEvidenceReader,
  ReaderEvidenceVerifier,
  retrievalAnswerabilityCandidateKey,
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
  reader: {
    promptVersion: string;
    model: string;
    revision: string;
    dtype: string;
    temperature: number;
    maxOutputTokens: number;
    shortlist: false;
    authority: string;
  };
  protocol: {
    phase: "DEVELOPMENT_FEASIBILITY_ONLY";
    evaluatedSplit: "development";
    heldoutEvaluated: false;
    retiredAuthority: string[];
    readerCanCreateSupport: false;
    readerReceivesOnlyRetiredBaselineCandidates: true;
    providerDefaultsChanged: false;
    runtimeChanged: false;
    productionAdmissionChanged: false;
    noTuningAgainstPriorHeldouts: true;
  };
  developmentGate: { outcomes: string[] };
};

const root = path.resolve(".");
const protocolPath = path.resolve(
  "evals/generic/reader-v4-1p5b-passage-veto-dev/manifest.json",
);
const outputPath = path.resolve(
  process.env.AKP_READER_1P5B_PASSAGE_VETO_DEV_REPORT ??
    "reports/ci/reader-v4-1p5b-passage-veto-dev.json",
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
  protocol.schemaVersion !== "akp.reader-v4-1p5b-passage-veto-dev.v1" ||
  protocol.frozen !== true ||
  protocol.protocol.phase !== "DEVELOPMENT_FEASIBILITY_ONLY" ||
  protocol.protocol.evaluatedSplit !== "development" ||
  protocol.protocol.heldoutEvaluated !== false ||
  protocol.protocol.retiredAuthority.join(",") !==
    "PASSAGE_TEXT_SUPPORT,PASSAGE_CUE_SUPPORT" ||
  protocol.protocol.readerCanCreateSupport !== false ||
  protocol.protocol.readerReceivesOnlyRetiredBaselineCandidates !== true ||
  protocol.protocol.providerDefaultsChanged !== false ||
  protocol.protocol.runtimeChanged !== false ||
  protocol.protocol.productionAdmissionChanged !== false ||
  protocol.protocol.noTuningAgainstPriorHeldouts !== true ||
  protocol.reader.promptVersion !== EVIDENCE_READER_PROMPT_VERSION ||
  protocol.reader.shortlist !== false ||
  protocol.reader.temperature !== 0
) {
  throw new Error("READER_1P5B_PASSAGE_VETO_DEV_PROTOCOL_DRIFT");
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

const baseUrl = process.env.AKP_READER_1P5B_BASE_URL?.trim();
const model = process.env.AKP_READER_1P5B_MODEL?.trim();
const revision = process.env.AKP_READER_1P5B_MODEL_REVISION?.trim();
const dtype = process.env.AKP_READER_1P5B_DTYPE?.trim();
if (!baseUrl) throw new Error("READER_1P5B_BASE_URL_REQUIRED");
if (model !== protocol.reader.model) {
  throw new Error("READER_1P5B_MODEL_DRIFT");
}
if (revision !== protocol.reader.revision) {
  throw new Error("READER_1P5B_REVISION_DRIFT");
}
if (dtype !== protocol.reader.dtype) {
  throw new Error("READER_1P5B_DTYPE_DRIFT");
}

const { cases } = await loadEvidenceAdmissionPack(["development"]);
if (cases.some((entry) => entry.domain.split !== "development")) {
  throw new Error("READER_1P5B_PASSAGE_VETO_DEV_HELDOUT_LOADED");
}

const baselineResults = await evaluateEvidenceAdmission(
  cases,
  async (hits, query) =>
    assessRetrievalAnswerability(hits, query).supportedCandidateKeys,
);
const baseline = summarizeEvidenceAdmission(baselineResults);

const reader = new OpenAICompatibleEvidenceReader({
  baseUrl,
  model,
  maxOutputTokens: protocol.reader.maxOutputTokens,
  timeoutMs: 45_000,
  jsonResponseFormat: true,
});
const verifier = new ReaderEvidenceVerifier({
  reader,
  shortlistSize: 64,
  concurrency: 2,
});

const retiredAuthority = new Set(protocol.protocol.retiredAuthority);
let readerQueryInvocations = 0;
let readerCandidateInputs = 0;
const semanticSupports: Array<{
  query: string;
  candidateKey: string;
  decision: string | null;
  reason: string | null;
  sourceBound: boolean;
  startOffset: number | null;
  endOffset: number | null;
}> = [];

let candidateResults;
try {
  candidateResults = await evaluateEvidenceAdmission(
    cases,
    async (hits, query) => {
      const baselineAssessment = assessRetrievalAnswerability(hits, query);
      const signalByKey = new Map(
        baselineAssessment.candidateSignals.map((signal) => [
          signal.candidateKey,
          signal,
        ]),
      );

      const preservedKeys: string[] = [];
      const retiredKeys = new Set<string>();
      for (const key of baselineAssessment.supportedCandidateKeys) {
        const signal = signalByKey.get(key);
        if (!signal) {
          throw new Error("READER_1P5B_BASELINE_SIGNAL_MISSING:" + key);
        }
        if (retiredAuthority.has(signal.passageSupport.reason)) {
          retiredKeys.add(key);
        } else {
          preservedKeys.push(key);
        }
      }

      const retiredHits = hits.filter((hit) =>
        retiredKeys.has(retrievalAnswerabilityCandidateKey(hit)),
      );
      if (retiredHits.length === 0) return preservedKeys;

      readerQueryInvocations += 1;
      readerCandidateInputs += retiredHits.length;
      const semantic = await assessRetrievalAnswerabilityWithVerifier(
        retiredHits,
        query,
        verifier,
        {
          mode: "ENFORCE",
          maxCandidates: 64,
          maxConcurrency: 2,
        },
        {},
        { comparisonHits: retiredHits },
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

      return [
        ...new Set([...preservedKeys, ...semantic.supportedCandidateKeys]),
      ];
    },
  );
} finally {
  await verifier.dispose();
}

const candidate = summarizeEvidenceAdmission(candidateResults);
const baselineById = new Map(baselineResults.map((row) => [row.id, row]));
const changes = candidateResults.flatMap((row) => {
  const before = baselineById.get(row.id);
  if (!before) throw new Error("READER_1P5B_BASELINE_RESULT_MISSING:" + row.id);
  if (before.admitted.join("\n") === row.admitted.join("\n")) return [];
  return [
    {
      id: row.id,
      domain: row.domain,
      intent: row.intent,
      language: row.language,
      challenges: row.challenges,
      query: row.query,
      answerable: row.answerable,
      baselineAdmitted: before.admitted,
      candidateAdmitted: row.admitted,
      baselineGoldAdmitted: before.goldAdmitted,
      candidateGoldAdmitted: row.goldAdmitted,
      baselineWrongAdmissions: before.wrongAdmissions,
      candidateWrongAdmissions: row.wrongAdmissions,
    },
  ];
});

const removedFalseAcceptances = changes.filter(
  (row) =>
    !row.answerable &&
    row.baselineAdmitted.length > 0 &&
    row.candidateAdmitted.length === 0,
);
const removedWrongAdmissions = changes.filter(
  (row) =>
    row.candidateWrongAdmissions.length < row.baselineWrongAdmissions.length,
);
const baselineRegressions = changes.filter(
  (row) => row.baselineGoldAdmitted && !row.candidateGoldAdmitted,
);
const candidateCreatedAdmissions = changes.filter((row) =>
  row.candidateAdmitted.some((unit) => !row.baselineAdmitted.includes(unit)),
);
const allSemanticSupportsSourceBound = semanticSupports.every(
  (support) =>
    support.sourceBound &&
    support.decision === "SUPPORTS" &&
    support.reason !== null,
);
const measuredPrecisionAdvantage =
  removedFalseAcceptances.length > 0 || removedWrongAdmissions.length > 0;

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
  candidateAdmissionsSubsetOfBaseline: candidateCreatedAdmissions.length === 0,
  baselineGoldPreserved: baselineRegressions.length === 0,
  allSemanticSupportsSourceBound,
  measuredPrecisionAdvantage,
};

const invariantPass =
  gates.candidateAdmissionsSubsetOfBaseline &&
  gates.allSemanticSupportsSourceBound &&
  protocol.protocol.readerCanCreateSupport === false &&
  protocol.protocol.readerReceivesOnlyRetiredBaselineCandidates === true &&
  protocol.protocol.runtimeChanged === false &&
  protocol.protocol.productionAdmissionChanged === false;

const frontierPass =
  invariantPass &&
  gates.answerableRecallNonRegression &&
  gates.admittedPrecisionNonRegression &&
  gates.falseAcceptanceNonIncrease &&
  gates.wrongAdmissionQuestionsNonIncrease &&
  gates.strictAccuracyNonRegression &&
  gates.baselineGoldPreserved &&
  gates.measuredPrecisionAdvantage;

const outcome = !invariantPass
  ? "INVALID_EXPERIMENT"
  : frontierPass
    ? "PROCEED_TO_FRESH_HOLDOUT"
    : "REJECT_DEVELOPMENT_FRONTIER";

if (!protocol.developmentGate.outcomes.includes(outcome)) {
  throw new Error("READER_1P5B_PASSAGE_VETO_DEV_OUTCOME_NOT_PREDECLARED");
}

const report = {
  schemaVersion: protocol.schemaVersion,
  generatedAt: new Date().toISOString(),
  candidateCommit: currentCommit(),
  baselineSha: protocol.baselineSha,
  protocolHash: sha256(protocolRaw),
  sourceHashes,
  outcome,
  heldoutEvaluated: false,
  reader: protocol.reader,
  verifierId: verifier.id,
  retiredAuthority: protocol.protocol.retiredAuthority,
  candidateCanCreateSupport: false,
  runtimeChanged: false,
  productionAdmissionChanged: false,
  baseline,
  candidate,
  gates,
  counts: {
    developmentCases: cases.length,
    readerQueryInvocations,
    readerCandidateInputs,
    semanticSupports: semanticSupports.length,
    removedFalseAcceptances: removedFalseAcceptances.length,
    removedWrongAdmissions: removedWrongAdmissions.length,
    baselineRegressions: baselineRegressions.length,
    candidateCreatedAdmissions: candidateCreatedAdmissions.length,
  },
  removedFalseAcceptances,
  removedWrongAdmissions,
  baselineRegressions,
  changes,
  semanticSupports,
  claimBoundary: [
    "Development feasibility only; no heldout partition was loaded or evaluated.",
    "The 1.5B reader receives only candidates already supported by legacy PASSAGE_TEXT_SUPPORT or PASSAGE_CUE_SUPPORT.",
    "The candidate is subset-only and cannot create support.",
    "Every retained reader support must remain source-bound to an exact visible span and pass existing hard source constraints.",
    "PROCEED_TO_FRESH_HOLDOUT only authorizes a new frozen family-disjoint holdout; it does not change runtime/defaults.",
    "Prior inspected holdouts are not reused for tuning or promotion.",
  ],
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify(report, null, 2) + "\n");

if (!invariantPass) process.exitCode = 1;
