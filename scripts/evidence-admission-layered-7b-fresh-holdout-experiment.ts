import "dotenv/config";

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SearchHit } from "@akp/contracts";
import {
  assessRetrievalAnswerability,
  CONTEXTUAL_CROSS_ENCODER_MODEL,
  CONTEXTUAL_CROSS_ENCODER_REVISION,
  ContextualCrossEncoderEvidenceVerifier,
  EVIDENCE_READER_PROMPT_VERSION,
  LayeredEvidenceAdmissionPipeline,
  OpenAICompatibleEvidenceReader,
  QueryConditionedSemanticEvidenceReader,
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
  split: "heldout";
  language: string;
  description: string;
  units: PackUnit[];
  questions: PackQuestion[];
};

type Manifest = {
  schemaVersion: "akp.layered-7b-authority-fresh-holdout.v1";
  frozen: true;
  baselineSha: string;
  candidateCodeSha: string;
  dataFreezeCommit: string;
  developmentEvidence: {
    outcome: "PROCEED_TO_FRESH_HOLDOUT";
    candidateCommit: string;
    protocolHash: string;
    answerableRecall: number;
    admittedPrecision: number;
    falseAcceptanceRate: number;
    strictAccuracy: number;
    p95LatencyMs: number;
  };
  frozenRuntimePaths: string[];
  familyDisjointAgainst: string;
  inputs: FrozenInput[];
  dataset: {
    split: "heldout";
    domains: string[];
    questions: number;
    answerable: number;
    unanswerable: number;
    languages: string[];
    authoredAfterDevelopmentPass: true;
    reusedPriorDevelopment: false;
    reusedPriorHeldout: false;
    familyDisjointFromDevelopment: true;
  };
  architecture: {
    legacyAuthorityRetiredInCandidate: string[];
    structuralGuard: "StructuralEvidenceGuard";
    structuredMatcher: "ExactStructuredPropositionMatcher";
    structuredMatcherIndependentEvidence: string;
    semanticReader: "QueryConditionedSemanticEvidenceReader";
    readerPromptVersion: string;
    rerankerAuthority: false;
    readerSupportRequiresExactVisibleSpan: true;
    productionDefaultsChanged: false;
    runtimeAdmissionChanged: false;
  };
  reranker: {
    model: string;
    revision: string;
    shortlistSize: number;
    shortlistFloor: number;
    authority: "ORDER_ONLY";
  };
  reader: {
    provider: "ollama-openai-compatible";
    model: string;
    deploymentDigest: string;
    quantization: string;
    promptVersion: string;
    temperature: 0;
    maxOutputTokens: number;
    contextLength: number;
    requestTimeoutMs: number;
  };
  operatingPoint: {
    policy: "SAFETY_FIRST_ABSOLUTE_FRONTIER";
    answerableRecallMinimum: number;
    admittedPrecisionMinimum: number;
    falseAcceptanceRateMaximum: number;
    wrongAdmissionQuestionsMaximum: number;
    strictAccuracyMinimum: number;
    p95QuestionLatencyMsMaximum: number;
    allSemanticSupportsSourceBound: true;
    structuredMatcherStrictAccuracyRequired: number;
    baselineGoldPreservationRequired: false;
    paretoDominanceOverLegacyRequired: false;
    safetyImprovementAgainstLegacy: {
      admittedPrecisionMustIncrease: true;
      falseAcceptanceRateMustNotIncrease: true;
    };
  };
  protocol: {
    phase: "FRESH_FAMILY_DISJOINT_HOLDOUT";
    singleIndependentVariable: string;
    noThresholdSweep: true;
    noPromptChange: true;
    noModelChange: true;
    noShortlistChange: true;
    noRuntimeCodeChangeAfterDevelopment: true;
    noDatasetChangeAfterExecution: true;
    noCorpusSpecificAliases: true;
    noFastPaths: true;
    noLegacyCueAuthorityInCandidate: true;
    noProductionPromotionFromHoldoutAlone: true;
  };
  holdoutGate: { outcomes: string[] };
};

type StructuredBenchmarkReport = {
  outcome?: unknown;
  experiment?: { candidateSha?: unknown };
  development?: { strictAccuracy?: unknown };
  heldout?: { strictAccuracy?: unknown };
};

type OllamaTag = {
  name?: unknown;
  model?: unknown;
  digest?: unknown;
  context_length?: unknown;
  details?: {
    quantization_level?: unknown;
    parameter_size?: unknown;
  };
};

type OllamaTagsResponse = { models?: unknown };

const root = path.resolve(".");
const protocolPath = path.resolve(
  "evals/generic/layered-7b-authority-fresh-holdout/manifest.json",
);
const outputPath = path.resolve(
  process.env.AKP_LAYERED_7B_FRESH_HOLDOUT_REPORT ??
    "reports/ci/layered-7b-authority-fresh-holdout.json",
);
const structuredReportPath = path.resolve(
  process.env.AKP_STRUCTURED_PROPOSITION_HOLDOUT_REPORT ??
    "reports/ci/structured-proposition-family-disjoint.json",
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
    revision: `layered-7b-fresh-holdout/${domain.id}`,
    title: unit.title,
    type: unit.documentType,
    trust: "MACHINE_SUPPORTED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1 / rank,
    reasons: ["layered-7b-fresh-holdout"],
    fusionContributions: [
      {
        channel: "vector",
        rank,
        channelWeight: 1,
        rawScore: 0.5,
        reason: "vector:layered-7b-fresh-holdout",
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

function validateDomain(domain: PackDomain, expectedId: string): void {
  if (domain.id !== expectedId || domain.split !== "heldout") {
    throw new Error("LAYERED_7B_DOMAIN_ID_OR_SPLIT_DRIFT:" + expectedId);
  }
  if (!domain.description.trim()) {
    throw new Error("LAYERED_7B_DOMAIN_DESCRIPTION_REQUIRED:" + expectedId);
  }
  const ids = new Set(domain.units.map((unit) => unit.id));
  if (ids.size !== domain.units.length) {
    throw new Error("LAYERED_7B_DUPLICATE_UNIT:" + domain.id);
  }
  const questionIds = new Set<string>();
  const families = new Set<string>();
  for (const question of domain.questions) {
    if (questionIds.has(question.id)) {
      throw new Error("LAYERED_7B_DUPLICATE_QUESTION:" + question.id);
    }
    if (families.has(question.family)) {
      throw new Error("LAYERED_7B_DUPLICATE_FAMILY:" + question.family);
    }
    questionIds.add(question.id);
    families.add(question.family);
    for (const label of [...question.gold, ...(question.acceptable ?? [])]) {
      if (!ids.has(label)) {
        throw new Error(`LAYERED_7B_UNKNOWN_LABEL:${question.id}:${label}`);
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

function finiteMetric(value: number | null, name: string): number {
  if (value === null || !Number.isFinite(value)) {
    throw new Error(`LAYERED_7B_METRIC_UNDEFINED:${name}`);
  }
  return value;
}

async function verifyOllamaIdentity(
  baseUrl: string,
  protocol: Manifest,
): Promise<{ digest: string; quantization: string; parameterSize: string }> {
  const tagsUrl = new URL("/api/tags", baseUrl);
  const response = await fetch(tagsUrl, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`LAYERED_7B_OLLAMA_TAGS_HTTP_${response.status}`);
  }
  const payload = (await response.json()) as OllamaTagsResponse;
  const models = Array.isArray(payload.models)
    ? (payload.models as OllamaTag[])
    : [];
  const selected = models.find(
    (entry) =>
      entry.name === protocol.reader.model ||
      entry.model === protocol.reader.model,
  );
  if (!selected || typeof selected.digest !== "string") {
    throw new Error("LAYERED_7B_PINNED_MODEL_NOT_INSTALLED");
  }
  const quantization =
    typeof selected.details?.quantization_level === "string"
      ? selected.details.quantization_level
      : "";
  const parameterSize =
    typeof selected.details?.parameter_size === "string"
      ? selected.details.parameter_size
      : "";
  if (
    selected.digest !== protocol.reader.deploymentDigest ||
    quantization !== protocol.reader.quantization
  ) {
    throw new Error("LAYERED_7B_MODEL_IDENTITY_DRIFT");
  }
  return {
    digest: selected.digest,
    quantization,
    parameterSize,
  };
}

async function verifyOllamaRuntimeContext(
  baseUrl: string,
  protocol: Manifest,
): Promise<number> {
  const response = await fetch(new URL("/api/ps", baseUrl), {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`LAYERED_7B_OLLAMA_PS_HTTP_${response.status}`);
  }
  const payload = (await response.json()) as OllamaTagsResponse;
  const models = Array.isArray(payload.models)
    ? (payload.models as OllamaTag[])
    : [];
  const selected = models.find(
    (entry) =>
      entry.name === protocol.reader.model ||
      entry.model === protocol.reader.model,
  );
  if (
    !selected ||
    !Number.isSafeInteger(selected.context_length) ||
    selected.context_length !== protocol.reader.contextLength
  ) {
    throw new Error("LAYERED_7B_RUNTIME_CONTEXT_DRIFT");
  }
  return selected.context_length as number;
}

async function verifyStructuredMatcherEvidence(
  protocol: Manifest,
  head: string,
): Promise<{ outcome: string; strictAccuracy: number; reportHash: string }> {
  const raw = await readFile(structuredReportPath, "utf8");
  const report = JSON.parse(raw) as StructuredBenchmarkReport;
  const candidateSha = report.experiment?.candidateSha;
  const development = report.development?.strictAccuracy;
  const heldout = report.heldout?.strictAccuracy;
  if (
    report.outcome !== "PROMOTE" ||
    candidateSha !== head ||
    development !==
      protocol.operatingPoint.structuredMatcherStrictAccuracyRequired ||
    heldout !== protocol.operatingPoint.structuredMatcherStrictAccuracyRequired
  ) {
    throw new Error("LAYERED_7B_STRUCTURED_MATCHER_EVIDENCE_INVALID");
  }
  return {
    outcome: report.outcome,
    strictAccuracy: development,
    reportHash: sha256(raw),
  };
}

const protocolRaw = await readFile(protocolPath, "utf8");
const protocol = JSON.parse(protocolRaw) as Manifest;
if (
  protocol.schemaVersion !== "akp.layered-7b-authority-fresh-holdout.v1" ||
  protocol.frozen !== true ||
  protocol.protocol.phase !== "FRESH_FAMILY_DISJOINT_HOLDOUT" ||
  protocol.architecture.legacyAuthorityRetiredInCandidate.join(",") !==
    "PASSAGE_TEXT_SUPPORT,PASSAGE_CUE_SUPPORT" ||
  protocol.architecture.structuralGuard !== "StructuralEvidenceGuard" ||
  protocol.architecture.structuredMatcher !==
    "ExactStructuredPropositionMatcher" ||
  protocol.architecture.semanticReader !==
    "QueryConditionedSemanticEvidenceReader" ||
  protocol.architecture.readerPromptVersion !==
    EVIDENCE_READER_PROMPT_VERSION ||
  protocol.architecture.rerankerAuthority !== false ||
  protocol.architecture.readerSupportRequiresExactVisibleSpan !== true ||
  protocol.architecture.productionDefaultsChanged !== false ||
  protocol.architecture.runtimeAdmissionChanged !== false ||
  protocol.reranker.model !== CONTEXTUAL_CROSS_ENCODER_MODEL ||
  protocol.reranker.revision !== CONTEXTUAL_CROSS_ENCODER_REVISION ||
  protocol.reranker.authority !== "ORDER_ONLY" ||
  protocol.reader.promptVersion !== EVIDENCE_READER_PROMPT_VERSION ||
  protocol.reader.temperature !== 0 ||
  protocol.operatingPoint.baselineGoldPreservationRequired !== false ||
  protocol.operatingPoint.paretoDominanceOverLegacyRequired !== false ||
  protocol.protocol.noThresholdSweep !== true ||
  protocol.protocol.noPromptChange !== true ||
  protocol.protocol.noDatasetChangeAfterExecution !== true ||
  protocol.protocol.noLegacyCueAuthorityInCandidate !== true ||
  protocol.protocol.noProductionPromotionFromHoldoutAlone !== true
) {
  throw new Error("LAYERED_7B_FRESH_HOLDOUT_PROTOCOL_DRIFT");
}

assertAncestor(protocol.baselineSha);
assertAncestor(protocol.candidateCodeSha);
assertAncestor(protocol.dataFreezeCommit);
assertRuntimeUnchanged();
const head = currentCommit();

function assertRuntimeUnchanged(): void {
  try {
    execFileSync(
      "git",
      [
        "diff",
        "--quiet",
        protocol.candidateCodeSha,
        "HEAD",
        "--",
        ...protocol.frozenRuntimePaths,
      ],
      { cwd: root, stdio: "ignore" },
    );
  } catch {
    throw new Error("LAYERED_7B_HOLDOUT_RUNTIME_CODE_DRIFT");
  }
}

async function loadFamilySet(directory: string): Promise<Set<string>> {
  const output = new Set<string>();
  const absolute = path.resolve(directory);
  for (const file of (await readdir(absolute))
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    const raw = JSON.parse(
      await readFile(path.join(absolute, file), "utf8"),
    ) as {
      questions?: Array<{ family?: unknown }>;
    };
    for (const question of raw.questions ?? []) {
      if (typeof question.family !== "string" || !question.family.trim()) {
        throw new Error("LAYERED_7B_FAMILY_ID_INVALID:" + file);
      }
      output.add(question.family);
    }
  }
  return output;
}

const sourceHashes: Record<string, string> = {};
for (const input of protocol.inputs) {
  const absolute = path.resolve(input.path);
  if (gitBlobSha(absolute) !== input.gitBlobSha) {
    throw new Error("LAYERED_7B_FROZEN_INPUT_CHANGED:" + input.path);
  }
  sourceHashes[input.path] = sha256(await readFile(absolute, "utf8"));
}

const cases = await loadFreshCases(protocol);
if (
  cases.length !== protocol.dataset.questions ||
  cases.filter((entry) => entry.question.gold.length > 0).length !==
    protocol.dataset.answerable ||
  cases.filter((entry) => entry.question.gold.length === 0).length !==
    protocol.dataset.unanswerable ||
  [...new Set(cases.map((entry) => entry.question.family))].length !==
    cases.length
) {
  throw new Error("LAYERED_7B_FRESH_HOLDOUT_DATASET_SHAPE_DRIFT");
}

const holdoutFamilies = new Set(cases.map((entry) => entry.question.family));
const developmentFamilies = await loadFamilySet(protocol.familyDisjointAgainst);
const familyOverlap = [...holdoutFamilies].filter((family) =>
  developmentFamilies.has(family),
);
if (
  protocol.dataset.familyDisjointFromDevelopment !== true ||
  familyOverlap.length > 0
) {
  throw new Error(
    "LAYERED_7B_HOLDOUT_FAMILY_OVERLAP:" + familyOverlap.join(","),
  );
}

const structuredMatcherEvidence = await verifyStructuredMatcherEvidence(
  protocol,
  head,
);
const baseUrl =
  process.env.AKP_LAYERED_7B_BASE_URL?.trim() || "http://127.0.0.1:11434";
const configuredModel =
  process.env.AKP_LAYERED_7B_MODEL?.trim() || protocol.reader.model;
if (configuredModel !== protocol.reader.model) {
  throw new Error("LAYERED_7B_MODEL_CONFIG_DRIFT");
}
const ollamaIdentity = await verifyOllamaIdentity(baseUrl, protocol);

const baselineResults = await evaluateEvidenceAdmission(
  cases,
  async (hits, query) =>
    assessRetrievalAnswerability(hits, query).supportedCandidateKeys,
);
const baseline = summarizeEvidenceAdmission(baselineResults);

const shortlist = new ContextualCrossEncoderEvidenceVerifier({
  minimumSupportScore: 0.2,
  localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
});
const reader = new OpenAICompatibleEvidenceReader({
  baseUrl,
  model: protocol.reader.model,
  timeoutMs: protocol.reader.requestTimeoutMs,
  maxOutputTokens: protocol.reader.maxOutputTokens,
  jsonResponseFormat: true,
});
const verifier = new ReaderEvidenceVerifier({
  reader,
  shortlist,
  shortlistSize: protocol.reranker.shortlistSize,
  shortlistFloor: protocol.reranker.shortlistFloor,
  concurrency: 2,
});
const semanticReader = new QueryConditionedSemanticEvidenceReader({
  verifier,
  timeoutMs: 60_000,
});
const pipeline = new LayeredEvidenceAdmissionPipeline({ semanticReader });

const decisionRows: Array<{
  query: string;
  candidateKey: string;
  unit: string;
  layer: string;
  verdict: string;
  reason: string;
  sourceBound: boolean;
  startOffset: number | null;
  endOffset: number | null;
}> = [];

let candidateResults;
try {
  candidateResults = await evaluateEvidenceAdmission(
    cases,
    async (hits, query) => {
      const decisions = await pipeline.evaluateBatch(
        hits.map((hit) => ({ query, hit })),
      );
      const supported: string[] = [];
      decisions.forEach((decision, index) => {
        const hit = hits[index]!;
        const candidateKey = retrievalAnswerabilityCandidateKey(hit);
        const quote =
          decision.verdict.kind === "ANSWERS" ||
          decision.verdict.kind === "CONTRADICTS"
            ? decision.verdict.quote
            : null;
        const sourceBound =
          quote !== null &&
          Number.isSafeInteger(quote.startOffset) &&
          Number.isSafeInteger(quote.endOffset) &&
          quote.startOffset >= 0 &&
          quote.endOffset > quote.startOffset &&
          quote.endOffset <= hit.excerpt.length;
        decisionRows.push({
          query,
          candidateKey,
          unit: hit.document.externalId ?? candidateKey,
          layer: decision.layer,
          verdict: decision.verdict.kind,
          reason: decision.reason,
          sourceBound,
          startOffset: quote?.startOffset ?? null,
          endOffset: quote?.endOffset ?? null,
        });
        if (decision.verdict.kind === "ANSWERS") supported.push(candidateKey);
      });
      return supported;
    },
  );
} finally {
  await verifier.dispose();
}

const observedRuntimeContextLength = await verifyOllamaRuntimeContext(
  baseUrl,
  protocol,
);

const candidate = summarizeEvidenceAdmission(candidateResults);
const baselineById = new Map(baselineResults.map((row) => [row.id, row]));
const changes = candidateResults.flatMap((row) => {
  const before = baselineById.get(row.id);
  if (!before) throw new Error("LAYERED_7B_BASELINE_RESULT_MISSING:" + row.id);
  if (before.admitted.join("\n") === row.admitted.join("\n")) return [];
  return [
    {
      id: row.id,
      domain: row.domain,
      intent: row.intent,
      language: row.language,
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
const baselineRegressions = changes.filter(
  (row) => row.baselineGoldAdmitted && !row.candidateGoldAdmitted,
);
const goldRescues = changes.filter(
  (row) => !row.baselineGoldAdmitted && row.candidateGoldAdmitted,
);
const semanticAnswers = decisionRows.filter(
  (row) => row.layer === "SEMANTIC_READER" && row.verdict === "ANSWERS",
);
const allSemanticSupportsSourceBound =
  semanticAnswers.length > 0 && semanticAnswers.every((row) => row.sourceBound);
const legacyReasonLeaked = decisionRows.some(
  (row) =>
    row.reason === "PASSAGE_TEXT_SUPPORT" ||
    row.reason === "PASSAGE_CUE_SUPPORT",
);

const candidateRecall = finiteMetric(
  candidate.answerableRecall,
  "answerableRecall",
);
const candidatePrecision = finiteMetric(
  candidate.admittedPrecision,
  "admittedPrecision",
);
const candidateFar = finiteMetric(
  candidate.falseAcceptanceRate,
  "falseAcceptanceRate",
);
const candidateStrict = finiteMetric(
  candidate.strictAccuracy,
  "strictAccuracy",
);
const candidateP95 = finiteMetric(candidate.p95LatencyMs, "p95LatencyMs");
const baselinePrecision = finiteMetric(
  baseline.admittedPrecision,
  "baselineAdmittedPrecision",
);
const baselineFar = finiteMetric(
  baseline.falseAcceptanceRate,
  "baselineFalseAcceptanceRate",
);

const gates = {
  answerableRecallOperatingPoint:
    candidateRecall >= protocol.operatingPoint.answerableRecallMinimum,
  admittedPrecisionOperatingPoint:
    candidatePrecision >= protocol.operatingPoint.admittedPrecisionMinimum,
  falseAcceptanceOperatingPoint:
    candidateFar <= protocol.operatingPoint.falseAcceptanceRateMaximum,
  wrongAdmissionQuestionsOperatingPoint:
    candidate.questionsWithWrongAdmission <=
    protocol.operatingPoint.wrongAdmissionQuestionsMaximum,
  strictAccuracyOperatingPoint:
    candidateStrict >= protocol.operatingPoint.strictAccuracyMinimum,
  latencyOperatingPoint:
    candidateP95 <= protocol.operatingPoint.p95QuestionLatencyMsMaximum,
  admittedPrecisionImprovesLegacy: candidatePrecision > baselinePrecision,
  falseAcceptanceDoesNotWorsenLegacy: candidateFar <= baselineFar,
  allSemanticSupportsSourceBound,
  structuredMatcherIndependentEvidence:
    structuredMatcherEvidence.outcome === "PROMOTE" &&
    structuredMatcherEvidence.strictAccuracy ===
      protocol.operatingPoint.structuredMatcherStrictAccuracyRequired,
  noLegacyCueAuthorityLeaked: !legacyReasonLeaked,
};

const invariantPass =
  gates.allSemanticSupportsSourceBound &&
  gates.structuredMatcherIndependentEvidence &&
  gates.noLegacyCueAuthorityLeaked &&
  protocol.architecture.rerankerAuthority === false &&
  protocol.architecture.productionDefaultsChanged === false &&
  protocol.architecture.runtimeAdmissionChanged === false;
const operatingPointPass =
  gates.answerableRecallOperatingPoint &&
  gates.admittedPrecisionOperatingPoint &&
  gates.falseAcceptanceOperatingPoint &&
  gates.wrongAdmissionQuestionsOperatingPoint &&
  gates.strictAccuracyOperatingPoint &&
  gates.latencyOperatingPoint &&
  gates.admittedPrecisionImprovesLegacy &&
  gates.falseAcceptanceDoesNotWorsenLegacy;
const outcome = !invariantPass
  ? "INVALID_EXPERIMENT"
  : operatingPointPass
    ? "PROMOTE_TO_PRIVATE_FRESH_E2E"
    : "REJECT_FRESH_HOLDOUT_FRONTIER";

if (!protocol.holdoutGate.outcomes.includes(outcome)) {
  throw new Error("LAYERED_7B_OUTCOME_NOT_PREDECLARED");
}

const report = {
  schemaVersion: protocol.schemaVersion,
  generatedAt: new Date().toISOString(),
  candidateCommit: head,
  baselineSha: protocol.baselineSha,
  dataFreezeCommit: protocol.dataFreezeCommit,
  protocolHash: sha256(protocolRaw),
  sourceHashes,
  outcome,
  heldoutEvaluated: true,
  developmentEvidence: protocol.developmentEvidence,
  familyDisjointFromDevelopment: familyOverlap.length === 0,
  developmentFamilyCount: developmentFamilies.size,
  holdoutFamilyCount: holdoutFamilies.size,
  runtimeAdmissionChanged: false,
  productionDefaultsChanged: false,
  model: {
    ...protocol.reader,
    observed: {
      ...ollamaIdentity,
      runtimeContextLength: observedRuntimeContextLength,
    },
  },
  reranker: protocol.reranker,
  structuredMatcherEvidence,
  operatingPoint: protocol.operatingPoint,
  baseline,
  candidate,
  gates,
  counts: {
    holdoutCases: cases.length,
    semanticAnswers: semanticAnswers.length,
    candidateAdmissions: candidate.admittedUnits,
    goldRescues: goldRescues.length,
    baselineRegressions: baselineRegressions.length,
  },
  baselineRegressions,
  goldRescues,
  changes,
  decisions: decisionRows,
  claimBoundary: [
    "Fresh family-disjoint holdout only; no private vault is loaded.",
    "PASSAGE_TEXT_SUPPORT and PASSAGE_CUE_SUPPORT have no authority in the candidate arm.",
    "BGE orders and shortlists only; its score never grants evidence support.",
    "Structured proposition authority is reused only from the independently family-disjoint proven exact matcher.",
    "Ordinary prose support requires reader-v4 plus an exact visible source span constrained by StructuralEvidenceGuard.",
    "The holdout gate reuses the development-approved safety-first operating point unchanged; legacy gold preservation is not an authority requirement.",
    "A holdout pass authorizes only a separate fresh private end-to-end retrieval run; it does not authorize production activation.",
    "A reject terminates this exact model, prompt, shortlist, operating point and holdout composition without retuning against the inspected pack.",
  ],
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
if (!invariantPass) process.exitCode = 1;
