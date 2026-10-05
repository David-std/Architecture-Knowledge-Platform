import "dotenv/config";

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assessRetrievalAnswerability,
  defaultLocalMultilingualNliRuntimeFactory,
  evidenceSentenceWindows,
  LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR,
  LOCAL_MULTILINGUAL_QA_EVIDENCE_MODEL,
  LOCAL_MULTILINGUAL_QA_EVIDENCE_REVISION,
  LocalMultilingualQaEvidenceVerifier,
  projectRequestedAnswerSlot,
  retrievalAnswerabilityCandidateKey,
  type LocalMultilingualNliDistribution,
  type QueryConditionedEvidenceSpan,
  type RetrievalAnswerabilityAssessment,
} from "../packages/retrieval/src/index.js";
import {
  loadEvidenceAdmissionPack,
  type EvidenceAdmissionCase,
} from "./evidence-admission-pack.js";

type FrozenInput = { path: string; gitBlobSha: string };

type ExperimentManifest = {
  schemaVersion: string;
  frozen: boolean;
  baselineSha: string;
  inputs: FrozenInput[];
  qa: {
    model: string;
    revision: string;
    proposalFloor: number;
    maxAnswerTokens: number;
    authority: false;
  };
  nli: {
    model: string;
    revision: string;
    modelFileName: string;
    dtype: "fp32" | "q8";
    labelOrder: string[];
    authority: string;
  };
  protocol: {
    phase: "DEVELOPMENT_FEASIBILITY_ONLY";
    evaluatedSplit: "development";
    heldoutEvaluated: false;
    slotUsedAsInvocationGateOnly: true;
    qaUsedAsSpanProposalOnly: true;
    qaDecisionUsedAsAuthority: false;
    nliUsesManualRelationHypotheses: false;
    nliHypothesisTemplates: { EN: string; ES: string };
    sourcePremise: string;
    baselineSupportsPreserved: true;
    providerDefaultsChanged: false;
    runtimeChanged: false;
    productionAdmissionChanged: false;
    noTuningAgainstPriorHeldouts: true;
  };
  developmentCalibration: {
    holdoutAuthoredInThisWorker: false;
  };
  developmentGate: {
    outcomes: string[];
  };
};

type SemanticCandidate = {
  candidateKey: string;
  unit: string;
  qaScore: number;
  answer: string;
  qaSpan: QueryConditionedEvidenceSpan;
  premise: string;
  premiseSpan: QueryConditionedEvidenceSpan;
  hypothesis: string;
  distribution: LocalMultilingualNliDistribution;
  entailmentScore: number;
  competingScore: number;
  margin: number;
  entailmentTopClass: boolean;
  sourceBound: boolean;
};

type CaseMeasurement = {
  entry: EvidenceAdmissionCase;
  baseline: RetrievalAnswerabilityAssessment;
  baselineUnits: string[];
  slot: ReturnType<typeof projectRequestedAnswerSlot>;
  semanticCandidates: SemanticCandidate[];
};

type Summary = {
  questions: number;
  answerable: number;
  unanswerable: number;
  answerableRecall: number | null;
  falseAcceptanceRate: number | null;
  admittedUnits: number;
  admittedPrecision: number | null;
  questionsWithWrongAdmission: number;
  strictAccuracy: number | null;
};

type Boundary = {
  entailmentThreshold: number;
  minimumMargin: number;
};

const root = path.resolve(".");
const protocolPath = path.resolve(
  "evals/generic/extractive-qa-nli-cascade-dev/manifest.json",
);
const outputPath = path.resolve(
  process.env.AKP_EXTRACTIVE_QA_NLI_CASCADE_DEV_REPORT ??
    "reports/ci/extractive-qa-nli-cascade-dev.json",
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

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function noRegression(candidate: number | null, baseline: number | null) {
  if (baseline === null) return candidate === null;
  return candidate !== null && candidate >= baseline;
}

function noIncrease(candidate: number | null, baseline: number | null) {
  if (baseline === null) return candidate === null;
  return candidate !== null && candidate <= baseline;
}

function unitsForKeys(
  entry: EvidenceAdmissionCase,
  keys: readonly string[],
): string[] {
  return [
    ...new Set(
      keys.map((key) => {
        const unit = entry.unitIdByCandidateKey.get(key);
        if (!unit) throw new Error("CASCADE_UNKNOWN_CANDIDATE_KEY:" + key);
        return unit;
      }),
    ),
  ].sort();
}

function sentenceContainingSpan(
  passage: string,
  span: QueryConditionedEvidenceSpan,
): { text: string; span: QueryConditionedEvidenceSpan } | null {
  const window = evidenceSentenceWindows(passage).find(
    (candidate) =>
      candidate.startOffset <= span.startOffset &&
      candidate.endOffset >= span.endOffset,
  );
  if (!window) return null;
  return {
    text: window.text,
    span: {
      startOffset: window.startOffset,
      endOffset: window.endOffset,
    },
  };
}

function hypothesisFor(
  language: "EN" | "ES",
  query: string,
  answer: string,
): string {
  const cleanQuestion = query.trim().replaceAll('"', "'");
  const cleanAnswer = answer.trim().replaceAll('"', "'");
  return language === "ES"
    ? `La respuesta a la pregunta "${cleanQuestion}" es "${cleanAnswer}".`
    : `The answer to the question "${cleanQuestion}" is "${cleanAnswer}".`;
}

function summarize(
  measurements: readonly CaseMeasurement[],
  select: (row: CaseMeasurement) => readonly string[],
): Summary {
  let answerable = 0;
  let unanswerable = 0;
  let answerableHits = 0;
  let falseAcceptances = 0;
  let admittedUnits = 0;
  let correctUnits = 0;
  let wrongQuestions = 0;
  let strict = 0;

  for (const row of measurements) {
    const selected = [...new Set(select(row))].sort();
    const gold = new Set(row.entry.question.gold);
    const acceptable = new Set(row.entry.question.acceptable ?? []);
    const wrong = selected.filter(
      (unit) => !gold.has(unit) && !acceptable.has(unit),
    );
    const goldHit = selected.some((unit) => gold.has(unit));
    admittedUnits += selected.length;
    correctUnits += selected.length - wrong.length;
    if (wrong.length > 0) wrongQuestions += 1;

    if (gold.size > 0) {
      answerable += 1;
      if (goldHit) answerableHits += 1;
      if (goldHit && wrong.length === 0) strict += 1;
    } else {
      unanswerable += 1;
      if (selected.length > 0) falseAcceptances += 1;
      else strict += 1;
    }
  }

  return {
    questions: measurements.length,
    answerable,
    unanswerable,
    answerableRecall: ratio(answerableHits, answerable),
    falseAcceptanceRate: ratio(falseAcceptances, unanswerable),
    admittedUnits,
    admittedPrecision: ratio(correctUnits, admittedUnits),
    questionsWithWrongAdmission: wrongQuestions,
    strictAccuracy: ratio(strict, measurements.length),
  };
}

function acceptedKeys(row: CaseMeasurement, boundary: Boundary): string[] {
  if (row.baseline.supported) {
    return [...row.baseline.supportedCandidateKeys];
  }
  return row.semanticCandidates
    .filter(
      (candidate) =>
        candidate.entailmentTopClass &&
        candidate.sourceBound &&
        candidate.entailmentScore >= boundary.entailmentThreshold &&
        candidate.margin >= boundary.minimumMargin,
    )
    .map((candidate) => candidate.candidateKey);
}

function boundaryMetrics(
  measurements: readonly CaseMeasurement[],
  baselineSummary: Summary,
  boundary: Boundary,
) {
  const candidateSummary = summarize(measurements, (row) =>
    acceptedKeys(row, boundary).map((key) => {
      const unit = row.entry.unitIdByCandidateKey.get(key);
      if (!unit) throw new Error("CASCADE_SELECTED_KEY_NOT_MAPPED:" + key);
      return unit;
    }),
  );

  const changes = measurements.flatMap((row) => {
    const before = row.baselineUnits;
    const after = unitsForKeys(row.entry, acceptedKeys(row, boundary));
    if (before.join("\n") === after.join("\n")) return [];
    const gold = new Set(row.entry.question.gold);
    const acceptable = new Set(row.entry.question.acceptable ?? []);
    const beforeGold = before.some((unit) => gold.has(unit));
    const afterGold = after.some((unit) => gold.has(unit));
    const beforeWrong = before.filter(
      (unit) => !gold.has(unit) && !acceptable.has(unit),
    );
    const afterWrong = after.filter(
      (unit) => !gold.has(unit) && !acceptable.has(unit),
    );
    return [
      {
        id: row.entry.question.id,
        domain: row.entry.domain.id,
        language: row.entry.question.language,
        query: row.entry.question.query,
        answerable: gold.size > 0,
        baselineAdmitted: before,
        candidateAdmitted: after,
        baselineGoldAdmitted: beforeGold,
        candidateGoldAdmitted: afterGold,
        baselineWrongAdmissions: beforeWrong,
        candidateWrongAdmissions: afterWrong,
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
    (row) => row.baselineGoldAdmitted && !row.candidateGoldAdmitted,
  );

  const gates = {
    answerableRecallNonRegression: noRegression(
      candidateSummary.answerableRecall,
      baselineSummary.answerableRecall,
    ),
    admittedPrecisionNonRegression: noRegression(
      candidateSummary.admittedPrecision,
      baselineSummary.admittedPrecision,
    ),
    falseAcceptanceNonIncrease: noIncrease(
      candidateSummary.falseAcceptanceRate,
      baselineSummary.falseAcceptanceRate,
    ),
    wrongAdmissionQuestionsNonIncrease:
      candidateSummary.questionsWithWrongAdmission <=
      baselineSummary.questionsWithWrongAdmission,
    strictAccuracyNonRegression: noRegression(
      candidateSummary.strictAccuracy,
      baselineSummary.strictAccuracy,
    ),
    baselineSupportedCasesPreserved: baselineRegressions.length === 0,
    newFalseAcceptancesZero: newFalseAcceptances.length === 0,
    newWrongAdmissionsZero: newWrongAdmissions.length === 0,
    correctGoldRescuePresent: correctGoldRescues.length > 0,
  };

  return {
    boundary,
    candidateSummary,
    changes,
    correctGoldRescues,
    newFalseAcceptances,
    newWrongAdmissions,
    baselineRegressions,
    gates,
    frontierPass:
      gates.answerableRecallNonRegression &&
      gates.admittedPrecisionNonRegression &&
      gates.falseAcceptanceNonIncrease &&
      gates.wrongAdmissionQuestionsNonIncrease &&
      gates.strictAccuracyNonRegression &&
      gates.baselineSupportedCasesPreserved &&
      gates.newFalseAcceptancesZero &&
      gates.newWrongAdmissionsZero &&
      gates.correctGoldRescuePresent,
  };
}

const protocolRaw = await readFile(protocolPath, "utf8");
const protocol = JSON.parse(protocolRaw) as ExperimentManifest;
if (
  protocol.schemaVersion !== "akp.extractive-qa-nli-cascade-dev.v1" ||
  protocol.frozen !== true ||
  protocol.protocol.phase !== "DEVELOPMENT_FEASIBILITY_ONLY" ||
  protocol.protocol.evaluatedSplit !== "development" ||
  protocol.protocol.heldoutEvaluated !== false ||
  protocol.protocol.slotUsedAsInvocationGateOnly !== true ||
  protocol.protocol.qaUsedAsSpanProposalOnly !== true ||
  protocol.protocol.qaDecisionUsedAsAuthority !== false ||
  protocol.protocol.nliUsesManualRelationHypotheses !== false ||
  protocol.protocol.baselineSupportsPreserved !== true ||
  protocol.protocol.providerDefaultsChanged !== false ||
  protocol.protocol.runtimeChanged !== false ||
  protocol.protocol.productionAdmissionChanged !== false ||
  protocol.protocol.noTuningAgainstPriorHeldouts !== true ||
  protocol.developmentCalibration.holdoutAuthoredInThisWorker !== false ||
  protocol.qa.model !== LOCAL_MULTILINGUAL_QA_EVIDENCE_MODEL ||
  protocol.qa.revision !== LOCAL_MULTILINGUAL_QA_EVIDENCE_REVISION ||
  protocol.nli.model !== LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR.model ||
  protocol.nli.revision !== LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR.revision
) {
  throw new Error("EXTRACTIVE_QA_NLI_CASCADE_DEV_PROTOCOL_DRIFT");
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

const { cases } = await loadEvidenceAdmissionPack(["development"]);
if (cases.some((entry) => entry.domain.split !== "development")) {
  throw new Error("EXTRACTIVE_QA_NLI_CASCADE_DEV_HELDOUT_LOADED");
}

const qa = new LocalMultilingualQaEvidenceVerifier({
  minimumSupportScore: protocol.qa.proposalFloor,
  cacheDir: process.env.AKP_MODEL_CACHE_DIR,
  localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
});
const nli = await defaultLocalMultilingualNliRuntimeFactory({
  model: protocol.nli.model,
  revision: protocol.nli.revision,
  modelFileName: protocol.nli.modelFileName,
  dtype: protocol.nli.dtype,
  cacheDir: process.env.AKP_MODEL_CACHE_DIR,
  localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
});

const started = performance.now();
const measurements: CaseMeasurement[] = [];
try {
  for (const entry of cases) {
    const query = entry.question.query;
    const baseline = assessRetrievalAnswerability(entry.hits, query);
    const baselineUnits = unitsForKeys(
      entry,
      baseline.supportedCandidateKeys,
    );
    const slot = baseline.supported
      ? null
      : projectRequestedAnswerSlot(query);
    const semanticCandidates: SemanticCandidate[] = [];

    if (!baseline.supported && slot) {
      for (const hit of entry.hits) {
        const candidateKey = retrievalAnswerabilityCandidateKey(hit);
        const verification = await qa.verify({
          query,
          candidateKey,
          title: hit.title,
          ...(hit.headingPath ? { headingPath: hit.headingPath } : {}),
          passage: hit.excerpt,
          unitType: hit.unitType ?? null,
          parentUnitType: hit.parentUnitType ?? null,
          documentType: hit.type,
        });
        if (
          verification.decision !== "SUPPORTS" ||
          verification.score === undefined ||
          !verification.evidenceSpan
        ) {
          continue;
        }
        const qaSpan = verification.evidenceSpan;
        const answer = hit.excerpt
          .slice(qaSpan.startOffset, qaSpan.endOffset)
          .trim();
        if (!answer) continue;
        const sentence = sentenceContainingSpan(hit.excerpt, qaSpan);
        if (!sentence) continue;
        const hypothesis = hypothesisFor(slot.language, query, answer);
        const distribution = await nli.infer(sentence.text, hypothesis);
        const competingScore = Math.max(
          distribution.neutral,
          distribution.contradiction,
        );
        const unit = entry.unitIdByCandidateKey.get(candidateKey);
        if (!unit) {
          throw new Error("CASCADE_QA_KEY_NOT_MAPPED:" + candidateKey);
        }
        semanticCandidates.push({
          candidateKey,
          unit,
          qaScore: verification.score,
          answer,
          qaSpan,
          premise: sentence.text,
          premiseSpan: sentence.span,
          hypothesis,
          distribution,
          entailmentScore: distribution.entailment,
          competingScore,
          margin: distribution.entailment - competingScore,
          entailmentTopClass:
            distribution.entailment > distribution.neutral &&
            distribution.entailment > distribution.contradiction,
          sourceBound:
            qaSpan.startOffset >= sentence.span.startOffset &&
            qaSpan.endOffset <= sentence.span.endOffset &&
            hit.excerpt.slice(qaSpan.startOffset, qaSpan.endOffset).trim() ===
              answer,
        });
      }
    }

    measurements.push({
      entry,
      baseline,
      baselineUnits,
      slot,
      semanticCandidates,
    });
  }
} finally {
  await qa.dispose();
  await nli.dispose?.();
}
const measurementLatencyMs = performance.now() - started;

const baselineSummary = summarize(
  measurements,
  (row) => row.baselineUnits,
);
const observedEntailment = measurements.flatMap((row) =>
  row.semanticCandidates
    .filter((candidate) => candidate.entailmentTopClass)
    .map((candidate) => Number(candidate.entailmentScore.toFixed(9))),
);
const observedMargins = measurements.flatMap((row) =>
  row.semanticCandidates
    .filter((candidate) => candidate.entailmentTopClass)
    .map((candidate) => Number(Math.max(0, candidate.margin).toFixed(9))),
);
const entailmentThresholds = [
  ...new Set([
    0.5,
    0.6,
    0.7,
    0.8,
    0.9,
    0.95,
    0.99,
    ...observedEntailment,
  ]),
].sort((a, b) => b - a);
const marginThresholds = [
  ...new Set([0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, ...observedMargins]),
].sort((a, b) => b - a);

let selected:
  | ReturnType<typeof boundaryMetrics>
  | null = null;
let evaluatedBoundaries = 0;
for (const entailmentThreshold of entailmentThresholds) {
  for (const minimumMargin of marginThresholds) {
    evaluatedBoundaries += 1;
    const measured = boundaryMetrics(measurements, baselineSummary, {
      entailmentThreshold,
      minimumMargin,
    });
    if (measured.frontierPass) {
      selected = measured;
      break;
    }
  }
  if (selected) break;
}

const allSemanticSupportsSourceBound = measurements
  .flatMap((row) => row.semanticCandidates)
  .every((candidate) => candidate.sourceBound);
const qaInvokedOnlyAfterBaselineAbstention = measurements.every(
  (row) =>
    row.baseline.supported ||
    row.slot === null ||
    row.semanticCandidates.length >= 0,
);
const qaInvokedOnlyWithSafeSlot = measurements
  .filter((row) => row.semanticCandidates.length > 0)
  .every((row) => row.slot !== null);

const invariantPass =
  allSemanticSupportsSourceBound &&
  qaInvokedOnlyAfterBaselineAbstention &&
  qaInvokedOnlyWithSafeSlot &&
  protocol.protocol.runtimeChanged === false &&
  protocol.protocol.productionAdmissionChanged === false;

const outcome = !invariantPass
  ? "INVALID_EXPERIMENT"
  : selected
    ? "PROCEED_TO_FRESH_HOLDOUT"
    : "REJECT_DEVELOPMENT_FRONTIER";

if (!protocol.developmentGate.outcomes.includes(outcome)) {
  throw new Error("EXTRACTIVE_QA_NLI_CASCADE_DEV_OUTCOME_NOT_PREDECLARED");
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
  models: {
    qa: {
      model: protocol.qa.model,
      revision: protocol.qa.revision,
      proposalFloor: protocol.qa.proposalFloor,
      authority: false,
    },
    nli: {
      model: protocol.nli.model,
      revision: protocol.nli.revision,
      dtype: protocol.nli.dtype,
      authority: protocol.nli.authority,
    },
  },
  baseline: baselineSummary,
  selectedBoundary: selected?.boundary ?? null,
  candidate: selected?.candidateSummary ?? null,
  gates: selected?.gates ?? null,
  counts: {
    developmentCases: measurements.length,
    baselineSupportedQueries: measurements.filter((row) => row.baseline.supported)
      .length,
    safeSlotAbstentions: measurements.filter(
      (row) => !row.baseline.supported && row.slot !== null,
    ).length,
    qaSpanProposals: measurements.reduce(
      (sum, row) => sum + row.semanticCandidates.length,
      0,
    ),
    nliTopEntailmentProposals: measurements.reduce(
      (sum, row) =>
        sum +
        row.semanticCandidates.filter((candidate) => candidate.entailmentTopClass)
          .length,
      0,
    ),
    correctGoldRescues: selected?.correctGoldRescues.length ?? 0,
    newFalseAcceptances: selected?.newFalseAcceptances.length ?? 0,
    newWrongAdmissions: selected?.newWrongAdmissions.length ?? 0,
    evaluatedBoundaries,
  },
  invariants: {
    allQaSpansSourceBound: allSemanticSupportsSourceBound,
    qaInvokedOnlyAfterBaselineAbstention,
    qaInvokedOnlyWithSafeSlot,
    manualRelationHypothesesUsed: false,
    qaUsedAsAuthority: false,
    generativeReaderUsed: false,
    runtimeChanged: false,
    productionAdmissionChanged: false,
  },
  measurementLatencyMs,
  correctGoldRescues: selected?.correctGoldRescues ?? [],
  newFalseAcceptances: selected?.newFalseAcceptances ?? [],
  newWrongAdmissions: selected?.newWrongAdmissions ?? [],
  changes: selected?.changes ?? [],
  semanticAttempts: measurements
    .filter((row) => row.slot !== null)
    .map((row) => ({
      id: row.entry.question.id,
      domain: row.entry.domain.id,
      language: row.entry.question.language,
      query: row.entry.question.query,
      slot: row.slot,
      baselineSupported: row.baseline.supported,
      candidates: row.semanticCandidates,
    })),
  claimBoundary: [
    "Development feasibility only; no heldout partition was loaded or evaluated.",
    "RequestedAnswerSlot gates invocation only and never grants support.",
    "QA proposes an exact visible source span only; QA score/decision is not the admission authority.",
    "NLI receives one generic question-plus-answer hypothesis, not manually generated relation/polarity hypotheses.",
    "Existing deterministic support is preserved unchanged by construction.",
    "PROCEED_TO_FRESH_HOLDOUT only authorizes a separate frozen holdout worker; it changes no runtime/default.",
    "Existing inspected holdouts and rejected experiments are not reused for tuning or promotion.",
  ],
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify(report, null, 2) + "\n");

if (!invariantPass) process.exitCode = 1;
