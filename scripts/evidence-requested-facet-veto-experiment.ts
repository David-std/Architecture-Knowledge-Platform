// Experimental evidence only: never changes the integration-branch admission default.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assessRetrievalAnswerability,
  retrievalAnswerabilityCandidateKey,
} from "../packages/retrieval/src/index.js";
import {
  loadEvidenceAdmissionPack,
  type EvidenceAdmissionCase,
} from "./evidence-admission-pack.js";

const BASELINE_SHA = "8ba789faae9b66339abfd5b125461d048dbb8d5a";

type Summary = {
  questions: number;
  answerableRecall: number | null;
  falseAcceptances: number;
  falseAcceptanceRate: number | null;
  admittedPrecision: number | null;
  wrongAdmissions: number;
  strictAccuracy: number | null;
};

type MeasuredRow = {
  entry: EvidenceAdmissionCase;
  baseline: string[];
  candidate: string[];
  diagnostics: Array<{
    unit: string;
    baseline: boolean;
    facet: string | null;
    selectors: string[];
    facetMatched: boolean;
    selectorsMatched: boolean;
    accepted: boolean;
  }>;
};

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function ascii(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("und")
    .replace(/[¿?¡!.,;:()[\]{}"'`]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function tokens(value: string): string[] {
  return ascii(value).match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [];
}

const FACET_STOP = new Set([
  "a", "an", "the", "el", "la", "los", "las", "un", "una", "unos", "unas",
  "is", "are", "was", "were", "es", "son", "era", "eran",
  "named", "human", "nombre", "named", "called",
]);

function canonical(token: string): string {
  const value = token.toLocaleLowerCase("und");
  if (value.length > 4 && value.endsWith("es")) return value.slice(0, -2);
  if (value.length > 4 && value.endsWith("s")) return value.slice(0, -1);
  return value;
}

function phraseHead(phrase: string, mode: "FIRST" | "LAST"): string | null {
  const values = tokens(phrase).filter((token) => !FACET_STOP.has(token));
  if (values.length === 0) return null;
  return canonical(mode === "FIRST" ? values[0]! : values.at(-1)!);
}

function requestedSelectors(query: string): string[][] {
  const normalized = ascii(query);
  const selectors: string[][] = [];
  for (const match of normalized.matchAll(/\b(?:last|previous|prior|this|next|one|two|three|four|1|2|3|4)\s+(?:day|week|month|quarter|year)s?(?:\s+ago)?\b/gu)) {
    selectors.push(tokens(match[0]).map(canonical));
  }
  for (const token of tokens(normalized)) {
    if (/^[a-z]{1,8}\d{1,4}$/u.test(token)) selectors.push([canonical(token)]);
  }
  return selectors;
}

function withoutSelectorPhrases(query: string): string {
  return ascii(query)
    .replace(/\b(?:last|previous|prior|this|next|one|two|three|four|1|2|3|4)\s+(?:day|week|month|quarter|year)s?(?:\s+ago)?\b/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function requestedFacet(query: string): string | null {
  const normalized = withoutSelectorPhrases(query);
  let match: RegExpMatchArray | null;

  match = normalized.match(/^who\s+is\s+(?:the\s+)?(.+?)(?=\s+(?:for|of|in|on|at)\b|$)/u);
  if (match?.[1]) return phraseHead(match[1], "LAST");

  match = normalized.match(/^which\s+([\p{L}\p{N}-]+)/u);
  if (match?.[1]) return phraseHead(match[1], "FIRST");

  match = normalized.match(/^what\s+(?:is|was|are|were)\s+(?:the\s+)?(.+?)(?=\s+(?:of|for|in|on|at|during|to)\b|$)/u);
  if (match?.[1]) return phraseHead(match[1], "LAST");

  match = normalized.match(/^how\s+much\s+(?:is|was|are|were)\s+(?:the\s+)?(.+?)(?=\s+(?:per|for|in|on|at)\b|$)/u);
  if (match?.[1]) return phraseHead(match[1], "LAST");

  match = normalized.match(/^quien\s+es\s+(?:el\s+|la\s+)?(.+?)(?=\s+(?:de|del|para|en)\b|$)/u);
  if (match?.[1]) return phraseHead(match[1], "LAST");

  match = normalized.match(/^cual\s+es\s+(?:el\s+|la\s+|los\s+|las\s+)?(.+?)(?=\s+(?:de|del|para|en)\b|$)/u);
  if (match?.[1]) return phraseHead(match[1], "FIRST");

  match = normalized.match(/^como\s+se\s+llama\s+(?:el\s+|la\s+)?(.+?)(?=\s+(?:de|del|para|en)\b|$)/u);
  if (match?.[1]) return phraseHead(match[1], "FIRST");

  match = normalized.match(/^que\s+([\p{L}\p{N}-]+)\b/u);
  if (match?.[1] && !["se", "es", "son", "hay"].includes(match[1])) {
    return phraseHead(match[1], "FIRST");
  }

  return null;
}

function facetContract(hit: EvidenceAdmissionCase["hits"][number], query: string) {
  const facet = requestedFacet(query);
  const selectors = requestedSelectors(query);
  const scope = new Set(
    tokens(`${hit.title ?? ""} ${hit.excerpt}`).map(canonical),
  );
  const facetMatched = facet === null || scope.has(facet);
  const selectorsMatched = selectors.every((selector) =>
    selector.every((token) => scope.has(token)),
  );
  return {
    facet,
    selectors: selectors.map((selector) => selector.join(" ")),
    facetMatched,
    selectorsMatched,
    accepted: facetMatched && selectorsMatched,
  };
}

function measure(entries: readonly EvidenceAdmissionCase[]): MeasuredRow[] {
  return entries.map((entry) => {
    const baseline = assessRetrievalAnswerability(entry.hits, entry.question.query);
    const baselineKeys = new Set(baseline.supportedCandidateKeys);
    const baselineUnits: string[] = [];
    const candidateUnits: string[] = [];
    const diagnostics: MeasuredRow["diagnostics"] = [];
    for (const hit of entry.hits) {
      const key = retrievalAnswerabilityCandidateKey(hit);
      const unit = entry.unitIdByCandidateKey.get(key);
      if (!unit) throw new Error("REQUESTED_FACET_LABEL_MISSING");
      const baselineSupported = baselineKeys.has(key);
      if (baselineSupported) baselineUnits.push(unit);
      const contract = facetContract(hit, entry.question.query);
      const accepted = baselineSupported && contract.accepted;
      if (accepted) candidateUnits.push(unit);
      diagnostics.push({
        unit,
        baseline: baselineSupported,
        ...contract,
        accepted,
      });
    }
    return {
      entry,
      baseline: baselineUnits,
      candidate: candidateUnits,
      diagnostics,
    };
  });
}

function summarize(rows: readonly MeasuredRow[], select: (row: MeasuredRow) => readonly string[]): Summary {
  let answerable = 0;
  let hit = 0;
  let negatives = 0;
  let falseAcceptances = 0;
  let admittedUnits = 0;
  let correctUnits = 0;
  let wrongAdmissions = 0;
  let strict = 0;
  for (const row of rows) {
    const selected = [...new Set(select(row))];
    const gold = new Set(row.entry.question.gold);
    const acceptable = new Set(row.entry.question.acceptable ?? []);
    const wrong = selected.filter((unit) => !gold.has(unit) && !acceptable.has(unit));
    const goldHit = selected.some((unit) => gold.has(unit));
    admittedUnits += selected.length;
    correctUnits += selected.length - wrong.length;
    wrongAdmissions += wrong.length;
    if (gold.size > 0) {
      answerable += 1;
      if (goldHit) hit += 1;
      if (goldHit && wrong.length === 0) strict += 1;
    } else {
      negatives += 1;
      if (selected.length > 0) falseAcceptances += 1;
      else strict += 1;
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
  };
}

const ge = (candidate: number | null, baseline: number | null) =>
  baseline === null ? candidate === null : candidate !== null && candidate >= baseline;
const le = (candidate: number | null, baseline: number | null) =>
  baseline === null ? candidate === null : candidate !== null && candidate <= baseline;

function compare(rows: readonly MeasuredRow[]) {
  const baseline = summarize(rows, (row) => row.baseline);
  const candidate = summarize(rows, (row) => row.candidate);
  const safe =
    ge(candidate.answerableRecall, baseline.answerableRecall) &&
    ge(candidate.admittedPrecision, baseline.admittedPrecision) &&
    le(candidate.falseAcceptanceRate, baseline.falseAcceptanceRate) &&
    candidate.wrongAdmissions <= baseline.wrongAdmissions &&
    ge(candidate.strictAccuracy, baseline.strictAccuracy);
  const improves =
    candidate.falseAcceptances < baseline.falseAcceptances ||
    candidate.wrongAdmissions < baseline.wrongAdmissions ||
    (candidate.admittedPrecision ?? -1) > (baseline.admittedPrecision ?? -1) ||
    (candidate.strictAccuracy ?? -1) > (baseline.strictAccuracy ?? -1);
  return { baseline, candidate, safe, improves };
}

const { manifest, cases } = await loadEvidenceAdmissionPack(["development", "heldout"]);
const measured = measure(cases);
const development = measured.filter((row) => row.entry.domain.split === "development");
const heldout = measured.filter((row) => row.entry.domain.split === "heldout");
const audit = (manifest as { alignmentAudit?: { version: number; development: Array<{questionId:string;family:string}>; independent: Array<{questionId:string;family:string}> } }).alignmentAudit;
if (!audit || audit.version !== 1) throw new Error("REQUESTED_FACET_ALIGNMENT_AUDIT_INVALID");
const devFamilies = new Set(audit.development.map((row) => row.family));
if (audit.independent.some((row) => devFamilies.has(row.family))) {
  throw new Error("REQUESTED_FACET_ALIGNMENT_FAMILY_OVERLAP");
}
const byId = new Map(measured.map((row) => [row.entry.question.id, row]));
const auditDevelopment = audit.development.map((row) => {
  const resolved = byId.get(row.questionId);
  if (!resolved) throw new Error("REQUESTED_FACET_AUDIT_CASE_MISSING");
  return resolved;
});
const auditIndependent = audit.independent.map((row) => {
  const resolved = byId.get(row.questionId);
  if (!resolved) throw new Error("REQUESTED_FACET_AUDIT_CASE_MISSING");
  return resolved;
});

const developmentResult = compare(development);
let heldoutResult: ReturnType<typeof compare> | { status: string } = {
  status: "NOT_EVALUATED_DEVELOPMENT_REJECTED",
};
let familyDisjointResult: ReturnType<typeof compare> | { status: string } = {
  status: "NOT_EVALUATED_DEVELOPMENT_REJECTED",
};
let outcome: "PROMOTE" | "REJECT" = "REJECT";

if (developmentResult.safe && developmentResult.improves) {
  heldoutResult = compare(heldout);
  familyDisjointResult = compare(auditIndependent);
  const heldoutPass = heldoutResult.safe && heldoutResult.improves;
  const familyPass = familyDisjointResult.safe;
  outcome = heldoutPass && familyPass ? "PROMOTE" : "REJECT";
}

const changedRows = measured.flatMap((row) => {
  const before = [...row.baseline].sort();
  const after = [...row.candidate].sort();
  if (before.join("\n") === after.join("\n")) return [];
  return [{
    id: row.entry.question.id,
    split: row.entry.domain.split,
    query: row.entry.question.query,
    gold: row.entry.question.gold,
    before,
    after,
    removed: before.filter((unit) => !after.includes(unit)),
    diagnostics: row.diagnostics.filter((item) => item.baseline && !item.accepted),
  }];
});

const datasetHash = hash(cases.map((entry) => ({
  split: entry.domain.split,
  id: entry.question.id,
  query: entry.question.query,
  gold: entry.question.gold,
  acceptable: entry.question.acceptable ?? [],
  passages: entry.hits.map((hit) => [hit.document.externalId, hit.title, hit.excerpt]),
})));

const report = {
  schemaVersion: "akp.requested-facet-veto.v1",
  outcome,
  promotionScope: outcome === "PROMOTE" ? "NEXT_VALIDATION_STAGE_ONLY" : "NONE",
  productionDefaultChanged: false,
  enforcementEnabled: false,
  privateFreshValidationRequired: true,
  blindHoldoutRequired: true,
  contract: {
    hypothesis: "A conservative query-shape contract that requires an explicitly requested nominal facet and explicit compact/relative selectors to occur in the same candidate scope can veto topical missing-slot admissions without creating support.",
    failure_stage: "ADMISSION_FALSE_POSITIVE",
    baseline_sha: BASELINE_SHA,
    candidate_sha: process.env.AKP_CANDIDATE_SHA ?? process.env.GITHUB_SHA ?? "LOCAL_UNCOMMITTED",
    dataset_version: `${manifest.id}@${manifest.version}/alignmentAudit@${audit.version}`,
    dataset_hash: datasetHash,
    index_generation: "SUPPLIED_CANDIDATE_ADMISSION_NOT_APPLICABLE",
    embedding_model_revision: "NOT_APPLICABLE",
    reranker_revision: "NOT_APPLICABLE",
    reader_revision: "DETERMINISTIC_REQUESTED_FACET_V1",
    configuration_hash: hash({ experiment: "requested-facet-veto-v1" }),
    single_independent_variable: "Intersect deterministic-supported candidates with a conservative requested-facet/selector presence contract; the contract may veto but never add support.",
    primary_metric: "false acceptance and wrong-admission reduction at unchanged answerable recall",
    guardrail_metrics: ["answerable recall", "admitted precision", "strict accuracy"],
    expected_failure_if_wrong: "Development loses answerable recall/precision or does not improve; source-disjoint or family-disjoint regression then rejects the candidate.",
    promotion_rule: "Development must be safe and improve before source-disjoint/family-disjoint evaluation; all evaluated guardrails must be non-regressing and source-disjoint must strictly improve. PROMOTE advances only to a new blind public set plus fresh-private/R8 validation.",
    rollback: "Close the experiment without merge; #38 remains draft and its production admission default remains unchanged.",
  },
  development: developmentResult,
  heldout: heldoutResult,
  alignmentAudit: {
    status: "FROZEN",
    familyDisjoint: true,
    developmentFamilies: [...new Set(audit.development.map((row) => row.family))].sort(),
    independentFamilies: [...new Set(audit.independent.map((row) => row.family))].sort(),
    development: compare(auditDevelopment),
    independent: familyDisjointResult,
    caveat: "The independent partition is family-disjoint but previously inspected and is not an untouched blind holdout.",
  },
  changedRows,
  limitations: [
    "This is a veto-only supplied-candidate admission experiment; it does not measure retrieval, reranking, ContextPacket or generation quality.",
    "The public heldout and frozen family-disjoint regression partitions have been inspected; PROMOTE cannot authorize a production default change.",
    "A new blind public set, fixed-gold R8 and fresh private E2E remain mandatory before any integration decision.",
  ],
};

const output = path.resolve(process.env.AKP_REQUESTED_FACET_REPORT ?? "reports/ci/requested-facet-veto.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
