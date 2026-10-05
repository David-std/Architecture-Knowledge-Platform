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

type ReaderSpec = {
  role: "primary" | "fallback";
  model: string;
  revision: string;
  dtype: string;
  promptVersion: string;
  temperature: number;
  maxOutputTokens: number;
};

type ExperimentManifest = {
  schemaVersion: string;
  frozen: true;
  baselineSha: string;
  inputs: FrozenInput[];
  dataset: {
    split: "development";
    domains: string[];
    questions: number;
    languages: string[];
    authoredBeforeExecution: true;
    reusedPriorHeldout: false;
  };
  readers: [ReaderSpec, ReaderSpec];
  protocol: {
    phase: "FRESH_DEVELOPMENT_FEASIBILITY_ONLY";
    retiredAuthority: string[];
    primaryFirst: true;
    fallbackOnlyForPrimaryUnsupported: true;
    readerCanCreateSupport: false;
    readerReceivesOnlyRetiredBaselineCandidates: true;
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
  "evals/generic/dual-reader-passage-replacement-fresh-dev/manifest.json",
);
const outputPath = path.resolve(
  process.env.AKP_DUAL_READER_FRESH_DEV_REPORT ??
    "reports/ci/dual-reader-passage-replacement-fresh-dev.json",
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
    revision: `dual-reader-fresh-dev/${domain.id}`,
    title: unit.title,
    type: unit.documentType,
    trust: "MACHINE_SUPPORTED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1 / rank,
    reasons: ["dual-reader-fresh-development"],
    fusionContributions: [
      {
        channel: "vector",
        rank,
        channelWeight: 1,
        rawScore: 0.5,
        reason: "vector:dual-reader-fresh-development",
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
    if (qids.has(question.id)) throw new Error("FRESH_DEV_DUPLICATE_QUESTION:" + question.id);
    qids.add(question.id);
    for (const label of [...question.gold, ...(question.acceptable ?? [])]) {
      if (!ids.has(label)) throw new Error("FRESH_DEV_UNKNOWN_LABEL:" + question.id + ":" + label);
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
  protocol.schemaVersion !== "akp.dual-reader-passage-replacement-fresh-dev.v1" ||
  protocol.frozen !== true ||
  protocol.protocol.phase !== "FRESH_DEVELOPMENT_FEASIBILITY_ONLY" ||
  protocol.dataset.split !== "development" ||
  protocol.dataset.authoredBeforeExecution !== true ||
  protocol.dataset.reusedPriorHeldout !== false ||
  protocol.protocol.retiredAuthority.join(",") !==
    "PASSAGE_TEXT_SUPPORT,PASSAGE_CUE_SUPPORT" ||
  protocol.protocol.primaryFirst !== true ||
  protocol.protocol.fallbackOnlyForPrimaryUnsupported !== true ||
  protocol.protocol.readerCanCreateSupport !== false ||
  protocol.protocol.readerReceivesOnlyRetiredBaselineCandidates !== true ||
  protocol.protocol.noCrossEncoder !== true ||
  protocol.protocol.noThresholdSweep !== true ||
  protocol.protocol.noPromptChange !== true ||
  protocol.protocol.runtimeChanged !== false ||
  protocol.protocol.productionAdmissionChanged !== false ||
  protocol.readers.some(
    (reader) =>
      reader.promptVersion !== EVIDENCE_READER_PROMPT_VERSION ||
      reader.temperature !== 0,
  )
) {
  throw new Error("DUAL_READER_FRESH_DEV_PROTOCOL_DRIFT");
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

const cases = await loadFreshCases(protocol);
if (
  cases.length !== protocol.dataset.questions ||
  new Set(cases.map((entry) => entry.domain.id)).size !==
    protocol.dataset.domains.length
) {
  throw new Error("DUAL_READER_FRESH_DEV_DATASET_COUNT_DRIFT");
}

const primarySpec = protocol.readers.find((reader) => reader.role === "primary")!;
const fallbackSpec = protocol.readers.find((reader) => reader.role === "fallback")!;
const primaryBaseUrl = process.env.AKP_DUAL_READER_PRIMARY_BASE_URL?.trim();
const fallbackBaseUrl = process.env.AKP_DUAL_READER_FALLBACK_BASE_URL?.trim();
if (!primaryBaseUrl || !fallbackBaseUrl) {
  throw new Error("DUAL_READER_BASE_URL_REQUIRED");
}
if (
  process.env.AKP_DUAL_READER_PRIMARY_MODEL?.trim() !== primarySpec.model ||
  process.env.AKP_DUAL_READER_PRIMARY_REVISION?.trim() !== primarySpec.revision ||
  process.env.AKP_DUAL_READER_PRIMARY_DTYPE?.trim() !== primarySpec.dtype ||
  process.env.AKP_DUAL_READER_FALLBACK_MODEL?.trim() !== fallbackSpec.model ||
  process.env.AKP_DUAL_READER_FALLBACK_REVISION?.trim() !== fallbackSpec.revision ||
  process.env.AKP_DUAL_READER_FALLBACK_DTYPE?.trim() !== fallbackSpec.dtype
) {
  throw new Error("DUAL_READER_PROVIDER_IDENTITY_DRIFT");
}

const baselineResults = await evaluateEvidenceAdmission(
  cases,
  async (hits, query) => assessRetrievalAnswerability(hits, query),
);
const baseline = summarizeEvidenceAdmission(baselineResults);

const primaryVerifier = new ReaderEvidenceVerifier({
  reader: new OpenAICompatibleEvidenceReader({
    baseUrl: primaryBaseUrl,
    model: primarySpec.model,
    maxOutputTokens: primarySpec.maxOutputTokens,
    timeoutMs: 45_000,
    jsonResponseFormat: true,
  }),
  shortlistSize: 64,
  concurrency: 2,
});
const fallbackVerifier = new ReaderEvidenceVerifier({
  reader: new OpenAICompatibleEvidenceReader({
    baseUrl: fallbackBaseUrl,
    model: fallbackSpec.model,
    maxOutputTokens: fallbackSpec.maxOutputTokens,
    timeoutMs: 30_000,
    jsonResponseFormat: true,
  }),
  shortlistSize: 64,
  concurrency: 2,
});

const retiredAuthority = new Set(protocol.protocol.retiredAuthority);
const traces: Array<{
  query: string;
  stage: "primary" | "fallback";
  candidateKey: string;
  decision: string | null;
  reason: string | null;
  sourceBound: boolean;
  startOffset: number | null;
  endOffset: number | null;
}> = [];
let primaryInputs = 0;
let fallbackInputs = 0;

function recordSupports(
  query: string,
  stage: "primary" | "fallback",
  assessment: Awaited<ReturnType<typeof assessRetrievalAnswerabilityWithVerifier>>,
) {
  for (const signal of assessment.candidateSignals) {
    if (!assessment.supportedCandidateKeys.includes(signal.candidateKey)) continue;
    const trace = signal.queryConditionedEvidence;
    traces.push({
      query,
      stage,
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
      const retiredKeys = new Set<string>();

      for (const key of baselineAssessment.supportedCandidateKeys) {
        const signal = signalByKey.get(key);
        if (!signal) throw new Error("DUAL_READER_BASELINE_SIGNAL_MISSING:" + key);
        if (retiredAuthority.has(signal.passageSupport.reason)) retiredKeys.add(key);
        else preservedKeys.push(key);
      }

      const retiredHits = hits.filter((hit) =>
        retiredKeys.has(retrievalAnswerabilityCandidateKey(hit)),
      );
      if (retiredHits.length === 0) return preservedKeys;

      primaryInputs += retiredHits.length;
      const primary = await assessRetrievalAnswerabilityWithVerifier(
        retiredHits,
        query,
        primaryVerifier,
        { mode: "ENFORCE", maxCandidates: 64, maxConcurrency: 2 },
        {},
        { comparisonHits: retiredHits },
      );
      recordSupports(query, "primary", primary);

      const primarySupported = new Set(primary.supportedCandidateKeys);
      const unresolvedHits = retiredHits.filter(
        (hit) => !primarySupported.has(retrievalAnswerabilityCandidateKey(hit)),
      );

      let fallbackSupported: readonly string[] = [];
      if (unresolvedHits.length > 0) {
        fallbackInputs += unresolvedHits.length;
        const fallback = await assessRetrievalAnswerabilityWithVerifier(
          unresolvedHits,
          query,
          fallbackVerifier,
          { mode: "ENFORCE", maxCandidates: 64, maxConcurrency: 2 },
          {},
          { comparisonHits: unresolvedHits },
        );
        recordSupports(query, "fallback", fallback);
        fallbackSupported = fallback.supportedCandidateKeys;
      }

      return [
        ...new Set([
          ...preservedKeys,
          ...primary.supportedCandidateKeys,
          ...fallbackSupported,
        ]),
      ];
    },
  );
} finally {
  await primaryVerifier.dispose();
  await fallbackVerifier.dispose();
}

const candidate = summarizeEvidenceAdmission(candidateResults);
const baselineById = new Map(baselineResults.map((row) => [row.id, row]));
const changes = candidateResults.flatMap((row) => {
  const before = baselineById.get(row.id);
  if (!before) throw new Error("DUAL_READER_BASELINE_RESULT_MISSING:" + row.id);
  if (before.admitted.join("\n") === row.admitted.join("\n")) return [];
  return [{
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
  }];
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
const allSemanticSupportsSourceBound = traces.every(
  (trace) =>
    trace.sourceBound &&
    trace.decision === "SUPPORTS" &&
    trace.reason === "READER_QUOTED_ANSWER",
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
    candidate.questionsWithWrongAdmission <= baseline.questionsWithWrongAdmission,
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
  throw new Error("DUAL_READER_FRESH_DEV_OUTCOME_NOT_PREDECLARED");
}

const report = {
  schemaVersion: protocol.schemaVersion,
  generatedAt: new Date().toISOString(),
  candidateCommit: currentCommit(),
  baselineSha: protocol.baselineSha,
  protocolHash: sha256(protocolRaw),
  sourceHashes,
  outcome,
  dataset: protocol.dataset,
  readers: protocol.readers,
  heldoutEvaluated: false,
  retiredAuthority: protocol.protocol.retiredAuthority,
  candidateCanCreateSupport: false,
  runtimeChanged: false,
  productionAdmissionChanged: false,
  baseline,
  candidate,
  gates,
  counts: {
    developmentCases: cases.length,
    primaryInputs,
    fallbackInputs,
    sourceBoundSemanticSupports: traces.length,
    primarySupports: traces.filter((trace) => trace.stage === "primary").length,
    fallbackSupports: traces.filter((trace) => trace.stage === "fallback").length,
    removedFalseAcceptances: removedFalseAcceptances.length,
    removedWrongAdmissions: removedWrongAdmissions.length,
    baselineRegressions: baselineRegressions.length,
    candidateCreatedAdmissions: candidateCreatedAdmissions.length,
  },
  removedFalseAcceptances,
  removedWrongAdmissions,
  baselineRegressions,
  changes,
  semanticSupports: traces,
  claimBoundary: [
    "Fresh development only. No prior inspected development or heldout pack is loaded.",
    "The candidate is subset-only and cannot create support.",
    "Both readers use the unchanged evidence-reader-v4 prompt and must return an exact visible source span.",
    "The fallback reader sees only retired baseline candidates not supported by the primary reader.",
    "A pass authorizes only a separately authored and frozen family-disjoint holdout.",
  ],
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify(report, null, 2) + "\n");

if (!invariantPass) process.exitCode = 1;
