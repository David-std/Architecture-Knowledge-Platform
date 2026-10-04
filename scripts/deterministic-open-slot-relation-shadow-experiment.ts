import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SearchHit } from "@akp/contracts";
import { collectCandidateAnswerabilitySignals } from "../packages/retrieval/src/answerability.js";

type Split = "development" | "heldout";

interface CaseFixture {
  id: string;
  split: Split;
  query: string;
  title: string;
  passage: string;
  expectedAnswerable: boolean;
  family:
    | "OPEN_SLOT_RELATION"
    | "MISSING_OPEN_SLOT"
    | "STRUCTURED_CUE_CONTROL"
    | "YES_NO_CONTROL";
}

interface Observation {
  id: string;
  split: Split;
  family: CaseFixture["family"];
  expectedAnswerable: boolean;
  query: string;
  baselineSupported: boolean;
  candidateSupported: boolean;
  baselineReason: string;
  requiredAnswerCues: string[];
  boundedRelationRoleMatched: boolean;
  openSlotQuestion: boolean;
  candidateNarrowed: boolean;
}

const CASES: CaseFixture[] = [
  {
    id: "dev-r8-producer-positive",
    split: "development",
    family: "OPEN_SLOT_RELATION",
    query: "Which service produces the boundary decision record?",
    title: "Ingress boundary relation",
    passage:
      "The ingress validation service produces the boundary decision record.",
    expectedAnswerable: true,
  },
  {
    id: "dev-r8-owner-negative",
    split: "development",
    family: "MISSING_OPEN_SLOT",
    query: "Who is the named human owner of the boundary decision record?",
    title: "Ingress boundary relation",
    passage:
      "The ingress validation service produces the boundary decision record.",
    expectedAnswerable: false,
  },
  {
    id: "dev-workflow-positive",
    split: "development",
    family: "OPEN_SLOT_RELATION",
    query: "What workflow follows the reviewed policy?",
    title: "Reviewed policy workflow",
    passage:
      "The approval workflow follows the reviewed policy before publication.",
    expectedAnswerable: true,
  },
  {
    id: "dev-cloud-region-negative",
    split: "development",
    family: "MISSING_OPEN_SLOT",
    query: "Which public cloud region hosts the managed production service?",
    title: "Managed production service",
    passage:
      "The managed production service is monitored continuously for availability.",
    expectedAnswerable: false,
  },
  {
    id: "dev-quantity-control",
    split: "development",
    family: "STRUCTURED_CUE_CONTROL",
    query: "How many days must production audit logs be retained?",
    title: "Production audit retention policy",
    passage:
      "Production audit logs must be retained for 365 days from creation.",
    expectedAnswerable: true,
  },
  {
    id: "dev-yes-no-control",
    split: "development",
    family: "YES_NO_CONTROL",
    query: "Can NEXO use QARO?",
    title: "NEXO integration",
    passage: "NEXO can use QARO for delivery.",
    expectedAnswerable: true,
  },
  {
    id: "hold-consumer-positive",
    split: "heldout",
    family: "OPEN_SLOT_RELATION",
    query: "Which service consumes the boundary decision record?",
    title: "Ingress boundary relation",
    passage:
      "The ingress validation service consumes the boundary decision record.",
    expectedAnswerable: true,
  },
  {
    id: "hold-sharing-approval-positive",
    split: "heldout",
    family: "OPEN_SLOT_RELATION",
    query: "What approval is required before public data sharing?",
    title: "Public data sharing policy",
    passage:
      "Public data may be shared with external partners only after security approval.",
    expectedAnswerable: true,
  },
  {
    id: "hold-human-reviewer-positive",
    split: "heldout",
    family: "OPEN_SLOT_RELATION",
    query: "Who reviews the retry policy before publication?",
    title: "Retry policy review",
    passage: "Avery Chen reviews the retry policy before publication.",
    expectedAnswerable: true,
  },
  {
    id: "hold-human-reviewer-negative",
    split: "heldout",
    family: "MISSING_OPEN_SLOT",
    query: "Who is the named human reviewer of the retry policy?",
    title: "Retry policy review",
    passage:
      "The retry policy is reviewed before publication and requires a bounded delay.",
    expectedAnswerable: false,
  },
  {
    id: "hold-approver-negative",
    split: "heldout",
    family: "MISSING_OPEN_SLOT",
    query: "Which human approver signs the public data sharing policy?",
    title: "Public data sharing policy",
    passage:
      "Public data sharing requires security approval before external distribution.",
    expectedAnswerable: false,
  },
  {
    id: "hold-rule-control",
    split: "heldout",
    family: "STRUCTURED_CUE_CONTROL",
    query: "Which policy governs retry windows?",
    title: "Retry policy",
    passage:
      "The retry policy requires a bounded delay before another attempt.",
    expectedAnswerable: true,
  },
];

function hit(index: number, item: CaseFixture): SearchHit {
  const suffix = String(index + 1).padStart(12, "0");
  return {
    documentId: `11111111-1111-4111-8111-${suffix}`,
    vaultId: "22222222-2222-4222-8222-222222222222",
    unitId: `33333333-3333-4333-8333-${suffix}`,
    unitType: "PARAGRAPH",
    document: {
      externalId: `open-slot-shadow-${item.id}`,
      path: `evals/open-slot/${item.id}.md`,
      title: item.title,
    },
    revision: "open-slot-shadow-v1",
    title: item.title,
    type: "claim",
    trust: "HUMAN_REVIEWED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1,
    reasons: ["experiment"],
    fusionContributions: [
      {
        channel: "lexical",
        rank: 1,
        channelWeight: 1,
        rawScore: 1,
        reason: "lexical:experiment",
      },
    ],
    excerpt: item.passage,
    citations: [],
  };
}

function normalizedTokens(value: string): string[] {
  return (
    value
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

const OPEN_SLOT_SHAPES = new Set([
  "who",
  "whom",
  "whose",
  "which",
  "what",
  "where",
  "quien",
  "quienes",
  "cual",
  "cuales",
  "donde",
]);

function openSlotQuestion(query: string): boolean {
  return OPEN_SLOT_SHAPES.has(normalizedTokens(query)[0] ?? "");
}

function candidateSupport(
  baselineSupported: boolean,
  baselineReason: string,
  requiredAnswerCues: readonly string[],
  boundedRelationRoleMatched: boolean,
  query: string,
): { supported: boolean; narrowed: boolean } {
  const narrow =
    baselineSupported &&
    baselineReason === "PASSAGE_TEXT_SUPPORT" &&
    requiredAnswerCues.length === 0 &&
    openSlotQuestion(query) &&
    !boundedRelationRoleMatched;
  return { supported: baselineSupported && !narrow, narrowed: narrow };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function summarize(rows: readonly Observation[]) {
  const positives = rows.filter((row) => row.expectedAnswerable);
  const negatives = rows.filter((row) => !row.expectedAnswerable);
  const metrics = (key: "baselineSupported" | "candidateSupported") => {
    const tp = positives.filter((row) => row[key]).length;
    const fn = positives.length - tp;
    const fp = negatives.filter((row) => row[key]).length;
    const tn = negatives.length - fp;
    return {
      answerableRecall: ratio(tp, positives.length),
      falseAcceptanceRate: ratio(fp, negatives.length),
      strictAccuracy: ratio(tp + tn, rows.length),
      falseAbstentions: fn,
      falseAcceptances: fp,
    };
  };
  return {
    cases: rows.length,
    positives: positives.length,
    negatives: negatives.length,
    baseline: metrics("baselineSupported"),
    candidate: metrics("candidateSupported"),
    narrowedCases: rows
      .filter((row) => row.candidateNarrowed)
      .map((row) => row.id),
  };
}

async function main(): Promise<void> {
  const observations: Observation[] = CASES.map((item, index) => {
    const signal = collectCandidateAnswerabilitySignals(
      [hit(index, item)],
      item.query,
    )[0];
    if (!signal) throw new Error(`missing signal for ${item.id}`);
    const candidate = candidateSupport(
      signal.passageSupport.supported,
      signal.passageSupport.reason,
      signal.passageSupport.requiredAnswerCues,
      signal.passageSupport.boundedRelationRoleMatched,
      item.query,
    );
    return {
      id: item.id,
      split: item.split,
      family: item.family,
      expectedAnswerable: item.expectedAnswerable,
      query: item.query,
      baselineSupported: signal.passageSupport.supported,
      candidateSupported: candidate.supported,
      baselineReason: signal.passageSupport.reason,
      requiredAnswerCues: [...signal.passageSupport.requiredAnswerCues],
      boundedRelationRoleMatched:
        signal.passageSupport.boundedRelationRoleMatched,
      openSlotQuestion: openSlotQuestion(item.query),
      candidateNarrowed: candidate.narrowed,
    };
  });

  const development = summarize(
    observations.filter((row) => row.split === "development"),
  );
  const heldout = summarize(
    observations.filter((row) => row.split === "heldout"),
  );
  const overall = summarize(observations);

  const candidateCausedFalseAbstentions = observations.filter(
    (row) =>
      row.expectedAnswerable &&
      row.baselineSupported &&
      !row.candidateSupported,
  );
  const falseAcceptancesRemoved = observations.filter(
    (row) =>
      !row.expectedAnswerable &&
      row.baselineSupported &&
      !row.candidateSupported,
  );

  const gates = {
    developmentRecallNoRegression:
      (development.candidate.answerableRecall ?? 0) >=
      (development.baseline.answerableRecall ?? 0),
    heldoutRecallNoRegression:
      (heldout.candidate.answerableRecall ?? 0) >=
      (heldout.baseline.answerableRecall ?? 0),
    developmentFalseAcceptanceNoRegression:
      (development.candidate.falseAcceptanceRate ?? 0) <=
      (development.baseline.falseAcceptanceRate ?? 0),
    heldoutFalseAcceptanceNoRegression:
      (heldout.candidate.falseAcceptanceRate ?? 0) <=
      (heldout.baseline.falseAcceptanceRate ?? 0),
    removesAtLeastOneFalseAcceptance: falseAcceptancesRemoved.length > 0,
    zeroCandidateCausedFalseAbstentions:
      candidateCausedFalseAbstentions.length === 0,
    heldoutOpenSlotPositiveAndNegativeCovered:
      observations.some(
        (row) =>
          row.split === "heldout" &&
          row.expectedAnswerable &&
          row.openSlotQuestion,
      ) &&
      observations.some(
        (row) =>
          row.split === "heldout" &&
          !row.expectedAnswerable &&
          row.openSlotQuestion,
      ),
  };

  const outcome = Object.values(gates).every(Boolean)
    ? "PROMOTE_TO_FULL_SHADOW"
    : "REJECT";

  const report = {
    schemaVersion: "akp.deterministic-open-slot-relation-shadow.v1",
    generatedAt: new Date().toISOString(),
    outcome,
    productionDefaultsChanged: false,
    runtimeChanged: false,
    singleIndependentVariable:
      "For cue-less open-slot WH questions, shadow deterministic support abstains when bounded relation-role matching is false.",
    candidateRule: {
      queryShape:
        "first normalized token in WHO/WHOM/WHOSE/WHICH/WHAT/WHERE (plus ES equivalents)",
      appliesOnlyWhen: [
        "baseline deterministic support is true",
        "baseline reason is PASSAGE_TEXT_SUPPORT",
        "requiredAnswerCues is empty",
        "boundedRelationRoleMatched is false",
      ],
      canCreateSupport: false,
    },
    dataset: {
      version: "open-slot-relation-shadow-v1",
      hash: createHash("sha256").update(JSON.stringify(CASES)).digest("hex"),
      cases: CASES.length,
      developmentCases: CASES.filter((item) => item.split === "development")
        .length,
      heldoutCases: CASES.filter((item) => item.split === "heldout").length,
      tuningAfterHeldout: false,
    },
    gates,
    summaries: { development, heldout, overall },
    candidateCausedFalseAbstentions: candidateCausedFalseAbstentions.map(
      (row) => row.id,
    ),
    falseAcceptancesRemoved: falseAcceptancesRemoved.map((row) => row.id),
    observations,
    limitations: [
      "This is a supplied-passage deterministic-support probe, not retrieval quality.",
      "It does not change production support-verifier behavior.",
      "It does not validate ordinary-prose semantic fallback.",
      "PROMOTE_TO_FULL_SHADOW only permits evaluation against the frozen admission/R8 packs.",
    ],
  };

  const output = path.resolve(
    process.env.AKP_OPEN_SLOT_SHADOW_REPORT ??
      "reports/ci/deterministic-open-slot-relation-shadow.json",
  );
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((error: unknown) => {
  process.stderr.write(
    (error instanceof Error ? (error.stack ?? error.message) : String(error)) +
      "\n",
  );
  process.exitCode = 1;
});
