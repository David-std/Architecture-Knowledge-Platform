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
  protocol: {
    phase: "FRESH_DEVELOPMENT_FEASIBILITY_ONLY";
    retiredAuthority: string[];
    preserveNonPassageBaselineAuthority: true;
    readerMayCreateSourceBoundSupport: true;
    readerReceivesAllUnpreservedAuthorizedCandidates: true;
    readerSupportRequiresExactVisibleSpan: true;
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
  "evals/generic/open-reader-authority-fresh-dev/manifest.json",
);
const outputPath = path.resolve(
  process.env.AKP_OPEN_READER_FRESH_DEV_REPORT ??
    "reports/ci/open-reader-authority-fresh-dev.json",
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
    revision: `open-reader-fresh-dev/${domain.id}`,
    title: unit.title,
    type: unit.documentType,
    trust: "MACHINE_SUPPORTED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1 / rank,
    reasons: ["open-reader-fresh-development"],
    fusionContributions: [
      {
        channel: "vector",
        rank,
        channelWeight: 1,
        rawScore: 0.5,
        reason: "vector:open-reader-fresh-development",
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
    throw new Error("OPEN_READER_DOMAIN_ID_OR_SPLIT_DRIFT:" + expectedId);
  }
  const ids = new Set(domain.units.map((unit) => unit.id));
  if (ids.size !== domain.units.length) {
    throw new Error("OPEN_READER_DUPLICATE_UNIT:" + domain.id);
  }
  const qids = new Set<string>();
  for (const question of domain.questions) {
    if (qids.has(question.id)) {
      throw new Error("OPEN_READER_DUPLICATE_QUESTION:" + question.id);
    }
    qids.add(question.id);
    for (const label of [...question.gold, ...(question.acceptable ?? [])]) {
      if (!ids.has(label)) {
        throw new Error(
          "OPEN_READER_UNKNOWN_LABEL:" + question.id + ":" + label,
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
  protocol.schemaVersion !== "akp.open-reader-authority-fresh-dev.v1" ||
  protocol.frozen !== true ||
  protocol.protocol.phase !== "FRESH_DEVELOPMENT_FEASIBILITY_ONLY" ||
  protocol.protocol.retiredAuthority.join(",") !==
    "PASSAGE_TEXT_SUPPORT,PASSAGE_CUE_SUPPORT" ||
  protocol.protocol.preserveNonPassageBaselineAuthority !== true ||
  protocol.protocol.readerMayCreateSourceBoundSupport !== true ||
  protocol.protocol.readerReceivesAllUnpreservedAuthorizedCandidates !== true ||
  protocol.protocol.readerSupportRequiresExactVisibleSpan !== true ||
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
  throw new Error("OPEN_READER_FRESH_DEV_PROTOCOL_DRIFT");
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

const baseUrl = process.env.AKP_OPEN_READER_BASE_URL?.trim();
const model = process.env.AKP_OPEN_READER_MODEL?.trim();
const revision = process.env.AKP_OPEN_READER_MODEL_REVISION?.trim();
const dtype = process.env.AKP_OPEN_READER_DTYPE?.trim();
if (!baseUrl) throw new Error("OPEN_READER_BASE_URL_REQUIRED");
if (model !== protocol.reader.model) throw new Error("OPEN_READER_MODEL_DRIFT");
if (revision !== protocol.reader.revision)
  throw new Error("OPEN_READER_REVISION_DRIFT");
if (dtype !== protocol.reader.dtype) throw new Error("OPEN_READER_DTYPE_DRIFT");

const cases = await loadFreshCases(protocol);
if (
  cases.length !== protocol.dataset.questions ||
  cases.filter((entry) => entry.question.gold.length > 0).length !==
    protocol.dataset.answerable ||
  cases.filter((entry) => entry.question.gold.length === 0).length !==
    protocol.dataset.unanswerable
) {
  throw new Error("OPEN_READER_FRESH_DEV_DATASET_SHAPE_DRIFT");
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
  baselineSupported: boolean;
  baselineReason: string | null;
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
      const baselineSupported = new Set(
        baselineAssessment.supportedCandidateKeys,
      );
      const preservedKeys = baselineAssessment.supportedCandidateKeys.filter(
        (key) => {
          const signal = signalByKey.get(key);
          if (!signal)
            throw new Error("OPEN_READER_BASELINE_SIGNAL_MISSING:" + key);
          return !retiredAuthority.has(signal.passageSupport.reason);
        },
      );
      const preserved = new Set(preservedKeys);
      const semanticHits = hits.filter(
        (hit) => !preserved.has(retrievalAnswerabilityCandidateKey(hit)),
      );
      if (semanticHits.length === 0) return preservedKeys;

      readerQueryInvocations += 1;
      readerCandidateInputs += semanticHits.length;
      const semantic = await assessRetrievalAnswerabilityWithVerifier(
        semanticHits,
        query,
        verifier,
        { mode: "ENFORCE", maxCandidates: 64, maxConcurrency: 2 },
        {},
        { comparisonHits: semanticHits },
      );
      for (const signal of semantic.candidateSignals) {
        if (!semantic.supportedCandidateKeys.includes(signal.candidateKey)) {
          continue;
        }
        const trace = signal.queryConditionedEvidence;
        semanticSupports.push({
          query,
          candidateKey: signal.candidateKey,
          baselineSupported: baselineSupported.has(signal.candidateKey),
          baselineReason:
            signalByKey.get(signal.candidateKey)?.passageSupport.reason ?? null,
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
  if (!before) throw new Error("OPEN_READER_BASELINE_RESULT_MISSING:" + row.id);
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
const createdAdmissions = changes.flatMap((row) =>
  row.candidateAdmitted
    .filter((unit) => !row.baselineAdmitted.includes(unit))
    .map((unit) => ({ id: row.id, unit, answerable: row.answerable })),
);
const createdGoldRescues = changes.filter(
  (row) => !row.baselineGoldAdmitted && row.candidateGoldAdmitted,
);
const allSemanticSupportsSourceBound =
  semanticSupports.length > 0 &&
  semanticSupports.every(
    (support) =>
      support.sourceBound &&
      support.decision === "SUPPORTS" &&
      support.reason !== null,
  );
const measuredQualityAdvantage =
  (candidate.answerableRecall ?? 0) > (baseline.answerableRecall ?? 0) ||
  (candidate.admittedPrecision ?? 0) > (baseline.admittedPrecision ?? 0) ||
  (candidate.falseAcceptanceRate ?? 1) < (baseline.falseAcceptanceRate ?? 1) ||
  candidate.questionsWithWrongAdmission <
    baseline.questionsWithWrongAdmission ||
  (candidate.strictAccuracy ?? 0) > (baseline.strictAccuracy ?? 0);

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
  baselineGoldPreserved: baselineRegressions.length === 0,
  allSemanticSupportsSourceBound,
  measuredQualityAdvantage,
};

const invariantPass =
  gates.allSemanticSupportsSourceBound &&
  protocol.protocol.readerMayCreateSourceBoundSupport === true &&
  protocol.protocol.readerSupportRequiresExactVisibleSpan === true &&
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
  gates.measuredQualityAdvantage;
const outcome = !invariantPass
  ? "INVALID_EXPERIMENT"
  : frontierPass
    ? "PROCEED_TO_FRESH_HOLDOUT"
    : "REJECT_FRESH_DEVELOPMENT_FRONTIER";
if (!protocol.developmentGate.outcomes.includes(outcome)) {
  throw new Error("OPEN_READER_FRESH_DEV_OUTCOME_NOT_PREDECLARED");
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
  readerMayCreateSourceBoundSupport: true,
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
    createdAdmissions: createdAdmissions.length,
    createdGoldRescues: createdGoldRescues.length,
    removedFalseAcceptances: removedFalseAcceptances.length,
    removedWrongAdmissions: removedWrongAdmissions.length,
    baselineRegressions: baselineRegressions.length,
  },
  createdAdmissions,
  createdGoldRescues,
  removedFalseAcceptances,
  removedWrongAdmissions,
  baselineRegressions,
  changes,
  semanticSupports,
  claimBoundary: [
    "Development feasibility only; no heldout pack is loaded.",
    "Legacy PASSAGE_TEXT_SUPPORT and PASSAGE_CUE_SUPPORT do not grant candidate authority in the candidate arm.",
    "Existing non-PASSAGE structural/general deterministic admissions are preserved unchanged.",
    "The reader may establish new semantic support only through an exact visible source span and the existing hard deterministic source constraints.",
    "Reranking/relevance never grants support and no cross-encoder is used.",
    "A pass authorizes only a separately authored and frozen family-disjoint holdout.",
    "A reject terminates this exact open-reader composition without tuning against the inspected pack.",
  ],
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
if (!invariantPass) process.exitCode = 1;
