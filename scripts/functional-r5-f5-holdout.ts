import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { SearchHit } from "@akp/contracts";
import {
  assessRetrievalAnswerability,
  assessRetrievalAnswerabilityWithLayeredAdmission,
  ContextualCrossEncoderEvidenceVerifier,
  CONTEXTUAL_CROSS_ENCODER_DEFAULT_SUPPORT_SCORE,
  LayeredEvidenceAdmissionPipeline,
  OpenAICompatibleEvidenceReader,
  QueryConditionedSemanticEvidenceReader,
  ReaderEvidenceVerifier,
  retrievalAnswerabilityCandidateKey,
} from "../packages/retrieval/src/index.js";

type Unit = {
  id: string;
  excerpt: string;
  headingPath: string[];
  unitType: NonNullable<SearchHit["unitType"]>;
  documentType: string;
};
type Domain = {
  id: string;
  title: string;
  sourceLanguage: string;
  units: Unit[];
};
type Question = {
  id: string;
  family: string;
  sourceDomain: string;
  sourceLanguage: string;
  questionLanguage: string;
  query: string;
  goldUnitId: string | null;
  answerBearingSpan: null | {
    unitId: string;
    quote: string;
    startOffset: number;
    endOffset: number;
  };
  expected: string;
  challenge: string;
};
type Protocol = {
  schemaVersion: string;
  frozen: boolean;
  sourceHead: string;
  source: Domain[];
  questions: Question[];
  evaluation: {
    minimumAnswerable: number;
    minimumUnanswerable: number;
    noTuneOnInspected: boolean;
    noDefaultChange: boolean;
  };
};
const dataPath = "evals/generic/functional-r5-f5-20261008.json";
const outputPath = "reports/ci/functional-r5-f5-20261008.json";
const freezeCommit = "b3d6c8c83954e1ffe5a3d166ed282579f772647d";
const frozenBlob = "58ce6614f4485a65670d137c0e9f2c00ef0fbedb";
const codeHead = "a4dbdfff6ea836c87726177f4b4fd071907b2b2b";
const model = "qwen2.5:7b-instruct",
  digest = "845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const frozenRaw = await readFile(dataPath, "utf8");
const protocol = JSON.parse(frozenRaw) as Protocol;
const head = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const actualBlob = execFileSync("git", ["hash-object", dataPath], {
  encoding: "utf8",
}).trim();
execFileSync("git", ["merge-base", "--is-ancestor", freezeCommit, "HEAD"]);
if (
  actualBlob !== frozenBlob ||
  protocol.schemaVersion !== "akp.r5.functional-holdout.v1" ||
  !protocol.frozen ||
  protocol.sourceHead !== codeHead ||
  protocol.evaluation.minimumAnswerable !== 80 ||
  protocol.evaluation.minimumUnanswerable !== 15 ||
  !protocol.evaluation.noTuneOnInspected ||
  !protocol.evaluation.noDefaultChange
)
  throw Error("F5_PRE_REGISTRATION_DRIFT");
const answerable = protocol.questions.filter((q) => q.expected === "ANSWERS");
const unanswerable = protocol.questions.filter(
  (q) => q.expected === "INSUFFICIENT",
);
const families = new Set(protocol.questions.map((q) => q.family));
const ids = new Set(protocol.questions.map((q) => q.id));
if (
  answerable.length !== 80 ||
  unanswerable.length !== 15 ||
  protocol.questions.length !== 95 ||
  families.size !== 95 ||
  ids.size !== 95 ||
  protocol.source.length !== 16
)
  throw Error("F5_SAMPLE_OR_FAMILY_DRIFT");
const domains = new Map(protocol.source.map((x) => [x.id, x]));
for (const q of protocol.questions) {
  const domain = domains.get(q.sourceDomain);
  if (!domain || !["en", "es"].includes(q.questionLanguage))
    throw Error("F5_DOMAIN_LANGUAGE_INVALID");
  if (q.expected === "ANSWERS") {
    const u = domain.units.find((x) => x.id === q.goldUnitId);
    const span = q.answerBearingSpan;
    if (
      !u ||
      !span ||
      span.unitId !== u.id ||
      u.excerpt.slice(span.startOffset, span.endOffset) !== span.quote ||
      span.quote.trim().length < 20
    )
      throw Error("F5_SOURCE_SPAN_ORACLE_INVALID:" + q.id);
  } else if (q.goldUnitId !== null || q.answerBearingSpan !== null)
    throw Error("F5_NEGATIVE_ORACLE_INVALID");
}
const tags = (await fetch("http://127.0.0.1:11434/api/tags", {
  signal: AbortSignal.timeout(10000),
}).then((r) => r.json())) as {
  models?: Array<{ name?: string; digest?: string }>;
};
if (!tags.models?.some((m) => m.name === model && m.digest === digest))
  throw Error("F5_READER_DIGEST_DRIFT");
function uuid(x: string) {
  const s = sha(x);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-8${s.slice(17, 20)}-${s.slice(20, 32)}`;
}
function hitsFor(q: Question) {
  const domain = domains.get(q.sourceDomain)!;
  const unitOrder = [...domain.units].sort((a, b) =>
    sha(q.id + ":" + a.id).localeCompare(sha(q.id + ":" + b.id)),
  );
  return unitOrder.map((u, i): SearchHit => ({
    documentId: uuid("f5:doc:" + domain.id),
    vaultId: uuid("f5:vault:" + domain.id),
    unitId: uuid("f5:unit:" + u.id),
    unitType: u.unitType,
    structuralOrder: i + 1,
    headingPath: u.headingPath,
    document: {
      externalId: u.id,
      path: `f5/${domain.id}/${u.id}.md`,
      title: domain.title,
    },
    revision: "r5-f5-frozen-20261008",
    title: domain.title,
    type: u.documentType,
    trust: "MACHINE_SUPPORTED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1 / (i + 1),
    reasons: ["f5-frozen-input"],
    fusionContributions: [
      {
        channel: "vector",
        rank: i + 1,
        channelWeight: 1,
        rawScore: 0.5,
        reason: "vector:f5-frozen-input",
      },
    ],
    excerpt: u.excerpt,
    citations: [],
  }));
}
const e5CacheDir = "C:/Users/david/AppData/Local/AKP/model-cache";
const verifier = new ReaderEvidenceVerifier({
  reader: new OpenAICompatibleEvidenceReader({
    baseUrl: "http://127.0.0.1:11434",
    model,
    timeoutMs: 30000,
    jsonResponseFormat: true,
  }),
  shortlist: new ContextualCrossEncoderEvidenceVerifier({
    minimumSupportScore: CONTEXTUAL_CROSS_ENCODER_DEFAULT_SUPPORT_SCORE,
    cacheDir: e5CacheDir,
    localFilesOnly: true,
  }),
  shortlistSize: 4,
});
const pipeline = new LayeredEvidenceAdmissionPipeline({
  semanticReader: new QueryConditionedSemanticEvidenceReader({
    verifier,
    timeoutMs: 25000,
  }),
});
const rows: Array<{
  id: string;
  family: string;
  positive: boolean;
  baselineGold: boolean;
  layeredGold: boolean;
  baselineAny: boolean;
  layeredAny: boolean;
  baselineAdmissions: number;
  layeredAdmissions: number;
  layeredGoldAdmissions: number;
  layeredWrongAdmissions: number;
  layeredAllSourceBound: boolean;
  degraded: boolean;
  latencyMs: number;
  stageReasons: string[];
}> = [];
try {
  for (const [index, q] of protocol.questions.entries()) {
    const hits = hitsFor(q);
    const legacy = assessRetrievalAnswerability(hits, q.query);
    const start = performance.now();
    const layered = await assessRetrievalAnswerabilityWithLayeredAdmission(
      hits,
      q.query,
      pipeline,
      { maxCandidates: 16 },
    );
    const elapsed = performance.now() - start;
    const unitByKey = new Map(
      hits.map((h) => [retrievalAnswerabilityCandidateKey(h), h.unitId]),
    );
    const goldId = q.goldUnitId ? uuid("f5:unit:" + q.goldUnitId) : null;
    const isGold = (key: string) =>
      Boolean(goldId && unitByKey.get(key) === goldId);
    const goldCount = layered.supportedCandidateKeys.filter(isGold).length;
    const wrongCount = layered.supportedCandidateKeys.length - goldCount;
    const byKey = new Map(
      layered.candidateSignals.map((s) => [s.candidateKey, s]),
    );
    const sourceBound = layered.supportedCandidateKeys.every((key) => {
      const s = byKey.get(key),
        h = hits.find((h) => retrievalAnswerabilityCandidateKey(h) === key);
      const span = s?.queryConditionedEvidence?.evidenceSpan;
      return Boolean(
        h &&
        span &&
        span.startOffset >= 0 &&
        span.endOffset > span.startOffset &&
        span.endOffset <= h.excerpt.trim().length,
      );
    });
    rows.push({
      id: q.id,
      family: q.family,
      positive: q.expected === "ANSWERS",
      baselineGold: legacy.supportedCandidateKeys.some(isGold),
      layeredGold: goldCount > 0,
      baselineAny: legacy.supportedCandidateKeys.length > 0,
      layeredAny: layered.supportedCandidateKeys.length > 0,
      baselineAdmissions: legacy.supportedCandidateKeys.length,
      layeredAdmissions: layered.supportedCandidateKeys.length,
      layeredGoldAdmissions: goldCount,
      layeredWrongAdmissions: wrongCount,
      layeredAllSourceBound: sourceBound,
      degraded: layered.candidateSignals.some(
        (s) => s.queryConditionedEvidence?.decision === "VERIFIER_ERROR",
      ),
      latencyMs: elapsed,
      stageReasons: layered.candidateSignals.flatMap((s) =>
        s.queryConditionedEvidence?.reason
          ? [s.queryConditionedEvidence.reason]
          : [],
      ),
    });
    if ((index + 1) % 10 === 0 || index + 1 === protocol.questions.length)
      console.error(`f5-run ${index + 1}/${protocol.questions.length}`);
  }
} finally {
  await verifier.dispose?.();
}
const positiveRows = rows.filter((r) => r.positive),
  negativeRows = rows.filter((r) => !r.positive);
const basePositive = positiveRows.filter((r) => r.baselineGold).length;
const candPositive = positiveRows.filter((r) => r.layeredGold).length;
const bOnly = positiveRows.filter(
  (r) => r.baselineGold && !r.layeredGold,
).length;
const cOnly = positiveRows.filter(
  (r) => !r.baselineGold && r.layeredGold,
).length;
function mcnemar(a: number, b: number) {
  const n = a + b;
  if (!n) return 1;
  let term = 2 ** -n,
    sum = term;
  for (let k = 1; k <= Math.min(a, b); k++) {
    term *= (n - k + 1) / k;
    sum += term;
  }
  return Math.min(1, 2 * sum);
}
function lowerWilson(k: number, n: number) {
  if (!n) return 0;
  const z = 1.95996398454,
    p = k / n,
    z2 = z * z;
  return (
    (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) /
    (1 + z2 / n)
  );
}
function at(xs: number[], p: number) {
  xs.sort((a, b) => a - b);
  return xs[Math.floor((xs.length - 1) * p)];
}
const negBase = negativeRows.filter((r) => r.baselineAny).length;
const negCand = negativeRows.filter((r) => r.layeredAny).length;
const totalAdmitted = rows.reduce((s, r) => s + r.layeredAdmissions, 0);
const correctAdmitted = rows.reduce((s, r) => s + r.layeredGoldAdmissions, 0);
const precision = totalAdmitted ? correctAdmitted / totalAdmitted : 0;
const wLower = lowerWilson(correctAdmitted, totalAdmitted);
const p = mcnemar(bOnly, cOnly);
const g = {
  primaryImproved: candPositive > basePositive && p < 0.05,
  negativeGuard: negCand <= negBase && negCand / 15 <= 0.1,
  precisionGuard: precision >= 0.8 && wLower >= 0.7,
  sourceBound: rows.every((r) => r.layeredAllSourceBound),
  readerFailures: rows.filter((r) => r.degraded).length,
};
const report = {
  schemaVersion: "akp.r5.functional-f5-result.v1",
  head,
  freezeCommit,
  freezeBlob: frozenBlob,
  evalHash: sha(frozenRaw),
  model,
  digest,
  cases: 95,
  positives: 80,
  negatives: 15,
  goldAdmission: {
    baseline: basePositive,
    candidate: candPositive,
    gained: cOnly,
    lost: bOnly,
    exactMcNemarTwoSidedP: p,
  },
  negativeFalseAcceptance: { baseline: negBase, candidate: negCand },
  admittedPrecision: {
    correctUnits: correctAdmitted,
    allAdmittedUnits: totalAdmitted,
    ratio: precision,
    wilson95Lower: wLower,
    grading: "STRICT_FROZEN_UNIT_AND_SOURCE_SPAN_ORACLE_NOT_OWNER_ADJUDICATION",
  },
  latencyMs: {
    p50: at(
      rows.map((r) => r.latencyMs),
      0.5,
    ),
    p95: at(
      rows.map((r) => r.latencyMs),
      0.95,
    ),
  },
  gates: g,
  outcome:
    g.primaryImproved && g.negativeGuard && g.precisionGuard && g.sourceBound
      ? "PROMOTE_F5_GENERIC"
      : "REJECT_F5_GENERIC",
  warning:
    "Supplied candidate admission fixture; not production queryKnowledge/private E2E. F3 owner adjudication is a separate gate.",
  privatePayloadIncluded: false,
};
await mkdir("reports/ci", { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
