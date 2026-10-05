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
    retiredAuthority: string[];
    qaUsedAsSpanProposalOnly: true;
    qaDecisionUsedAsAuthority: false;
    nliUsesManualRelationHypotheses: false;
    candidateCanCreateSupport: false;
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
  baselineReason: string;
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
  preservedCandidateKeys: string[];
  retiredCandidateKeys: string[];
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
  "evals/generic/qa-nli-passage-authority-veto-dev/manifest.json",
);
const outputPath = path.resolve(
  process.env.AKP_QA_NLI_PASSAGE_VETO_DEV_REPORT ??
    "reports/ci/qa-nli-passage-authority-veto-dev.json",
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
        if (!unit) throw new Error("PASSAGE_VETO_UNKNOWN_CANDIDATE_KEY:" + key);
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

function questionLanguage(language: string): "EN" | "ES" {
  return language.toLowerCase().startsWith("es") ? "ES" : "EN";
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
  const revalidated = row.semanticCandidates
    .filter(
      (candidate) =>
        candidate.entailmentTopClass &&
        candidate.sourceBound &&
        candidate.entailmentScore >= boundary.entailmentThreshold &&
        candidate.margin >= boundary.minimumMargin,
    )
    .map((candidate) => candidate.candidateKey);
  return [...new Set([...row.preservedCandidateKeys, ...revalidated])];
}

function boundaryMetrics(
  measurements: readonly CaseMeasurement[],
  baselineSummary: Summary,
  boundary: Boundary,
) {
  const candidateSummary = summarize(measurements, (row) =>
    unitsForKeys(row.entry, acceptedKeys(row, boundary)),
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
    candidateAdmissionsSubsetOfBaseline: candidateCreatedAdmissions.length === 0,
    baselineGoldPreserved: baselineRegressions.length === 0,
    measuredPrecisionAdvantage:
      removedFalseAcceptances.length > 0 || removedWrongAdmissions.length > 0,
  };

  return {
    boundary,
    candidateSummary,
    changes,
    removedFalseAcceptances,
    removedWrongAdmissions,
    baselineRegressions,
    candidateCreatedAdmissions,
    gates,
    frontierPass:
      gates.answerableRecallNonRegression &&
      gates.admittedPrecisionNonRegression &&
      gates.falseAcceptanceNonIncrease &&
      gates.wrongAdmissionQuestionsNonIncrease &&
      gates.strictAccuracyNonRegression &&
      gates.candidateAdmissionsSubsetOfBaseline &&
      gates.baselineGoldPreserved &&
      gates.measuredPrecisionAdvantage,
  };
}

const protocolRaw = await readFile(protocolPath, "utf8");
const protocol = JSON.parse(protocolRaw) as ExperimentManifest;
if (
  protocol.schemaVersion !== "akp.qa-nli-passage-authority-veto-dev.v1" ||
  protocol.frozen !== true ||
  protocol.protocol.phase !== "DEVELOPMENT_FEASIBILITY_ONLY" ||
  protocol.protocol.evaluatedSplit !== "development" ||
  protocol.protocol.heldoutEvaluated !== false ||
  protocol.protocol.retiredAuthority.join(",") !==
    "PASSAGE_TEXT_SUPPORT,PASSAGE_CUE_SUPPORT" ||
  protocol.protocol.qaUsedAsSpanProposalOnly !== true ||
  protocol.protocol.qaDecisionUsedAsAuthority !== false ||
  protocol.protocol.nliUsesManualRelationHypotheses !== false ||
  protocol.protocol.candidateCanCreateSupport !== false ||
  protocol.protocol.providerDefaultsChanged !== false ||
  protocol.protocol.runtimeChanged !== false ||
  protocol.protocol.productionAdmissionChanged !== false ||
  protocol.protocol.noTuningAgainstPriorHeldouts !== true ||
  protocol.developmentCalibration.holdoutAuthoredInThisWorker !== false ||
  protocol.qa.model !== LOCAL_MULTILINGUAL_QA_EVIDENCE_MODEL ||
  protocol.qa.revision !== LOCAL_MULTILINGUAL_QA_EVIDENCE_REVISION ||
  protocol.qa.maxAnswerTokens !== 15 ||
  protocol.nli.model !== LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR.model ||
  protocol.nli.revision !== LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR.revision ||
  protocol.nli.modelFileName !==
    LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR.modelFileName ||
  protocol.nli.dtype !== LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR.dtype
) {
  throw new Error("QA_NLI_PASSAGE_VETO_DEV_PROTOCOL_DRIFT");
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
  throw new Error("QA_NLI_PASSAGE_VETO_DEV_HELDOUT_LOADED");
}

const cacheDir = process.env.AKP_MODEL_CACHE_DIR?.trim() || undefined;
const qa = new LocalMultilingualQaEvidenceVerifier({
  minimumSupportScore: protocol.qa.proposalFloor,
  ...(cacheDir === undefined ? {} : { cacheDir }),
  localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
});
const nli = await defaultLocalMultilingualNliRuntimeFactory({
  model: protocol.nli.model,
  revision: protocol.nli.revision,
  modelFileName: protocol.nli.modelFileName,
  dtype: protocol.nli.dtype,
  ...(cacheDir === undefined ? {} : { cacheDir }),
  localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
});

const retiredAuthority = new Set(protocol.protocol.retiredAuthority);
const measurements: CaseMeasurement[] = [];
let qaAttempts = 0;

try {
  for (const entry of cases) {
    const query = entry.question.query;
    const baseline = assessRetrievalAnswerability(entry.hits, query);
    const baselineUnits = unitsForKeys(entry, baseline.supportedCandidateKeys);
    const signalByKey = new Map(
      baseline.candidateSignals.map((signal) => [signal.candidateKey, signal]),
    );
    const preservedCandidateKeys: string[] = [];
    const retiredCandidateKeys: string[] = [];
    const semanticCandidates: SemanticCandidate[] = [];

    for (const candidateKey of baseline.supportedCandidateKeys) {
      const signal = signalByKey.get(candidateKey);
      if (!signal) {
        throw new Error("QA_NLI_PASSAGE_VETO_SIGNAL_MISSING:" + candidateKey);
      }
      const reason = signal.passageSupport.reason;
      if (!retiredAuthority.has(reason)) {
        preservedCandidateKeys.push(candidateKey);
        continue;
      }

      retiredCandidateKeys.push(candidateKey);
      const hit = entry.hits.find(
        (candidate) => retrievalAnswerabilityCandidateKey(candidate) === candidateKey,
      );
      if (!hit) {
        throw new Error("QA_NLI_PASSAGE_VETO_HIT_MISSING:" + candidateKey);
      }

      qaAttempts += 1;
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
      const hypothesis = hypothesisFor(
        questionLanguage(entry.question.language),
        query,
        answer,
      );
      const distribution = await nli.infer(sentence.text, hypothesis);
      const competingScore = Math.max(
        distribution.neutral,
        distribution.contradiction,
      );
      const unit = entry.unitIdByCandidateKey.get(candidateKey);
      if (!unit) {
        throw new Error("QA_NLI_PASSAGE_VETO_UNIT_MISSING:" + candidateKey);
      }

      semanticCandidates.push({
        candidateKey,
        unit,
        baselineReason: reason,
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

    measurements.push({
      entry,
      baseline,
      baselineUnits,
      preservedCandidateKeys,
      retiredCandidateKeys,
      semanticCandidates,
    });
  }
} finally {
  await qa.dispose();
  await nli.dispose?.();
}

const baselineSummary = summarize(measurements, (row) => row.baselineUnits);
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
  ...new Set([0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99, ...observedEntailment]),
].sort((a, b) => b - a);
const marginThresholds = [
  ...new Set([0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, ...observedMargins]),
].sort((a, b) => b - a);

let selected: ReturnType<typeof boundaryMetrics> | null = null;
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

const allQaSpansSourceBound = measurements
  .flatMap((row) => row.semanticCandidates)
  .every((candidate) => candidate.sourceBound);
const allSemanticCandidatesFromRetiredAuthority = measurements
  .flatMap((row) => row.semanticCandidates)
  .every((candidate) => retiredAuthority.has(candidate.baselineReason));
const everyRetiredKeyWasBaselineSupported = measurements.every((row) =>
  row.retiredCandidateKeys.every((key) =>
    row.baseline.supportedCandidateKeys.includes(key),
  ),
);
const invariantPass =
  allQaSpansSourceBound &&
  allSemanticCandidatesFromRetiredAuthority &&
  everyRetiredKeyWasBaselineSupported &&
  protocol.protocol.candidateCanCreateSupport === false &&
  protocol.protocol.runtimeChanged === false &&
  protocol.protocol.productionAdmissionChanged === false;

const outcome = !invariantPass
  ? "INVALID_EXPERIMENT"
  : selected
    ? "PROCEED_TO_FRESH_HOLDOUT"
    : "REJECT_DEVELOPMENT_FRONTIER";

if (!protocol.developmentGate.outcomes.includes(outcome)) {
  throw new Error("QA_NLI_PASSAGE_VETO_DEV_OUTCOME_NOT_PREDECLARED");
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
  qa: protocol.qa,
  nli: protocol.nli,
  retiredAuthority: protocol.protocol.retiredAuthority,
  runtimeChanged: false,
  productionAdmissionChanged: false,
  candidateCanCreateSupport: false,
  baseline: baselineSummary,
  selectedBoundary: selected?.boundary ?? null,
  candidate: selected?.candidateSummary ?? null,
  gates: selected?.gates ?? null,
  counts: {
    developmentCases: cases.length,
    baselineSupportedQueries: measurements.filter((row) => row.baseline.supported)
      .length,
    baselineSupportedCandidates: measurements.reduce(
      (sum, row) => sum + row.baseline.supportedCandidateKeys.length,
      0,
    ),
    retiredAuthorityCandidates: measurements.reduce(
      (sum, row) => sum + row.retiredCandidateKeys.length,
      0,
    ),
    preservedNonPassageCandidates: measurements.reduce(
      (sum, row) => sum + row.preservedCandidateKeys.length,
      0,
    ),
    qaAttempts,
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
    evaluatedDevelopmentBoundaries: evaluatedBoundaries,
    removedFalseAcceptances: selected?.removedFalseAcceptances.length ?? 0,
    removedWrongAdmissions: selected?.removedWrongAdmissions.length ?? 0,
    baselineRegressions: selected?.baselineRegressions.length ?? 0,
  },
  invariants: {
    allQaSpansSourceBound,
    allSemanticCandidatesFromRetiredAuthority,
    everyRetiredKeyWasBaselineSupported,
    candidateAdmissionsSubsetOfBaseline:
      selected?.gates.candidateAdmissionsSubsetOfBaseline ?? true,
    qaUsedAsAuthority: false,
    manualRelationHypothesesUsed: false,
    generativeReaderUsed: false,
    runtimeChanged: false,
    productionAdmissionChanged: false,
  },
  selectedChanges: selected?.changes ?? [],
  semanticMeasurements: measurements.map((row) => ({
    id: row.entry.question.id,
    domain: row.entry.domain.id,
    language: row.entry.question.language,
    baselineUnits: row.baselineUnits,
    preservedCandidateKeys: row.preservedCandidateKeys,
    retiredCandidateKeys: row.retiredCandidateKeys,
    candidates: row.semanticCandidates,
  })),
  claimBoundary: [
    "Development feasibility only; no heldout partition was loaded or evaluated.",
    "The candidate is subset-only: QA/NLI can confirm or remove legacy PASSAGE_* admissions but can never create support.",
    "QA proposes an exact visible source span only; QA score/decision is not admission authority.",
    "NLI receives one generic question-plus-answer hypothesis and no manually generated relation/polarity hypothesis.",
    "PROCEED_TO_FRESH_HOLDOUT only authorizes creation of a brand-new frozen family-disjoint holdout; it does not change runtime/defaults.",
    "Prior inspected holdouts are not reused for tuning or promotion.",
  ],
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify(report, null, 2) + "\n");

if (!invariantPass) process.exitCode = 1;
