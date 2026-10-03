// Experimental evidence only: never changes the production admission default.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assessRetrievalAnswerability,
  LOCAL_MULTILINGUAL_QA_EVIDENCE_MODEL,
  LOCAL_MULTILINGUAL_QA_EVIDENCE_REVISION,
  LocalMultilingualQaEvidenceVerifier,
  retrievalAnswerabilityCandidateKey,
} from "../packages/retrieval/src/index.js";
import {
  loadEvidenceAdmissionPack,
  type EvidenceAdmissionCase,
} from "./evidence-admission-pack.js";

const BASELINE_SHA = "e5f865550fb67a9ec4c51f5e675b04668f49cc87";
const MODEL_FLOOR = 0.000001;

type Partition = "development" | "independent";
type Citation = { unit: string; quote: string };
type AuditItem = { questionId: string; family: string; citations: Citation[] };
type Audit = {
  version: number;
  frozenAt: string;
  description: string;
  development: AuditItem[];
  independent: AuditItem[];
};
type Candidate = {
  unit: string;
  baseline: boolean;
  decision: "SUPPORTS" | "CONTRADICTS" | "INSUFFICIENT" | "NOT_RUN";
  score: number | null;
  span: { startOffset: number; endOffset: number } | null;
};
type Row = {
  partition: Partition;
  family: string;
  entry: EvidenceAdmissionCase;
  baseline: string[];
  candidates: Candidate[];
  goldSpans: Map<string, { startOffset: number; endOffset: number }>;
};
type Summary = {
  questions: number;
  answerableRecall: number | null;
  falseAcceptances: number;
  falseAcceptanceRate: number | null;
  admittedPrecision: number | null;
  wrongAdmissions: number;
  strictAccuracy: number | null;
  spanContainment: number | null;
};

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function loadAudit(manifest: unknown): Audit {
  const audit = (manifest as { alignmentAudit?: Audit }).alignmentAudit;
  if (!audit || audit.version !== 1 || !audit.description.trim()) {
    throw new Error("QA_VETO_ALIGNMENT_AUDIT_INVALID");
  }
  const development = new Set(audit.development.map((row) => row.family));
  if (audit.independent.some((row) => development.has(row.family))) {
    throw new Error("QA_VETO_ALIGNMENT_FAMILY_OVERLAP");
  }
  return audit;
}

function resolve(
  audit: Audit,
  cases: readonly EvidenceAdmissionCase[],
): Array<{
  partition: Partition;
  family: string;
  entry: EvidenceAdmissionCase;
  goldSpans: Map<string, { startOffset: number; endOffset: number }>;
}> {
  const byId = new Map(cases.map((entry) => [entry.question.id, entry]));
  const rows: Array<{
    partition: Partition;
    family: string;
    entry: EvidenceAdmissionCase;
    goldSpans: Map<string, { startOffset: number; endOffset: number }>;
  }> = [];
  for (const [partition, items, split] of [
    ["development", audit.development, "development"],
    ["independent", audit.independent, "heldout"],
  ] as const) {
    for (const item of items) {
      const entry = byId.get(item.questionId);
      if (!entry || entry.domain.split !== split) {
        throw new Error("QA_VETO_ALIGNMENT_SOURCE_SPLIT_INVALID");
      }
      const citationUnits = item.citations
        .map((citation) => citation.unit)
        .sort();
      if (
        citationUnits.join("\n") !== [...entry.question.gold].sort().join("\n")
      ) {
        throw new Error("QA_VETO_ALIGNMENT_GOLD_MISMATCH");
      }
      const goldSpans = new Map<
        string,
        { startOffset: number; endOffset: number }
      >();
      for (const citation of item.citations) {
        const hit = entry.hits.find(
          (candidate) => candidate.document.externalId === citation.unit,
        );
        if (!hit) throw new Error("QA_VETO_ALIGNMENT_UNIT_MISSING");
        const startOffset = hit.excerpt.indexOf(citation.quote);
        if (
          startOffset < 0 ||
          hit.excerpt.indexOf(citation.quote, startOffset + 1) >= 0
        ) {
          throw new Error("QA_VETO_ALIGNMENT_QUOTE_NOT_UNIQUE");
        }
        goldSpans.set(citation.unit, {
          startOffset,
          endOffset: startOffset + citation.quote.length,
        });
      }
      rows.push({ partition, family: item.family, entry, goldSpans });
    }
  }
  return rows;
}

async function measure(
  source: ReturnType<typeof resolve>,
  verifier: LocalMultilingualQaEvidenceVerifier,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (const row of source) {
    const { entry } = row;
    const baseline = assessRetrievalAnswerability(
      entry.hits,
      entry.question.query,
    );
    const baselineKeys = new Set(baseline.supportedCandidateKeys);
    const candidates: Candidate[] = [];
    for (const hit of entry.hits) {
      const key = retrievalAnswerabilityCandidateKey(hit);
      const unit = entry.unitIdByCandidateKey.get(key);
      if (!unit) throw new Error("QA_VETO_LABEL_MISSING");
      if (!baselineKeys.has(key)) {
        candidates.push({
          unit,
          baseline: false,
          decision: "NOT_RUN",
          score: null,
          span: null,
        });
        continue;
      }
      const result = await verifier.verify({
        query: entry.question.query,
        candidateKey: key,
        title: hit.title,
        ...(hit.headingPath ? { headingPath: hit.headingPath } : {}),
        passage: hit.excerpt,
        unitType: hit.unitType ?? null,
        parentUnitType: hit.parentUnitType ?? null,
        documentType: hit.type,
      });
      candidates.push({
        unit,
        baseline: true,
        decision: result.decision,
        score: result.score ?? null,
        span: result.evidenceSpan ?? null,
      });
    }
    rows.push({
      ...row,
      baseline: baseline.supportedCandidateKeys.map((key) => {
        const unit = entry.unitIdByCandidateKey.get(key);
        if (!unit) throw new Error("QA_VETO_BASELINE_LABEL_MISSING");
        return unit;
      }),
      candidates,
    });
  }
  return rows;
}

const admitted = (row: Row, threshold: number) =>
  row.candidates
    .filter(
      (candidate) =>
        candidate.baseline &&
        candidate.decision === "SUPPORTS" &&
        candidate.score !== null &&
        candidate.score >= threshold,
    )
    .map((candidate) => candidate.unit);

function summarize(
  rows: readonly Row[],
  select: (row: Row) => readonly string[],
): Summary {
  let answerable = 0;
  let hit = 0;
  let negatives = 0;
  let falseAcceptances = 0;
  let admittedUnits = 0;
  let correctUnits = 0;
  let wrongAdmissions = 0;
  let strict = 0;
  let spanExpected = 0;
  let spanContained = 0;
  for (const row of rows) {
    const selected = [...new Set(select(row))];
    const gold = new Set(row.entry.question.gold);
    const acceptable = new Set(row.entry.question.acceptable ?? []);
    const wrong = selected.filter(
      (unit) => !gold.has(unit) && !acceptable.has(unit),
    );
    const goldHit = selected.some((unit) => gold.has(unit));
    admittedUnits += selected.length;
    correctUnits += selected.length - wrong.length;
    wrongAdmissions += wrong.length;
    if (gold.size) {
      answerable += 1;
      if (goldHit) hit += 1;
      if (goldHit && !wrong.length) strict += 1;
    } else {
      negatives += 1;
      if (selected.length) falseAcceptances += 1;
      else strict += 1;
    }
    for (const unit of selected.filter((value) => gold.has(value))) {
      const expected = row.goldSpans.get(unit);
      if (!expected) continue;
      spanExpected += 1;
      const actual = row.candidates.find(
        (candidate) => candidate.unit === unit,
      )?.span;
      if (
        actual &&
        actual.startOffset >= expected.startOffset &&
        actual.endOffset <= expected.endOffset
      ) {
        spanContained += 1;
      }
    }
  }
  return {
    questions: rows.length,
    answerableRecall: ratio(hit, answerable),
    falseAcceptances,
    falseAcceptanceRate: ratio(falseAcceptances, negatives),
    admittedPrecision: ratio(correctUnits, admittedUnits),
    wrongAdmissions,
    strictAccuracy: ratio(strict, rows.length),
    spanContainment: ratio(spanContained, spanExpected),
  };
}

const ge = (candidate: number | null, baseline: number | null) =>
  baseline === null
    ? candidate === null
    : candidate !== null && candidate >= baseline;
const le = (candidate: number | null, baseline: number | null) =>
  baseline === null
    ? candidate === null
    : candidate !== null && candidate <= baseline;
const developmentPass = (candidate: Summary, baseline: Summary) =>
  candidate.falseAcceptances === 0 &&
  candidate.wrongAdmissions === 0 &&
  candidate.admittedPrecision === 1 &&
  candidate.spanContainment === 1 &&
  ge(candidate.answerableRecall, baseline.answerableRecall) &&
  ge(candidate.strictAccuracy, baseline.strictAccuracy);

const { manifest, cases } = await loadEvidenceAdmissionPack([
  "development",
  "heldout",
]);
const audit = loadAudit(manifest);
const resolved = resolve(audit, cases);
const verifier = new LocalMultilingualQaEvidenceVerifier({
  minimumSupportScore: MODEL_FLOOR,
  cacheDir: process.env.AKP_MODEL_CACHE_DIR,
  localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
});
let measured: Row[];
try {
  measured = await measure(resolved, verifier);
} finally {
  await verifier.dispose();
}

const development = measured.filter((row) => row.partition === "development");
const independent = measured.filter((row) => row.partition === "independent");
const baselineDevelopment = summarize(development, (row) => row.baseline);
const scores = development.flatMap((row) =>
  row.candidates.flatMap((candidate) =>
    candidate.baseline &&
    candidate.decision === "SUPPORTS" &&
    candidate.score !== null
      ? [candidate.score]
      : [],
  ),
);
const thresholds = [
  ...new Set([
    MODEL_FLOOR,
    0.01,
    0.025,
    0.05,
    0.075,
    0.1,
    0.15,
    0.2,
    0.3,
    0.4,
    0.5,
    0.6,
    0.7,
    0.8,
    0.9,
    0.95,
    0.99,
    1,
    ...scores.map((score) => Number(score.toFixed(9))),
  ]),
].sort((a, b) => a - b);
const sweep = thresholds.map((threshold) => ({
  threshold,
  summary: summarize(development, (row) => admitted(row, threshold)),
}));
const calibration =
  sweep.find((row) => developmentPass(row.summary, baselineDevelopment)) ??
  null;

let outcome: "PROMOTE" | "REJECT" = "REJECT";
let independentResult: unknown = {
  status: "NOT_EVALUATED_CALIBRATION_REJECTED",
};
if (calibration) {
  const baseline = summarize(independent, (row) => row.baseline);
  const candidate = summarize(independent, (row) =>
    admitted(row, calibration.threshold),
  );
  const safe =
    ge(candidate.answerableRecall, baseline.answerableRecall) &&
    ge(candidate.admittedPrecision, baseline.admittedPrecision) &&
    le(candidate.falseAcceptanceRate, baseline.falseAcceptanceRate) &&
    candidate.wrongAdmissions <= baseline.wrongAdmissions &&
    ge(candidate.strictAccuracy, baseline.strictAccuracy) &&
    candidate.spanContainment === 1;
  const improves =
    candidate.falseAcceptances < baseline.falseAcceptances ||
    candidate.wrongAdmissions < baseline.wrongAdmissions ||
    (candidate.strictAccuracy ?? -1) > (baseline.strictAccuracy ?? -1);
  outcome = safe && improves ? "PROMOTE" : "REJECT";
  independentResult = {
    status: "EVALUATED_AFTER_THRESHOLD_FREEZE",
    baseline,
    candidate,
    safe,
    improves,
  };
}

const datasetHash = hash(
  resolved.map((row) => ({
    partition: row.partition,
    family: row.family,
    questionId: row.entry.question.id,
    query: row.entry.question.query,
    gold: row.entry.question.gold,
    acceptable: row.entry.question.acceptable ?? [],
    passages: row.entry.hits.map((hit) => [
      hit.document.externalId,
      hit.excerpt,
    ]),
  })),
);
const report = {
  schemaVersion: "akp.qa-veto-family-disjoint.v1",
  outcome,
  promotionScope: outcome === "PROMOTE" ? "NEXT_VALIDATION_STAGE_ONLY" : "NONE",
  productionDefaultChanged: false,
  enforcementEnabled: false,
  privateFreshValidationRequired: true,
  contract: {
    hypothesis:
      "A source-bound extractive QA verifier used only as a veto on deterministic admissions can remove missing-slot false positives without creating new support or reducing family-disjoint answerable recall.",
    failure_stage: "ADMISSION_FALSE_POSITIVE",
    baseline_sha: BASELINE_SHA,
    candidate_sha:\n      process.env.AKP_CANDIDATE_SHA ??\n      process.env.GITHUB_SHA ??\n      "LOCAL_UNCOMMITTED",
    dataset_version: `${manifest.id}@${manifest.version}/alignmentAudit@${audit.version}`,
    dataset_hash: datasetHash,
    index_generation: "SUPPLIED_CANDIDATE_ADMISSION_NOT_APPLICABLE",
    embedding_model_revision: "NOT_APPLICABLE",
    reranker_revision: "NOT_APPLICABLE",
    reader_revision: `${LOCAL_MULTILINGUAL_QA_EVIDENCE_MODEL}@${LOCAL_MULTILINGUAL_QA_EVIDENCE_REVISION}`,
    configuration_hash: hash({
      experiment: "qa-veto-family-disjoint-v1",
      model: LOCAL_MULTILINGUAL_QA_EVIDENCE_REVISION,
    }),
    single_independent_variable:
      "Intersect deterministic-supported candidate keys with source-bound QA SUPPORTS at a development-calibrated threshold; QA may veto but never add support.",
    primary_metric:
      "family-disjoint false acceptance / wrong admission reduction at unchanged answerable recall",
    guardrail_metrics: [
      "answerable recall",
      "admitted precision",
      "strict accuracy",
      "gold source-span containment",
    ],
    expected_failure_if_wrong:
      "No development threshold preserves recall with zero false/wrong admissions, or independent families regress.",
    promotion_rule:
      "Calibrate on development only; evaluate independent families only after threshold freeze; require no guardrail regression, exact source-span containment, and a strict frontier improvement.",
    rollback:
      "Close the experiment without merge; production admission remains deterministic and unchanged.",
  },
  model: {
    provider: "local-transformers-js",
    model: LOCAL_MULTILINGUAL_QA_EVIDENCE_MODEL,
    revision: LOCAL_MULTILINGUAL_QA_EVIDENCE_REVISION,
  },
  development: {
    families: [...new Set(development.map((row) => row.family))].sort(),
    baseline: baselineDevelopment,
    thresholdsEvaluated: sweep.length,
    calibration,
  },
  independent: {
    families: [...new Set(independent.map((row) => row.family))].sort(),
    ...((independentResult as object) ?? {}),
  },
  limitations: [
    "The independent partition is family-disjoint but not an untouched blind holdout.",
    "This measures supplied-candidate admission, not retrieval quality or private-vault E2E quality.",
    "PROMOTE only advances the candidate to fresh-private validation; it never changes the production default.",
  ],
};
const output = path.resolve(
  process.env.AKP_QA_VETO_FAMILY_DISJOINT_REPORT ??
    "reports/ci/qa-veto-family-disjoint.json",
);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
