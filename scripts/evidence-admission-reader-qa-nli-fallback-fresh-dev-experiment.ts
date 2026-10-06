import "dotenv/config";

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SearchHit } from "@akp/contracts";
import {
  assessRetrievalAnswerability,
  assessRetrievalAnswerabilityWithVerifier,
  defaultLocalMultilingualNliRuntimeFactory,
  EVIDENCE_READER_PROMPT_VERSION,
  evidenceSentenceWindows,
  LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR,
  LOCAL_MULTILINGUAL_QA_EVIDENCE_MODEL,
  LOCAL_MULTILINGUAL_QA_EVIDENCE_REVISION,
  LocalMultilingualQaEvidenceVerifier,
  OpenAICompatibleEvidenceReader,
  ReaderEvidenceVerifier,
  retrievalAnswerabilityCandidateKey,
  type QueryConditionedEvidenceSpan,
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
type ExperimentManifest = {
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
    fixedEntailmentThreshold: number;
    requireEntailmentTopClass: true;
  };
  protocol: {
    phase: "FRESH_DEVELOPMENT_FEASIBILITY_ONLY";
    retiredAuthority: string[];
    readerFirst: true;
    fallbackOnlyForReaderUnsupported: true;
    readerCanCreateSupport: false;
    qaUsedAsSpanProposalOnly: true;
    qaDecisionUsedAsAuthority: false;
    qaNliCanCreateSupport: false;
    qaNliReceivesOnlyReaderUnresolvedRetiredCandidates: true;
    nliUsesManualRelationHypotheses: false;
    noCrossEncoder: true;
    noThresholdSweep: true;
    noPromptChange: true;
    providerDefaultsChanged: false;
    runtimeChanged: false;
    productionAdmissionChanged: false;
  };
  developmentGate: { outcomes: string[] };
};

const root = path.resolve(".");
const protocolPath = path.resolve(
  "evals/generic/reader-qa-nli-fallback-fresh-dev/manifest.json",
);
const outputPath = path.resolve(
  process.env.AKP_READER_QA_NLI_FRESH_DEV_REPORT ??
    "reports/ci/reader-qa-nli-fallback-fresh-dev.json",
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
    revision: `reader-qa-nli-fresh-dev/${domain.id}`,
    title: unit.title,
    type: unit.documentType,
    trust: "MACHINE_SUPPORTED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1 / rank,
    reasons: ["reader-qa-nli-fresh-development"],
    fusionContributions: [
      {
        channel: "vector",
        rank,
        channelWeight: 1,
        rawScore: 0.5,
        reason: "vector:reader-qa-nli-fresh-development",
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
    throw new Error("FRESH_DEV_DOMAIN_ID_OR_SPLIT_DRIFT:" + expectedId);
  }
  const ids = new Set(domain.units.map((unit) => unit.id));
  if (ids.size !== domain.units.length) {
    throw new Error("FRESH_DEV_DUPLICATE_UNIT:" + domain.id);
  }
  const qids = new Set<string>();
  for (const question of domain.questions) {
    if (qids.has(question.id)) {
      throw new Error("FRESH_DEV_DUPLICATE_QUESTION:" + question.id);
    }
    qids.add(question.id);
    for (const label of [...question.gold, ...(question.acceptable ?? [])]) {
      if (!ids.has(label)) {
        throw new Error("FRESH_DEV_UNKNOWN_LABEL:" + question.id + ":" + label);
      }
    }
  }
}
async function loadFreshCases(
  protocol: ExperimentManifest,
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
    span: { startOffset: window.startOffset, endOffset: window.endOffset },
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
  const q = query.trim().replaceAll('"', "'");
  const a = answer.trim().replaceAll('"', "'");
  return language === "ES"
    ? `La respuesta a la pregunta "${q}" es "${a}".`
    : `The answer to the question "${q}" is "${a}".`;
}

const protocolRaw = await readFile(protocolPath, "utf8");
const protocol = JSON.parse(protocolRaw) as ExperimentManifest;
if (
  protocol.schemaVersion !== "akp.reader-qa-nli-fallback-fresh-dev.v1" ||
  protocol.frozen !== true ||
  protocol.protocol.phase !== "FRESH_DEVELOPMENT_FEASIBILITY_ONLY" ||
  protocol.dataset.split !== "development" ||
  protocol.dataset.authoredBeforeExecution !== true ||
  protocol.dataset.reusedPriorDevelopment !== false ||
  protocol.dataset.reusedPriorHeldout !== false ||
  protocol.protocol.retiredAuthority.join(",") !==
    "PASSAGE_TEXT_SUPPORT,PASSAGE_CUE_SUPPORT" ||
  protocol.protocol.readerFirst !== true ||
  protocol.protocol.fallbackOnlyForReaderUnsupported !== true ||
  protocol.protocol.readerCanCreateSupport !== false ||
  protocol.protocol.qaUsedAsSpanProposalOnly !== true ||
  protocol.protocol.qaDecisionUsedAsAuthority !== false ||
  protocol.protocol.qaNliCanCreateSupport !== false ||
  protocol.protocol.qaNliReceivesOnlyReaderUnresolvedRetiredCandidates !==
    true ||
  protocol.protocol.nliUsesManualRelationHypotheses !== false ||
  protocol.protocol.noCrossEncoder !== true ||
  protocol.protocol.noThresholdSweep !== true ||
  protocol.protocol.noPromptChange !== true ||
  protocol.protocol.runtimeChanged !== false ||
  protocol.protocol.productionAdmissionChanged !== false ||
  protocol.reader.promptVersion !== EVIDENCE_READER_PROMPT_VERSION ||
  protocol.reader.temperature !== 0 ||
  protocol.qa.model !== LOCAL_MULTILINGUAL_QA_EVIDENCE_MODEL ||
  protocol.qa.revision !== LOCAL_MULTILINGUAL_QA_EVIDENCE_REVISION ||
  protocol.qa.maxAnswerTokens !== 15 ||
  protocol.nli.model !== LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR.model ||
  protocol.nli.revision !== LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR.revision ||
  protocol.nli.modelFileName !==
    LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR.modelFileName ||
  protocol.nli.dtype !== LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR.dtype ||
  protocol.nli.fixedEntailmentThreshold !== 0.5 ||
  protocol.nli.requireEntailmentTopClass !== true
) {
  throw new Error("READER_QA_NLI_FRESH_DEV_PROTOCOL_DRIFT");
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
const cases = await loadFreshCases(protocol);
const answerable = cases.filter(
  (entry) => entry.question.gold.length > 0,
).length;
const unanswerable = cases.length - answerable;
if (
  cases.length !== protocol.dataset.questions ||
  answerable !== protocol.dataset.answerable ||
  unanswerable !== protocol.dataset.unanswerable ||
  new Set(cases.map((entry) => entry.domain.id)).size !==
    protocol.dataset.domains.length
) {
  throw new Error("READER_QA_NLI_FRESH_DEV_DATASET_COUNT_DRIFT");
}

const readerBaseUrl = process.env.AKP_READER_QA_NLI_BASE_URL?.trim();
if (!readerBaseUrl) throw new Error("READER_QA_NLI_BASE_URL_REQUIRED");
if (
  process.env.AKP_READER_QA_NLI_MODEL?.trim() !== protocol.reader.model ||
  process.env.AKP_READER_QA_NLI_MODEL_REVISION?.trim() !==
    protocol.reader.revision ||
  process.env.AKP_READER_QA_NLI_DTYPE?.trim() !== protocol.reader.dtype
) {
  throw new Error("READER_QA_NLI_PROVIDER_IDENTITY_DRIFT");
}

const baselineResults = await evaluateEvidenceAdmission(
  cases,
  async (hits, query) =>
    assessRetrievalAnswerability(hits, query).supportedCandidateKeys,
);
const baseline = summarizeEvidenceAdmission(baselineResults);

const readerVerifier = new ReaderEvidenceVerifier({
  reader: new OpenAICompatibleEvidenceReader({
    baseUrl: readerBaseUrl,
    model: protocol.reader.model,
    maxOutputTokens: protocol.reader.maxOutputTokens,
    timeoutMs: 45_000,
    jsonResponseFormat: true,
  }),
  shortlistSize: 64,
  concurrency: 2,
});
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
const languageByQuery = new Map(
  cases.map((entry) => [entry.question.query, entry.question.language]),
);
let readerInputs = 0;
let readerSupports = 0;
let fallbackAttempts = 0;
let qaSpanProposals = 0;
let nliAccepted = 0;
const readerTrace: Array<{
  candidateKey: string;
  sourceBound: boolean;
  decision: string | null;
  reason: string | null;
}> = [];
const fallbackTrace: Array<{
  candidateKey: string;
  qaSourceBound: boolean;
  entailment: number;
  neutral: number;
  contradiction: number;
  accepted: boolean;
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
          throw new Error("READER_QA_NLI_BASELINE_SIGNAL_MISSING:" + key);
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

      readerInputs += retiredHits.length;
      const reader = await assessRetrievalAnswerabilityWithVerifier(
        retiredHits,
        query,
        readerVerifier,
        { mode: "ENFORCE", maxCandidates: 64, maxConcurrency: 2 },
        {},
        { comparisonHits: retiredHits },
      );
      const readerSupported = new Set(reader.supportedCandidateKeys);
      for (const signal of reader.candidateSignals) {
        if (!readerSupported.has(signal.candidateKey)) continue;
        const trace = signal.queryConditionedEvidence;
        const sourceBound =
          trace?.decision === "SUPPORTS" &&
          trace.evidenceSpan !== null &&
          trace.evidenceSpan !== undefined &&
          Number.isSafeInteger(trace.evidenceSpan.startOffset) &&
          Number.isSafeInteger(trace.evidenceSpan.endOffset) &&
          trace.evidenceSpan.startOffset >= 0 &&
          trace.evidenceSpan.endOffset > trace.evidenceSpan.startOffset;
        readerTrace.push({
          candidateKey: signal.candidateKey,
          sourceBound,
          decision: trace?.decision ?? null,
          reason: trace?.reason ?? null,
        });
        readerSupports += 1;
      }

      const unresolvedHits = retiredHits.filter(
        (hit) => !readerSupported.has(retrievalAnswerabilityCandidateKey(hit)),
      );
      const fallbackSupported: string[] = [];
      for (const hit of unresolvedHits) {
        fallbackAttempts += 1;
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
        qaSpanProposals += 1;
        const span = verification.evidenceSpan;
        const answer = hit.excerpt
          .slice(span.startOffset, span.endOffset)
          .trim();
        const sentence = sentenceContainingSpan(hit.excerpt, span);
        if (!answer || !sentence) continue;
        const sourceBound =
          span.startOffset >= sentence.span.startOffset &&
          span.endOffset <= sentence.span.endOffset &&
          hit.excerpt.slice(span.startOffset, span.endOffset).trim() === answer;
        if (!sourceBound) continue;
        const language = questionLanguage(languageByQuery.get(query) ?? "en");
        const hypothesis = hypothesisFor(language, query, answer);
        const distribution = await nli.infer(sentence.text, hypothesis);
        const topClass =
          distribution.entailment > distribution.neutral &&
          distribution.entailment > distribution.contradiction;
        const accepted =
          topClass &&
          distribution.entailment >= protocol.nli.fixedEntailmentThreshold;
        fallbackTrace.push({
          candidateKey,
          qaSourceBound: sourceBound,
          entailment: distribution.entailment,
          neutral: distribution.neutral,
          contradiction: distribution.contradiction,
          accepted,
        });
        if (accepted) {
          fallbackSupported.push(candidateKey);
          nliAccepted += 1;
        }
      }

      return [
        ...new Set([
          ...preservedKeys,
          ...reader.supportedCandidateKeys,
          ...fallbackSupported,
        ]),
      ];
    },
  );
} finally {
  await readerVerifier.dispose();
  await qa.dispose();
  await nli.dispose?.();
}

const candidate = summarizeEvidenceAdmission(candidateResults);
const baselineById = new Map(baselineResults.map((row) => [row.id, row]));
const changes = candidateResults.flatMap((row) => {
  const before = baselineById.get(row.id);
  if (!before)
    throw new Error("READER_QA_NLI_BASELINE_RESULT_MISSING:" + row.id);
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
const allReaderSupportsSourceBound = readerTrace.every(
  (trace) =>
    trace.sourceBound &&
    trace.decision === "SUPPORTS" &&
    trace.reason === "READER_QUOTED_ANSWER",
);
const allFallbackSpansSourceBound = fallbackTrace.every(
  (trace) => trace.qaSourceBound,
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
  allReaderSupportsSourceBound,
  allFallbackSpansSourceBound,
  measuredPrecisionAdvantage,
};
const invariantPass =
  gates.candidateAdmissionsSubsetOfBaseline &&
  gates.allReaderSupportsSourceBound &&
  gates.allFallbackSpansSourceBound &&
  protocol.protocol.readerCanCreateSupport === false &&
  protocol.protocol.qaNliCanCreateSupport === false &&
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
  throw new Error("READER_QA_NLI_FRESH_DEV_OUTCOME_NOT_PREDECLARED");
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
  qa: protocol.qa,
  nli: protocol.nli,
  runtimeChanged: false,
  productionAdmissionChanged: false,
  candidateCanCreateSupport: false,
  baseline,
  candidate,
  gates,
  counts: {
    developmentCases: cases.length,
    readerInputs,
    readerSupports,
    fallbackAttempts,
    qaSpanProposals,
    nliAccepted,
    removedFalseAcceptances: removedFalseAcceptances.length,
    removedWrongAdmissions: removedWrongAdmissions.length,
    baselineRegressions: baselineRegressions.length,
    candidateCreatedAdmissions: candidateCreatedAdmissions.length,
  },
  removedFalseAcceptances,
  removedWrongAdmissions,
  baselineRegressions,
  changes,
  readerTrace,
  fallbackTrace,
  claimBoundary: [
    "Fresh development feasibility only; no heldout partition exists or was evaluated.",
    "The candidate is subset-only: neither the 1.5B reader nor QA-NLI may create support outside baseline PASSAGE_* admissions.",
    "QA proposes an exact visible span only; QA score or decision never grants admission.",
    "NLI uses one fixed generic question-plus-answer hypothesis and a predeclared 0.50 entailment threshold with top-class requirement; no threshold sweep is allowed.",
    "A pass authorizes only a separately authored and frozen family-disjoint holdout; it does not change runtime/defaults.",
    "A reject terminates this exact heterogeneous fallback without model, prompt, threshold or dataset retuning.",
  ],
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
if (!invariantPass) process.exitCode = 1;
