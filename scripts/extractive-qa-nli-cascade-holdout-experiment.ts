import "dotenv/config";

import type { SearchHit } from "@akp/contracts";
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

type FrozenInput = { path: string; gitBlobSha: string };

type PackUnit = {
  id: string;
  documentType: string;
  unitType: NonNullable<SearchHit["unitType"]>;
  title: string;
  headingPath: string[];
  text: string;
};

type PackQuestion = {
  id: string;
  family: string;
  intent: string;
  language: "en" | "es";
  query: string;
  gold: string[];
  acceptable?: string[];
  challenges: string[];
};

type PackDomain = {
  id: string;
  split: "heldout";
  language: "en" | "es";
  units: PackUnit[];
  questions: PackQuestion[];
};

type HoldoutCase = {
  domain: PackDomain;
  question: PackQuestion;
  hits: SearchHit[];
  unitIdByCandidateKey: Map<string, string>;
};

type ExperimentManifest = {
  schemaVersion: string;
  frozen: boolean;
  baselineSha: string;
  developmentEvidence: {
    pr: number;
    headSha: string;
    runId: number;
    artifactId: number;
    artifactSha256: string;
    outcome: "PROCEED_TO_FRESH_HOLDOUT";
    fixedBoundary: {
      entailmentThreshold: number;
      minimumMargin: number;
    };
  };
  inputs: FrozenInput[];
  developmentFamilySources: FrozenInput[];
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
    phase: "FRESH_FAMILY_DISJOINT_HOLDOUT";
    developmentLoadedForScoring: false;
    priorHeldoutsLoaded: false;
    noHoldoutCalibration: true;
    candidateComposition: string;
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
    noTuningAfterFirstObservation: true;
  };
  holdoutDesign: {
    domainIds: string[];
    expectedQuestions: number;
    expectedAnswerable: number;
    expectedUnanswerable: number;
    holdoutFamilies: string[];
    requireExactFamilyDisjointFromDevelopment: true;
    languages: string[];
    crossLingualCasesPresent: true;
  };
  holdoutGate: {
    outcomes: string[];
  };
  claimBoundary: string[];
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
  entry: HoldoutCase;
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

const root = path.resolve(".");
const protocolPath = path.resolve(
  "evals/generic/extractive-qa-nli-cascade-holdout/manifest.json",
);
const outputPath = path.resolve(
  process.env.AKP_EXTRACTIVE_QA_NLI_CASCADE_HOLDOUT_REPORT ??
    "reports/ci/extractive-qa-nli-cascade-holdout.json",
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

function stableUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function candidateOrder(question: PackQuestion, units: readonly PackUnit[]) {
  return [...units].sort((left, right) => {
    const a = createHash("sha256")
      .update(`${question.id}:${left.id}`)
      .digest("hex");
    const b = createHash("sha256")
      .update(`${question.id}:${right.id}`)
      .digest("hex");
    return a.localeCompare(b);
  });
}

function unitHit(domain: PackDomain, unit: PackUnit, rank: number): SearchHit {
  return {
    documentId: stableUuid(`${domain.id}/document/${unit.id}`),
    vaultId: stableUuid(`${domain.id}/vault`),
    unitId: stableUuid(`${domain.id}/unit/${unit.id}`),
    unitType: unit.unitType,
    structuralOrder: 2,
    headingPath: unit.headingPath,
    document: {
      externalId: unit.id,
      path: `${domain.id}/${unit.id}.md`,
      title: unit.title,
    },
    revision: `extractive-qa-nli-cascade-holdout/${domain.id}`,
    title: unit.title,
    type: unit.documentType,
    trust: "MACHINE_SUPPORTED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1 / rank,
    reasons: ["extractive-qa-nli-cascade-holdout"],
    fusionContributions: [
      {
        channel: "vector",
        rank,
        channelWeight: 1,
        rawScore: 0.5,
        reason: "vector:extractive-qa-nli-cascade-holdout",
      },
    ],
    excerpt: unit.text,
    citations: [],
  };
}

function validateDomain(domain: PackDomain): void {
  if (domain.split !== "heldout") {
    throw new Error("HOLDOUT_DOMAIN_WRONG_SPLIT:" + domain.id);
  }
  const unitIds = new Set(domain.units.map((unit) => unit.id));
  if (unitIds.size !== domain.units.length) {
    throw new Error("HOLDOUT_DUPLICATE_UNIT:" + domain.id);
  }
  const questionIds = new Set<string>();
  for (const question of domain.questions) {
    if (questionIds.has(question.id)) {
      throw new Error("HOLDOUT_DUPLICATE_QUESTION:" + question.id);
    }
    questionIds.add(question.id);
    for (const label of [...question.gold, ...(question.acceptable ?? [])]) {
      if (!unitIds.has(label)) {
        throw new Error("HOLDOUT_UNKNOWN_LABEL:" + question.id + ":" + label);
      }
    }
    if (question.gold.some((label) => question.acceptable?.includes(label))) {
      throw new Error("HOLDOUT_GOLD_ACCEPTABLE_OVERLAP:" + question.id);
    }
  }
}

async function loadHoldout(inputs: readonly FrozenInput[]) {
  const cases: HoldoutCase[] = [];
  const domains: PackDomain[] = [];
  const sourceHashes: Record<string, string> = {};

  for (const input of inputs) {
    const absolute = path.resolve(input.path);
    if (gitBlobSha(absolute) !== input.gitBlobSha) {
      throw new Error("FROZEN_HOLDOUT_INPUT_CHANGED:" + input.path);
    }
    const raw = await readFile(absolute, "utf8");
    sourceHashes[input.path] = sha256(raw);
    const domain = JSON.parse(raw) as PackDomain;
    validateDomain(domain);
    domains.push(domain);

    for (const question of domain.questions) {
      const hits = candidateOrder(question, domain.units).map((unit, index) =>
        unitHit(domain, unit, index + 1),
      );
      const unitIdByCandidateKey = new Map(
        hits.map((hit) => [
          retrievalAnswerabilityCandidateKey(hit),
          hit.document.externalId!,
        ]),
      );
      cases.push({ domain, question, hits, unitIdByCandidateKey });
    }
  }

  return { domains, cases, sourceHashes };
}

async function developmentFamilies(
  inputs: readonly FrozenInput[],
): Promise<{ families: Set<string>; sourceHashes: Record<string, string> }> {
  const families = new Set<string>();
  const sourceHashes: Record<string, string> = {};
  for (const input of inputs) {
    const absolute = path.resolve(input.path);
    if (gitBlobSha(absolute) !== input.gitBlobSha) {
      throw new Error("FROZEN_DEVELOPMENT_FAMILY_INPUT_CHANGED:" + input.path);
    }
    const raw = await readFile(absolute, "utf8");
    sourceHashes[input.path] = sha256(raw);
    const domain = JSON.parse(raw) as {
      questions?: Array<{ family?: string }>;
    };
    for (const question of domain.questions ?? []) {
      if (question.family) families.add(question.family);
    }
  }
  return { families, sourceHashes };
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

function unitsForKeys(entry: HoldoutCase, keys: readonly string[]): string[] {
  return [
    ...new Set(
      keys.map((key) => {
        const unit = entry.unitIdByCandidateKey.get(key);
        if (!unit) throw new Error("HOLDOUT_UNKNOWN_CANDIDATE_KEY:" + key);
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

function acceptedKeys(
  row: CaseMeasurement,
  boundary: { entailmentThreshold: number; minimumMargin: number },
): string[] {
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

const protocolRaw = await readFile(protocolPath, "utf8");
const protocol = JSON.parse(protocolRaw) as ExperimentManifest;

if (
  protocol.schemaVersion !== "akp.extractive-qa-nli-cascade-fresh-holdout.v1" ||
  protocol.frozen !== true ||
  protocol.protocol.phase !== "FRESH_FAMILY_DISJOINT_HOLDOUT" ||
  protocol.protocol.developmentLoadedForScoring !== false ||
  protocol.protocol.priorHeldoutsLoaded !== false ||
  protocol.protocol.noHoldoutCalibration !== true ||
  protocol.protocol.slotUsedAsInvocationGateOnly !== true ||
  protocol.protocol.qaUsedAsSpanProposalOnly !== true ||
  protocol.protocol.qaDecisionUsedAsAuthority !== false ||
  protocol.protocol.nliUsesManualRelationHypotheses !== false ||
  protocol.protocol.baselineSupportsPreserved !== true ||
  protocol.protocol.providerDefaultsChanged !== false ||
  protocol.protocol.runtimeChanged !== false ||
  protocol.protocol.productionAdmissionChanged !== false ||
  protocol.protocol.noTuningAfterFirstObservation !== true ||
  protocol.developmentEvidence.outcome !== "PROCEED_TO_FRESH_HOLDOUT" ||
  protocol.developmentEvidence.fixedBoundary.entailmentThreshold !==
    0.962513483 ||
  protocol.developmentEvidence.fixedBoundary.minimumMargin !== 0.927496071 ||
  protocol.qa.model !== LOCAL_MULTILINGUAL_QA_EVIDENCE_MODEL ||
  protocol.qa.revision !== LOCAL_MULTILINGUAL_QA_EVIDENCE_REVISION ||
  protocol.qa.maxAnswerTokens !== 15 ||
  protocol.nli.model !== LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR.model ||
  protocol.nli.revision !== LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR.revision ||
  protocol.nli.modelFileName !==
    LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR.modelFileName ||
  protocol.nli.dtype !== LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR.dtype
) {
  throw new Error("EXTRACTIVE_QA_NLI_CASCADE_HOLDOUT_PROTOCOL_DRIFT");
}

assertAncestor(protocol.baselineSha);

const { domains, cases, sourceHashes } = await loadHoldout(protocol.inputs);
const development = await developmentFamilies(
  protocol.developmentFamilySources,
);
Object.assign(sourceHashes, development.sourceHashes);

const holdoutFamilies = new Set(cases.map((entry) => entry.question.family));
const familyOverlap = [...holdoutFamilies]
  .filter((family) => development.families.has(family))
  .sort();
const declaredFamilies = [...protocol.holdoutDesign.holdoutFamilies].sort();
const actualFamilies = [...holdoutFamilies].sort();

const answerableCount = cases.filter(
  (entry) => entry.question.gold.length > 0,
).length;
const unanswerableCount = cases.length - answerableCount;
const domainIds = domains.map((domain) => domain.id).sort();
const declaredDomainIds = [...protocol.holdoutDesign.domainIds].sort();

if (
  cases.length !== protocol.holdoutDesign.expectedQuestions ||
  answerableCount !== protocol.holdoutDesign.expectedAnswerable ||
  unanswerableCount !== protocol.holdoutDesign.expectedUnanswerable ||
  JSON.stringify(domainIds) !== JSON.stringify(declaredDomainIds) ||
  JSON.stringify(actualFamilies) !== JSON.stringify(declaredFamilies) ||
  familyOverlap.length > 0
) {
  throw new Error("EXTRACTIVE_QA_NLI_CASCADE_HOLDOUT_DESIGN_DRIFT");
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

const measurements: CaseMeasurement[] = [];
const started = performance.now();
try {
  for (const entry of cases) {
    const query = entry.question.query;
    const baseline = assessRetrievalAnswerability(entry.hits, query);
    const baselineUnits = unitsForKeys(entry, baseline.supportedCandidateKeys);
    const slot = baseline.supported ? null : projectRequestedAnswerSlot(query);
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
          throw new Error("HOLDOUT_QA_KEY_NOT_MAPPED:" + candidateKey);
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

const boundary = protocol.developmentEvidence.fixedBoundary;
const baselineSummary = summarize(measurements, (row) => row.baselineUnits);
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
      family: row.entry.question.family,
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
};

const allQaSpansSourceBound = measurements
  .flatMap((row) => row.semanticCandidates)
  .every((candidate) => candidate.sourceBound);
const qaInvokedOnlyAfterBaselineAbstention = measurements
  .filter((row) => row.semanticCandidates.length > 0)
  .every((row) => !row.baseline.supported);
const qaInvokedOnlyWithSafeSlot = measurements
  .filter((row) => row.semanticCandidates.length > 0)
  .every((row) => row.slot !== null);
const boundaryFrozen =
  boundary.entailmentThreshold === 0.962513483 &&
  boundary.minimumMargin === 0.927496071;

const invariantPass =
  familyOverlap.length === 0 &&
  allQaSpansSourceBound &&
  qaInvokedOnlyAfterBaselineAbstention &&
  qaInvokedOnlyWithSafeSlot &&
  boundaryFrozen &&
  protocol.protocol.runtimeChanged === false &&
  protocol.protocol.productionAdmissionChanged === false;

const safetyPass = Object.values(gates).every(Boolean);
const outcome = !invariantPass
  ? "INVALID_EXPERIMENT"
  : !safetyPass
    ? "REJECT_HOLDOUT_REGRESSION"
    : correctGoldRescues.length > 0
      ? "PROMOTE_TO_SHADOW_INTEGRATION"
      : "REJECT_NO_HOLDOUT_ADVANTAGE";

if (!protocol.holdoutGate.outcomes.includes(outcome)) {
  throw new Error("EXTRACTIVE_QA_NLI_CASCADE_HOLDOUT_OUTCOME_NOT_PREDECLARED");
}

const report = {
  schemaVersion: protocol.schemaVersion,
  generatedAt: new Date().toISOString(),
  candidateCommit: currentCommit(),
  baselineSha: protocol.baselineSha,
  protocolHash: sha256(protocolRaw),
  sourceHashes,
  developmentEvidence: protocol.developmentEvidence,
  outcome,
  phase: protocol.protocol.phase,
  priorHeldoutsLoaded: false,
  developmentLoadedForScoring: false,
  familyDisjoint: familyOverlap.length === 0,
  familyOverlap,
  holdout: {
    domains: domainIds,
    families: actualFamilies,
    questions: cases.length,
    answerable: answerableCount,
    unanswerable: unanswerableCount,
  },
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
  fixedBoundary: boundary,
  baseline: baselineSummary,
  candidate: candidateSummary,
  gates,
  counts: {
    baselineSupportedQueries: measurements.filter(
      (row) => row.baseline.supported,
    ).length,
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
        row.semanticCandidates.filter(
          (candidate) => candidate.entailmentTopClass,
        ).length,
      0,
    ),
    boundaryPassingProposals: measurements.reduce(
      (sum, row) =>
        sum +
        row.semanticCandidates.filter(
          (candidate) =>
            candidate.entailmentTopClass &&
            candidate.sourceBound &&
            candidate.entailmentScore >= boundary.entailmentThreshold &&
            candidate.margin >= boundary.minimumMargin,
        ).length,
      0,
    ),
    correctGoldRescues: correctGoldRescues.length,
    newFalseAcceptances: newFalseAcceptances.length,
    newWrongAdmissions: newWrongAdmissions.length,
    baselineRegressions: baselineRegressions.length,
  },
  invariants: {
    familyDisjointFromDevelopment: familyOverlap.length === 0,
    allQaSpansSourceBound,
    qaInvokedOnlyAfterBaselineAbstention,
    qaInvokedOnlyWithSafeSlot,
    fixedDevelopmentBoundaryUsed: boundaryFrozen,
    manualRelationHypothesesUsed: false,
    qaUsedAsAuthority: false,
    generativeReaderUsed: false,
    runtimeChanged: false,
    productionAdmissionChanged: false,
  },
  measurementLatencyMs,
  correctGoldRescues,
  newFalseAcceptances,
  newWrongAdmissions,
  baselineRegressions,
  changes,
  semanticAttempts: measurements
    .filter((row) => row.slot !== null)
    .map((row) => ({
      id: row.entry.question.id,
      domain: row.entry.domain.id,
      family: row.entry.question.family,
      language: row.entry.question.language,
      query: row.entry.question.query,
      slot: row.slot,
      baselineSupported: row.baseline.supported,
      candidates: row.semanticCandidates,
    })),
  claimBoundary: protocol.claimBoundary,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify(report, null, 2) + "\n");

if (!invariantPass) process.exitCode = 1;
