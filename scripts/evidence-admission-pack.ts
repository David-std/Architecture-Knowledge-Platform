import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SearchHit } from "@akp/contracts";
import {
  diagnoseEvidencePipeline,
  evidenceCandidateDiagnostic,
  retrievalAnswerabilityCandidateKey,
  type QueryConditionedEvidenceSpan,
  type RetrievalAnswerabilityAssessment,
} from "../packages/retrieval/src/index.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const packRoot = path.join(repositoryRoot, "evals/generic/evidence-admission");

export type Split = "development" | "heldout";

interface PackUnit {
  id: string;
  documentType: string;
  unitType: NonNullable<SearchHit["unitType"]>;
  title: string;
  headingPath: string[];
  text: string;
}

interface PackQuestion {
  id: string;
  family: string;
  intent: string;
  language: string;
  query: string;
  gold: string[];
  acceptable?: string[];
  challenges: string[];
}

interface PackDomain {
  id: string;
  split: Split;
  language: string;
  units: PackUnit[];
  questions: PackQuestion[];
}

interface Manifest {
  id: string;
  version: number;
  splits: Record<Split, string[]>;
  intents: string[];
  challenges: Record<string, string>;
}

export interface EvidenceAdmissionCase {
  domain: PackDomain;
  question: PackQuestion;
  hits: SearchHit[];
  unitIdByCandidateKey: Map<string, string>;
}

export type EvidenceAdmissionDecision =
  | readonly string[]
  | Pick<
      RetrievalAnswerabilityAssessment,
      "supportedCandidateKeys" | "candidateSignals"
    >;

/** A legacy key list or an assessment retaining the actual verifier trace. */
export type EvidenceAdmitter = (
  hits: readonly SearchHit[],
  query: string,
) => Promise<EvidenceAdmissionDecision>;

export interface EvidenceAdmissionEvaluationOptions {
  goldSpans?: ReadonlyMap<
    string,
    ReadonlyMap<string, QueryConditionedEvidenceSpan>
  >;
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
    revision: `evidence-admission-generalization/${domain.id}`,
    title: unit.title,
    type: unit.documentType,
    trust: "MACHINE_SUPPORTED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1 / rank,
    reasons: ["evidence-admission-generalization"],
    fusionContributions: [
      {
        channel: "vector",
        rank,
        channelWeight: 1,
        rawScore: 0.5,
        reason: "vector:evidence-admission-generalization",
      },
    ],
    excerpt: unit.text,
    citations: [],
  };
}

/** Deterministic, seed-free candidate order so no unit is favored by position. */
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

function validateDomain(domain: PackDomain, manifest: Manifest, file: string) {
  const unitIds = new Set<string>();
  for (const unit of domain.units) {
    if (unitIds.has(unit.id))
      throw new Error(`${file}: duplicate unit ${unit.id}`);
    if (!unit.text.trim() || !unit.title.trim()) {
      throw new Error(`${file}: unit ${unit.id} needs a title and text`);
    }
    unitIds.add(unit.id);
  }
  const questionIds = new Set<string>();
  for (const question of domain.questions) {
    if (questionIds.has(question.id)) {
      throw new Error(`${file}: duplicate question ${question.id}`);
    }
    questionIds.add(question.id);
    if (!manifest.intents.includes(question.intent)) {
      throw new Error(
        `${file}: ${question.id} has unknown intent ${question.intent}`,
      );
    }
    for (const challenge of question.challenges) {
      if (!(challenge in manifest.challenges)) {
        throw new Error(
          `${file}: ${question.id} has unknown challenge ${challenge}`,
        );
      }
    }
    for (const label of [...question.gold, ...(question.acceptable ?? [])]) {
      if (!unitIds.has(label)) {
        throw new Error(
          `${file}: ${question.id} references unknown unit ${label}`,
        );
      }
    }
    if (question.gold.some((label) => question.acceptable?.includes(label))) {
      throw new Error(
        `${file}: ${question.id} lists a unit as gold and acceptable`,
      );
    }
  }
}

export async function loadEvidenceAdmissionPack(
  splits: readonly Split[] = ["development", "heldout"],
): Promise<{ manifest: Manifest; cases: EvidenceAdmissionCase[] }> {
  const manifest = JSON.parse(
    await readFile(path.join(packRoot, "manifest.json"), "utf8"),
  ) as Manifest;
  const cases: EvidenceAdmissionCase[] = [];
  for (const split of splits) {
    for (const file of manifest.splits[split]) {
      const domain = JSON.parse(
        await readFile(path.join(packRoot, file), "utf8"),
      ) as PackDomain;
      if (domain.split !== split) {
        throw new Error(
          `${file}: declared split ${domain.split}, manifest says ${split}`,
        );
      }
      validateDomain(domain, manifest, file);
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
  }
  return { manifest, cases };
}

export interface QuestionResult {
  id: string;
  domain: string;
  split: Split;
  intent: string;
  language: string;
  challenges: string[];
  query: string;
  gold: string[];
  acceptable: string[];
  admitted: string[];
  answerable: boolean;
  goldAdmitted: boolean;
  wrongAdmissions: string[];
  strictCorrect: boolean;
  latencyMs: number;
  stageDiagnostics: ReturnType<typeof diagnoseEvidencePipeline>;
}

export async function evaluateEvidenceAdmission(
  cases: readonly EvidenceAdmissionCase[],
  admit: EvidenceAdmitter,
  options: EvidenceAdmissionEvaluationOptions = {},
): Promise<QuestionResult[]> {
  const results: QuestionResult[] = [];
  for (const entry of cases) {
    const started = performance.now();
    const decision = await admit(entry.hits, entry.question.query);
    const latencyMs = performance.now() - started;
    const assessment =
      "supportedCandidateKeys" in decision
        ? decision
        : { supportedCandidateKeys: [...decision], candidateSignals: [] };
    const keys = assessment.supportedCandidateKeys;
    const admitted = [
      ...new Set(
        keys.map((key) => {
          const unit = entry.unitIdByCandidateKey.get(key);
          if (!unit) throw new Error(`Admitter returned unknown key ${key}`);
          return unit;
        }),
      ),
    ].sort();
    const gold = entry.question.gold;
    const acceptable = entry.question.acceptable ?? [];
    const answerable = gold.length > 0;
    const goldAdmitted = admitted.some((unit) => gold.includes(unit));
    const wrongAdmissions = admitted.filter(
      (unit) => !gold.includes(unit) && !acceptable.includes(unit),
    );
    const candidates = entry.hits.map((hit, index) =>
      evidenceCandidateDiagnostic(hit, index + 1, assessment),
    );
    const targetForUnit = (unit: string) => {
      const hit = entry.hits.find(
        (candidate) => candidate.document.externalId === unit,
      );
      if (!hit) throw new Error("ADMISSION_DIAGNOSTIC_LABEL_MISSING");
      return {
        documentId: hit.documentId,
        unitId: hit.unitId ?? null,
        evidenceSpan:
          options.goldSpans?.get(entry.question.id)?.get(unit) ?? null,
      };
    };
    const readerSelected = candidates.some(
      (candidate) => candidate.admission?.readerSelected !== null,
    );
    const stageDiagnostics = diagnoseEvidencePipeline({
      caseId: entry.question.id,
      measurement: "SUPPLIED_CANDIDATE_ADMISSION",
      expected: gold.map(targetForUnit),
      admissible: [...gold, ...acceptable].map(targetForUnit),
      labelsComplete: true,
      candidates,
      ...(readerSelected
        ? {
            shortlist: candidates.filter(
              (candidate) => candidate.admission?.readerSelected,
            ),
          }
        : {}),
      admitted: candidates.filter((candidate) => candidate.admission?.accepted),
    });
    results.push({
      id: entry.question.id,
      domain: entry.domain.id,
      split: entry.domain.split,
      intent: entry.question.intent,
      language: entry.question.language,
      challenges: entry.question.challenges,
      query: entry.question.query,
      gold,
      acceptable,
      admitted,
      answerable,
      goldAdmitted,
      wrongAdmissions,
      strictCorrect: answerable
        ? goldAdmitted && wrongAdmissions.length === 0
        : admitted.length === 0,
      latencyMs,
      stageDiagnostics,
    });
  }
  return results;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function summarizeEvidenceAdmission(results: readonly QuestionResult[]) {
  const answerable = results.filter((row) => row.answerable);
  const unanswerable = results.filter((row) => !row.answerable);
  const admittedUnits = results.reduce(
    (sum, row) => sum + row.admitted.length,
    0,
  );
  const correctlyAdmittedUnits = results.reduce(
    (sum, row) => sum + row.admitted.length - row.wrongAdmissions.length,
    0,
  );
  const latencies = results.map((row) => row.latencyMs).sort((a, b) => a - b);
  return {
    questions: results.length,
    answerable: answerable.length,
    unanswerable: unanswerable.length,
    answerableRecall: ratio(
      answerable.filter((row) => row.goldAdmitted).length,
      answerable.length,
    ),
    falseAcceptanceRate: ratio(
      unanswerable.filter((row) => row.admitted.length > 0).length,
      unanswerable.length,
    ),
    admittedUnits,
    admittedPrecision: ratio(correctlyAdmittedUnits, admittedUnits),
    questionsWithWrongAdmission: results.filter(
      (row) => row.wrongAdmissions.length > 0,
    ).length,
    strictAccuracy: ratio(
      results.filter((row) => row.strictCorrect).length,
      results.length,
    ),
    p50LatencyMs: latencies[Math.floor((latencies.length - 1) / 2)] ?? null,
    p95LatencyMs: latencies[Math.floor((latencies.length - 1) * 0.95)] ?? null,
  };
}

function breakdown(
  results: readonly QuestionResult[],
  keys: (row: QuestionResult) => readonly string[],
) {
  const groups = new Map<string, QuestionResult[]>();
  for (const row of results) {
    for (const key of keys(row)) {
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, rows]) => [key, summarizeEvidenceAdmission(rows)]),
  );
}

export function evidenceAdmissionReport(
  results: readonly QuestionResult[],
  verifier: string,
) {
  const bySplit = (split: Split) =>
    results.filter((row) => row.split === split);
  return {
    schemaVersion: 2,
    verifier,
    evidenceBoundary:
      "Synthetic, domain-disjoint admission pack. Held-out domains are reported, not tuned. A regression signal, not a product-wide precision claim.",
    development: summarizeEvidenceAdmission(bySplit("development")),
    heldout: summarizeEvidenceAdmission(bySplit("heldout")),
    byIntent: breakdown(results, (row) => [row.intent]),
    byLanguage: breakdown(results, (row) => [row.language]),
    byChallenge: breakdown(results, (row) =>
      row.challenges.length > 0 ? row.challenges : ["NONE"],
    ),
    byDomain: breakdown(results, (row) => [row.domain]),
    stageDiagnostics: {
      measurement: "SUPPLIED_CANDIDATE_ADMISSION",
      upstreamRetrievalMeasured: false,
      questions: results.length,
      unresolvedQuestions: results.filter(
        (row) => row.stageDiagnostics.unresolved.length > 0,
      ).length,
      goldSpanAnnotations: results.reduce(
        (sum, row) =>
          sum + row.stageDiagnostics.exactSpanEvaluation.annotatedGoldUnits,
        0,
      ),
      questionsByFailureStage: Object.fromEntries(
        [
          ...new Set(
            results.flatMap((row) =>
              row.stageDiagnostics.failures.map((failure) => failure.stage),
            ),
          ),
        ]
          .sort()
          .map((stage) => [
            stage,
            results.filter((row) =>
              row.stageDiagnostics.failures.some(
                (failure) => failure.stage === stage,
              ),
            ).length,
          ]),
      ),
    },
    rows: results,
  };
}
