import "dotenv/config";

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SearchHit } from "@akp/contracts";
import {
  assessRetrievalAnswerability,
  assessRetrievalAnswerabilityWithVerifier,
  EVIDENCE_READER_PROMPT_VERSION,
  evidenceSentenceWindows,
  OpenAICompatibleEvidenceReader,
  ReaderEvidenceVerifier,
  retrievalAnswerabilityCandidateKey,
} from "../packages/retrieval/src/index.js";
import {
  evaluateEvidenceAdmission,
  summarizeEvidenceAdmission,
  type EvidenceAdmissionCase,
} from "./evidence-admission-pack.js";

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
  language: string;
  query: string;
  gold: string[];
  acceptable?: string[];
  challenges: string[];
};
type PackDomain = {
  id: string;
  split: "development";
  language: string;
  description: string;
  units: PackUnit[];
  questions: PackQuestion[];
};
type Manifest = {
  schemaVersion: string;
  frozen: true;
  baselineSha: string;
  dataFreezeCommit: string;
  inputs: FrozenInput[];
  dataset: {
    split: "development";
    domains: string[];
    questions: number;
    answerable: number;
    unanswerable: number;
    languages: string[];
    authoredBeforeExecution: true;
    reusedPriorDevelopment: false;
    reusedPriorHeldout: false;
  };
  reader: {
    model: string;
    revision: string;
    dtype: string;
    promptVersion: string;
    temperature: number;
    maxOutputTokens: number;
  };
  segmentation: {
    kind: "INTL_SENTENCE_EXACT_SOURCE_OFFSETS";
    allVisibleSentences: true;
    preservesOriginalCandidateIdentity: true;
    sentenceCanCreateCandidate: false;
  };
  protocol: {
    phase: "FRESH_DEVELOPMENT_FEASIBILITY_ONLY";
    retiredAuthority: string[];
    unitReaderFirst: true;
    sentenceFallbackOnlyAfterUnitAbstains: true;
    readerCanCreateSupport: false;
    readerReceivesOnlyRetiredBaselineCandidates: true;
    allVisibleSentencesEvaluated: true;
    sentenceSpansRemappedToOriginalPassage: true;
    noCrossEncoder: true;
    noThresholdSweep: true;
    noPromptChange: true;
    noModelChangeFromReader107: true;
    providerDefaultsChanged: false;
    runtimeChanged: false;
    productionAdmissionChanged: false;
  };
  developmentGate: { outcomes: string[] };
};

const root = path.resolve(".");
const protocolPath = path.resolve(
  "evals/generic/unit-sentence-union-fresh-dev/manifest.json",
);
const outputPath = path.resolve(
  process.env.AKP_UNIT_SENTENCE_UNION_FRESH_DEV_REPORT ??
    "reports/ci/unit-sentence-union-fresh-dev.json",
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
function noRegression(candidate: number | null, baseline: number | null) {
  if (baseline === null) return candidate === null;
  return candidate !== null && candidate >= baseline;
}
function noIncrease(candidate: number | null, baseline: number | null) {
  if (baseline === null) return candidate === null;
  return candidate !== null && candidate <= baseline;
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
    revision: `unit-sentence-union-fresh-dev/${domain.id}`,
    title: unit.title,
    type: unit.documentType,
    trust: "MACHINE_SUPPORTED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1 / rank,
    reasons: ["unit-sentence-union-fresh-development"],
    fusionContributions: [
      {
        channel: "vector",
        rank,
        channelWeight: 1,
        rawScore: 0.5,
        reason: "vector:unit-sentence-union-fresh-development",
      },
    ],
    excerpt: unit.text,
    citations: [],
  };
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
function validateDomain(domain: PackDomain, expectedId: string) {
  if (domain.id !== expectedId || domain.split !== "development") {
    throw new Error(
      "UNIT_SENTENCE_UNION_DOMAIN_ID_OR_SPLIT_DRIFT:" + expectedId,
    );
  }
  const ids = new Set(domain.units.map((unit) => unit.id));
  if (ids.size !== domain.units.length) {
    throw new Error("UNIT_SENTENCE_UNION_DUPLICATE_UNIT:" + domain.id);
  }
  const qids = new Set<string>();
  for (const question of domain.questions) {
    if (qids.has(question.id)) {
      throw new Error("UNIT_SENTENCE_UNION_DUPLICATE_QUESTION:" + question.id);
    }
    qids.add(question.id);
    for (const label of [...question.gold, ...(question.acceptable ?? [])]) {
      if (!ids.has(label)) {
        throw new Error(
          "UNIT_SENTENCE_UNION_UNKNOWN_LABEL:" + question.id + ":" + label,
        );
      }
    }
  }
}
async function loadFreshCases(
  protocol: Manifest,
): Promise<EvidenceAdmissionCase[]> {
  const cases: EvidenceAdmissionCase[] = [];
  for (const input of protocol.inputs) {
    if (!input.path.includes("/domains/")) continue;
    const domain = JSON.parse(
      await readFile(path.resolve(input.path), "utf8"),
    ) as PackDomain;
    validateDomain(domain, path.basename(input.path, ".json"));
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
      cases.push({
        domain: domain as EvidenceAdmissionCase["domain"],
        question: question as EvidenceAdmissionCase["question"],
        hits,
        unitIdByCandidateKey,
      });
    }
  }
  return cases;
}

const protocolRaw = await readFile(protocolPath, "utf8");
const protocol = JSON.parse(protocolRaw) as Manifest;
if (
  protocol.schemaVersion !== "akp.unit-sentence-union-fresh-dev.v1" ||
  protocol.frozen !== true ||
  protocol.protocol.phase !== "FRESH_DEVELOPMENT_FEASIBILITY_ONLY" ||
  protocol.protocol.retiredAuthority.join(",") !==
    "PASSAGE_TEXT_SUPPORT,PASSAGE_CUE_SUPPORT" ||
  protocol.protocol.unitReaderFirst !== true ||
  protocol.protocol.sentenceFallbackOnlyAfterUnitAbstains !== true ||
  protocol.segmentation.kind !== "INTL_SENTENCE_EXACT_SOURCE_OFFSETS" ||
  protocol.segmentation.allVisibleSentences !== true ||
  protocol.segmentation.preservesOriginalCandidateIdentity !== true ||
  protocol.segmentation.sentenceCanCreateCandidate !== false ||
  protocol.protocol.readerCanCreateSupport !== false ||
  protocol.protocol.readerReceivesOnlyRetiredBaselineCandidates !== true ||
  protocol.protocol.allVisibleSentencesEvaluated !== true ||
  protocol.protocol.sentenceSpansRemappedToOriginalPassage !== true ||
  protocol.protocol.noCrossEncoder !== true ||
  protocol.protocol.noThresholdSweep !== true ||
  protocol.protocol.noPromptChange !== true ||
  protocol.protocol.noModelChangeFromReader107 !== true ||
  protocol.protocol.providerDefaultsChanged !== false ||
  protocol.protocol.runtimeChanged !== false ||
  protocol.protocol.productionAdmissionChanged !== false ||
  protocol.reader.promptVersion !== EVIDENCE_READER_PROMPT_VERSION ||
  protocol.reader.temperature !== 0
) {
  throw new Error("UNIT_SENTENCE_UNION_FRESH_DEV_PROTOCOL_DRIFT");
}
assertAncestor(protocol.baselineSha);
assertAncestor(protocol.dataFreezeCommit);

const sourceHashes: Record<string, string> = {};
for (const input of protocol.inputs) {
  const absolute = path.resolve(input.path);
  if (gitBlobSha(absolute) !== input.gitBlobSha) {
    throw new Error("FROZEN_INPUT_CHANGED:" + input.path);
  }
  sourceHashes[input.path] = sha256(await readFile(absolute, "utf8"));
}

const baseUrl = process.env.AKP_UNIT_SENTENCE_UNION_BASE_URL?.trim();
const model = process.env.AKP_UNIT_SENTENCE_UNION_MODEL?.trim();
const revision = process.env.AKP_UNIT_SENTENCE_UNION_MODEL_REVISION?.trim();
const dtype = process.env.AKP_UNIT_SENTENCE_UNION_DTYPE?.trim();
if (!baseUrl) throw new Error("UNIT_SENTENCE_UNION_BASE_URL_REQUIRED");
if (model !== protocol.reader.model)
  throw new Error("UNIT_SENTENCE_UNION_MODEL_DRIFT");
if (revision !== protocol.reader.revision) {
  throw new Error("UNIT_SENTENCE_UNION_REVISION_DRIFT");
}
if (dtype !== protocol.reader.dtype)
  throw new Error("UNIT_SENTENCE_UNION_DTYPE_DRIFT");

const cases = await loadFreshCases(protocol);
if (
  cases.length !== protocol.dataset.questions ||
  cases.filter((entry) => entry.question.gold.length > 0).length !==
    protocol.dataset.answerable ||
  cases.filter((entry) => entry.question.gold.length === 0).length !==
    protocol.dataset.unanswerable
) {
  throw new Error("UNIT_SENTENCE_UNION_FRESH_DEV_DATASET_SHAPE_DRIFT");
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
  shortlistSize: 1,
  concurrency: 1,
});
const retiredAuthority = new Set(protocol.protocol.retiredAuthority);

let readerQueryInvocations = 0;
let retiredCandidateInputs = 0;
let unitReaderInputs = 0;
let sentenceInputs = 0;
const semanticSupports: Array<{
  query: string;
  candidateKey: string;
  sentenceIndex: number;
  sentenceStartOffset: number;
  sentenceEndOffset: number;
  decision: string | null;
  reason: string | null;
  sourceBound: boolean;
  originalStartOffset: number | null;
  originalEndOffset: number | null;
}> = [];

async function unitSupportsCandidate(
  hit: SearchHit,
  query: string,
): Promise<boolean> {
  retiredCandidateInputs += 1;
  unitReaderInputs += 1;
  const assessment = await assessRetrievalAnswerabilityWithVerifier(
    [hit],
    query,
    verifier,
    { mode: "ENFORCE", maxCandidates: 1, maxConcurrency: 1 },
    {},
    { comparisonHits: [hit] },
  );
  const signal = assessment.candidateSignals[0];
  const trace = signal?.queryConditionedEvidence;
  if (!assessment.supported || !trace || trace.decision !== "SUPPORTS") {
    return false;
  }
  const span = trace.evidenceSpan;
  const sourceBound =
    span !== null &&
    Number.isSafeInteger(span.startOffset) &&
    Number.isSafeInteger(span.endOffset) &&
    span.startOffset >= 0 &&
    span.endOffset > span.startOffset &&
    span.endOffset <= hit.excerpt.length;
  semanticSupports.push({
    query,
    candidateKey: retrievalAnswerabilityCandidateKey(hit),
    sentenceIndex: -1,
    sentenceStartOffset: 0,
    sentenceEndOffset: hit.excerpt.length,
    decision: trace.decision,
    reason: trace.reason,
    sourceBound,
    originalStartOffset: sourceBound ? span!.startOffset : null,
    originalEndOffset: sourceBound ? span!.endOffset : null,
  });
  return sourceBound;
}

async function sentenceSupportsCandidate(
  hit: SearchHit,
  query: string,
): Promise<boolean> {
  const windows = evidenceSentenceWindows(hit.excerpt);
  if (windows.length === 0) return false;
  sentenceInputs += windows.length;

  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index]!;
    const segmentHit: SearchHit = {
      ...hit,
      unitId: stableUuid(
        `${hit.unitId ?? hit.documentId}:sentence:${index}:${window.startOffset}:${window.endOffset}`,
      ),
      excerpt: window.text,
    };
    const assessment = await assessRetrievalAnswerabilityWithVerifier(
      [segmentHit],
      query,
      verifier,
      { mode: "ENFORCE", maxCandidates: 1, maxConcurrency: 1 },
      {},
      { comparisonHits: [segmentHit] },
    );
    const signal = assessment.candidateSignals[0];
    const trace = signal?.queryConditionedEvidence;
    if (!assessment.supported || !trace || trace.decision !== "SUPPORTS") {
      continue;
    }
    const span = trace.evidenceSpan;
    const localBound =
      span !== null &&
      Number.isSafeInteger(span.startOffset) &&
      Number.isSafeInteger(span.endOffset) &&
      span.startOffset >= 0 &&
      span.endOffset > span.startOffset &&
      span.endOffset <= window.text.length;
    const originalStart = localBound
      ? window.startOffset + span!.startOffset
      : null;
    const originalEnd = localBound
      ? window.startOffset + span!.endOffset
      : null;
    const mapped =
      localBound &&
      originalStart !== null &&
      originalEnd !== null &&
      hit.excerpt.slice(originalStart, originalEnd) ===
        window.text.slice(span!.startOffset, span!.endOffset);
    semanticSupports.push({
      query,
      candidateKey: retrievalAnswerabilityCandidateKey(hit),
      sentenceIndex: index,
      sentenceStartOffset: window.startOffset,
      sentenceEndOffset: window.endOffset,
      decision: trace.decision,
      reason: trace.reason,
      sourceBound: mapped,
      originalStartOffset: mapped ? originalStart : null,
      originalEndOffset: mapped ? originalEnd : null,
    });
    if (mapped) return true;
  }
  return false;
}

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
      const retiredHits: SearchHit[] = [];
      for (const key of baselineAssessment.supportedCandidateKeys) {
        const signal = signalByKey.get(key);
        if (!signal) {
          throw new Error("UNIT_SENTENCE_UNION_BASELINE_SIGNAL_MISSING:" + key);
        }
        if (retiredAuthority.has(signal.passageSupport.reason)) {
          const hit = hits.find(
            (candidate) =>
              retrievalAnswerabilityCandidateKey(candidate) === key,
          );
          if (!hit) throw new Error("UNIT_SENTENCE_UNION_HIT_MISSING:" + key);
          retiredHits.push(hit);
        } else {
          preservedKeys.push(key);
        }
      }
      if (retiredHits.length === 0) return preservedKeys;

      readerQueryInvocations += 1;
      const supportedRetired: string[] = [];
      for (const hit of retiredHits) {
        if (
          (await unitSupportsCandidate(hit, query)) ||
          (await sentenceSupportsCandidate(hit, query))
        ) {
          supportedRetired.push(retrievalAnswerabilityCandidateKey(hit));
        }
      }
      return [...new Set([...preservedKeys, ...supportedRetired])];
    },
  );
} finally {
  await verifier.dispose();
}

const candidate = summarizeEvidenceAdmission(candidateResults);
const baselineById = new Map(baselineResults.map((row) => [row.id, row]));
const changes = candidateResults.flatMap((row) => {
  const before = baselineById.get(row.id);
  if (!before)
    throw new Error("UNIT_SENTENCE_UNION_BASELINE_RESULT_MISSING:" + row.id);
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
const allSemanticSupportsSourceBound =
  semanticSupports.length > 0 &&
  semanticSupports.every(
    (support) =>
      support.sourceBound &&
      support.decision === "SUPPORTS" &&
      support.originalStartOffset !== null &&
      support.originalEndOffset !== null,
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
    : "REJECT_FRESH_DEVELOPMENT_FRONTIER";
if (!protocol.developmentGate.outcomes.includes(outcome)) {
  throw new Error("UNIT_SENTENCE_UNION_FRESH_DEV_OUTCOME_NOT_PREDECLARED");
}

const report = {
  schemaVersion: protocol.schemaVersion,
  generatedAt: new Date().toISOString(),
  candidateCommit: currentCommit(),
  baselineSha: protocol.baselineSha,
  dataFreezeCommit: protocol.dataFreezeCommit,
  protocolHash: sha256(protocolRaw),
  sourceHashes,
  outcome,
  heldoutEvaluated: false,
  retiredAuthority: protocol.protocol.retiredAuthority,
  reader: protocol.reader,
  segmentation: protocol.segmentation,
  candidateCanCreateSupport: false,
  runtimeChanged: false,
  productionAdmissionChanged: false,
  baseline,
  candidate,
  gates,
  counts: {
    developmentCases: cases.length,
    readerQueryInvocations,
    retiredCandidateInputs,
    unitReaderInputs,
    sentenceInputs,
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
    "Development feasibility only; no heldout pack is loaded.",
    "The unchanged 1.5B reader sees only candidates already admitted by legacy PASSAGE_TEXT_SUPPORT or PASSAGE_CUE_SUPPORT.",
    "Each retired candidate is read as the full exact unit first; only a unit-level abstention enables exact visible sentence fallback.",
    "Unit and sentence views use the same model and prompt. Sentence fallback changes verification granularity only, never ranking or candidate authority.",
    "Every semantic support counts only after its verifier span maps exactly into the original candidate passage.",
    "The candidate is subset-only and cannot create support.",
    "A pass authorizes only a separately authored and frozen family-disjoint holdout.",
    "A reject terminates this exact sentence-decomposition mechanism without retuning against the inspected pack.",
  ],
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
if (!invariantPass) process.exitCode = 1;
