import "dotenv/config";

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  EVIDENCE_READER_PROMPT_VERSION,
  OpenAICompatibleEvidenceReader,
  ReaderEvidenceVerifier,
  projectRequestedAnswerSlot,
} from "../packages/retrieval/src/index.js";

type Split = "development" | "heldout";

interface CandidateFixture {
  readonly label: string;
  readonly title: string;
  readonly passage: string;
  readonly unitType?: "PARAGRAPH" | "TABLE";
  readonly gold: boolean;
  readonly expectedAnswerIncludes?: readonly string[];
  readonly expectedAnswerExcludes?: readonly string[];
}

interface CaseFixture {
  readonly id: string;
  readonly family: string;
  readonly language: "EN" | "ES";
  readonly query: string;
  readonly candidates: readonly CandidateFixture[];
}

interface PromotionRule {
  readonly exactSpanPrecision: number;
  readonly unsupportedFalseAcceptanceRate: number;
  readonly answerableRecallNonRegression: boolean;
  readonly falseAcceptanceNonRegression: boolean;
  readonly strictAccuracyNonRegression: boolean;
  readonly requireHeldoutPrecisionCoverageFrontierImprovement: boolean;
  readonly candidateAnswerableRecallAtLeast: number;
  readonly candidateStrictAccuracyAtLeast: number;
}

interface Manifest {
  readonly schemaVersion: string;
  readonly frozen: boolean;
  readonly frozenAt: string;
  readonly baselineSha: string;
  readonly model: {
    readonly id: string;
    readonly revision: string;
    readonly dtype: string;
    readonly temperature: number;
    readonly maxOutputTokens: number;
  };
  readonly protocol: {
    readonly developmentFamilies: readonly string[];
    readonly heldoutFamilies: readonly string[];
    readonly familyDisjoint: boolean;
    readonly noTuningAfterHeldout: boolean;
    readonly singleIndependentVariable: string;
  };
  readonly promotionRule: PromotionRule;
  readonly splits: Record<Split, readonly CaseFixture[]>;
}

interface CandidateObservation {
  readonly label: string;
  readonly gold: boolean;
  readonly decision: string;
  readonly reason: string;
  readonly evidenceSpan: { startOffset: number; endOffset: number } | null;
  readonly quotedText: string | null;
  readonly sourceBound: boolean;
  readonly expectedAnswerMatched: boolean;
  readonly correctSupport: boolean;
  readonly wrongSupport: boolean;
  readonly latencyMs: number;
}

interface CaseObservation {
  readonly id: string;
  readonly family: string;
  readonly language: "EN" | "ES";
  readonly query: string;
  readonly requestedAnswerSlot: ReturnType<typeof projectRequestedAnswerSlot>;
  readonly answerable: boolean;
  readonly candidates: readonly CandidateObservation[];
  readonly goldAdmitted: boolean;
  readonly falseAcceptance: boolean;
  readonly strictCorrect: boolean;
}

interface ArmSummary {
  readonly cases: number;
  readonly answerableCases: number;
  readonly unanswerableCases: number;
  readonly answerableRecall: number;
  readonly falseAcceptanceRate: number;
  readonly admittedPrecision: number;
  readonly exactSpanPrecision: number;
  readonly strictAccuracy: number;
  readonly unsupportedFalseAcceptanceRate: number;
  readonly supports: number;
  readonly correctSupports: number;
  readonly p50LatencyMs: number | null;
  readonly p95LatencyMs: number | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function percentile(values: readonly number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor((ordered.length - 1) * quantile)] ?? null;
}

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("und");
}

function expectedAnswerMatched(
  candidate: CandidateFixture,
  quotedText: string | null,
): boolean {
  if (!quotedText) return false;
  const quote = normalized(quotedText);
  return (
    (candidate.expectedAnswerIncludes ?? []).every((value) =>
      quote.includes(normalized(value)),
    ) &&
    (candidate.expectedAnswerExcludes ?? []).every(
      (value) => !quote.includes(normalized(value)),
    )
  );
}

function validateManifest(manifest: Manifest): void {
  if (
    !manifest.frozen ||
    !manifest.protocol.familyDisjoint ||
    !manifest.protocol.noTuningAfterHeldout ||
    !manifest.protocol.singleIndependentVariable.trim()
  ) {
    throw new Error("REQUESTED_SLOT_READER_MANIFEST_NOT_FROZEN");
  }

  const developmentFamilies = new Set(manifest.protocol.developmentFamilies);
  const heldoutFamilies = new Set(manifest.protocol.heldoutFamilies);
  if (
    [...developmentFamilies].some((family) => heldoutFamilies.has(family))
  ) {
    throw new Error("REQUESTED_SLOT_READER_FAMILY_OVERLAP");
  }

  for (const split of ["development", "heldout"] as const) {
    const declared =
      split === "development" ? developmentFamilies : heldoutFamilies;
    for (const testCase of manifest.splits[split]) {
      if (!declared.has(testCase.family)) {
        throw new Error(
          `REQUESTED_SLOT_READER_UNDECLARED_FAMILY:${split}:${testCase.family}`,
        );
      }
      if (
        !testCase.id.trim() ||
        !testCase.query.trim() ||
        testCase.candidates.length === 0
      ) {
        throw new Error(
          `REQUESTED_SLOT_READER_INVALID_CASE:${split}:${testCase.id}`,
        );
      }
      const labels = testCase.candidates.map((candidate) => candidate.label);
      if (new Set(labels).size !== labels.length) {
        throw new Error(
          `REQUESTED_SLOT_READER_DUPLICATE_LABEL:${testCase.id}`,
        );
      }
    }
  }
}

async function candidateHeadSha(): Promise<string> {
  const explicit = process.env.AKP_REQUESTED_SLOT_READER_CANDIDATE_SHA?.trim();
  if (explicit && /^[0-9a-f]{40}$/u.test(explicit)) return explicit;

  const eventPath = process.env.GITHUB_EVENT_PATH?.trim();
  if (eventPath) {
    const event = JSON.parse(await readFile(eventPath, "utf8")) as {
      pull_request?: { head?: { sha?: unknown } };
    };
    const value = event.pull_request?.head?.sha;
    if (typeof value === "string" && /^[0-9a-f]{40}$/u.test(value)) {
      return value;
    }
  }

  const fallback = process.env.GITHUB_SHA?.trim();
  if (fallback && /^[0-9a-f]{40}$/u.test(fallback)) return fallback;
  throw new Error("REQUESTED_SLOT_READER_CANDIDATE_SHA_UNAVAILABLE");
}

function summary(rows: readonly CaseObservation[]): ArmSummary {
  const answerable = rows.filter((row) => row.answerable);
  const unanswerable = rows.filter((row) => !row.answerable);
  const supports = rows.flatMap((row) => row.candidates).filter(
    (candidate) => candidate.decision === "SUPPORTS",
  );
  const correctSupports = supports.filter((candidate) => candidate.correctSupport);
  const unsupported = rows.filter((row) =>
    row.family.startsWith("UNSUPPORTED_"),
  );
  const latencies = rows.flatMap((row) =>
    row.candidates.map((candidate) => candidate.latencyMs),
  );

  return {
    cases: rows.length,
    answerableCases: answerable.length,
    unanswerableCases: unanswerable.length,
    answerableRecall: rate(
      answerable.filter((row) => row.goldAdmitted).length,
      answerable.length,
    ),
    falseAcceptanceRate: rate(
      unanswerable.filter((row) => row.falseAcceptance).length,
      unanswerable.length,
    ),
    admittedPrecision: rate(correctSupports.length, supports.length),
    exactSpanPrecision: rate(
      supports.filter(
        (candidate) => candidate.sourceBound && candidate.correctSupport,
      ).length,
      supports.length,
    ),
    strictAccuracy: rate(
      rows.filter((row) => row.strictCorrect).length,
      rows.length,
    ),
    unsupportedFalseAcceptanceRate: rate(
      unsupported.filter((row) => row.falseAcceptance).length,
      unsupported.length,
    ),
    supports: supports.length,
    correctSupports: correctSupports.length,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
  };
}

async function evaluateArm(
  cases: readonly CaseFixture[],
  verifier: ReaderEvidenceVerifier,
): Promise<CaseObservation[]> {
  const rows: CaseObservation[] = [];
  for (const testCase of cases) {
    const requestedAnswerSlot = projectRequestedAnswerSlot(testCase.query);
    const candidates: CandidateObservation[] = [];

    for (const candidate of testCase.candidates) {
      const started = performance.now();
      const verification = await verifier.verify({
        query: testCase.query,
        candidateKey: candidate.label,
        title: candidate.title,
        headingPath: [],
        passage: candidate.passage,
        unitType: candidate.unitType ?? "PARAGRAPH",
        parentUnitType: null,
        documentType: "concept",
      });
      const latencyMs = performance.now() - started;
      const span = verification.evidenceSpan ?? null;
      const sourceBound =
        span !== null &&
        Number.isSafeInteger(span.startOffset) &&
        Number.isSafeInteger(span.endOffset) &&
        span.startOffset >= 0 &&
        span.endOffset > span.startOffset &&
        span.endOffset <= candidate.passage.length;
      if (verification.decision === "SUPPORTS" && !sourceBound) {
        throw new Error(
          `REQUESTED_SLOT_READER_SUPPORT_WITHOUT_SOURCE_SPAN:${testCase.id}:${candidate.label}`,
        );
      }
      const quotedText =
        sourceBound && span
          ? candidate.passage.slice(span.startOffset, span.endOffset)
          : null;
      const matchesExpected =
        candidate.gold && expectedAnswerMatched(candidate, quotedText);
      const correctSupport =
        verification.decision === "SUPPORTS" &&
        candidate.gold &&
        matchesExpected &&
        sourceBound;
      const wrongSupport =
        verification.decision === "SUPPORTS" && !correctSupport;

      candidates.push({
        label: candidate.label,
        gold: candidate.gold,
        decision: verification.decision,
        reason: verification.reason,
        evidenceSpan: span,
        quotedText,
        sourceBound,
        expectedAnswerMatched: matchesExpected,
        correctSupport,
        wrongSupport,
        latencyMs,
      });
    }

    const answerable = testCase.candidates.some((candidate) => candidate.gold);
    const goldAdmitted = candidates.some((candidate) => candidate.correctSupport);
    const falseAcceptance =
      !answerable &&
      candidates.some((candidate) => candidate.decision === "SUPPORTS");
    const wrongAdmissions = candidates.filter(
      (candidate) => candidate.wrongSupport,
    );

    rows.push({
      id: testCase.id,
      family: testCase.family,
      language: testCase.language,
      query: testCase.query,
      requestedAnswerSlot,
      answerable,
      candidates,
      goldAdmitted,
      falseAcceptance,
      strictCorrect: answerable
        ? goldAdmitted && wrongAdmissions.length === 0
        : candidates.every((candidate) => candidate.decision !== "SUPPORTS"),
    });
  }
  return rows;
}

function frontierImproved(
  baseline: ArmSummary,
  candidate: ArmSummary,
): boolean {
  const epsilon = 1e-12;
  const recallNoWorse =
    candidate.answerableRecall + epsilon >= baseline.answerableRecall;
  const falseAcceptanceNoWorse =
    candidate.falseAcceptanceRate <= baseline.falseAcceptanceRate + epsilon;
  const precisionNoWorse =
    candidate.admittedPrecision + epsilon >= baseline.admittedPrecision;

  return (
    recallNoWorse &&
    falseAcceptanceNoWorse &&
    precisionNoWorse &&
    (candidate.answerableRecall > baseline.answerableRecall + epsilon ||
      candidate.falseAcceptanceRate + epsilon <
        baseline.falseAcceptanceRate ||
      candidate.admittedPrecision > baseline.admittedPrecision + epsilon ||
      candidate.strictAccuracy > baseline.strictAccuracy + epsilon)
  );
}

async function main(): Promise<void> {
  const manifestPath = path.resolve(
    process.env.AKP_REQUESTED_SLOT_READER_MANIFEST ??
      "evals/generic/requested-slot-source-bound-reader/manifest.json",
  );
  const manifestRaw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw) as Manifest;
  validateManifest(manifest);

  const baseUrl = process.env.AKP_REQUESTED_SLOT_READER_BASE_URL?.trim();
  const model = process.env.AKP_REQUESTED_SLOT_READER_MODEL?.trim();
  const modelRevision =
    process.env.AKP_REQUESTED_SLOT_READER_MODEL_REVISION?.trim();
  const dtype = process.env.AKP_REQUESTED_SLOT_READER_DTYPE?.trim();
  if (!baseUrl || !model || !modelRevision || !dtype) {
    throw new Error("REQUESTED_SLOT_READER_PROVIDER_CONFIGURATION_REQUIRED");
  }
  if (
    model !== manifest.model.id ||
    modelRevision !== manifest.model.revision ||
    dtype !== manifest.model.dtype
  ) {
    throw new Error("REQUESTED_SLOT_READER_MODEL_IDENTITY_MISMATCH");
  }

  const reader = new OpenAICompatibleEvidenceReader({
    baseUrl,
    model,
    timeoutMs: 120_000,
    maxOutputTokens: manifest.model.maxOutputTokens,
    jsonResponseFormat: false,
  });
  const baselineVerifier = new ReaderEvidenceVerifier({ reader });
  const candidateVerifier = new ReaderEvidenceVerifier({
    reader,
    requestedAnswerSlotProjector: {
      id: "requested-answer-slot-v1",
      project: projectRequestedAnswerSlot,
    },
  });

  const observations: Record<
    Split,
    {
      baseline: CaseObservation[];
      candidate: CaseObservation[];
    }
  > = {
    development: { baseline: [], candidate: [] },
    heldout: { baseline: [], candidate: [] },
  };

  for (const split of ["development", "heldout"] as const) {
    const splitCases = manifest.splits[split];
    for (let index = 0; index < splitCases.length; index += 1) {
      const testCase = splitCases[index]!;
      const unsupported = testCase.family.startsWith("UNSUPPORTED_");
      const slot = projectRequestedAnswerSlot(testCase.query);
      if (unsupported ? slot !== null : slot === null) {
        throw new Error(
          `REQUESTED_SLOT_READER_PROJECTION_INTEGRITY:${testCase.id}`,
        );
      }

      if (index % 2 === 0) {
        observations[split].baseline.push(
          ...(await evaluateArm([testCase], baselineVerifier)),
        );
        observations[split].candidate.push(
          ...(await evaluateArm([testCase], candidateVerifier)),
        );
      } else {
        observations[split].candidate.push(
          ...(await evaluateArm([testCase], candidateVerifier)),
        );
        observations[split].baseline.push(
          ...(await evaluateArm([testCase], baselineVerifier)),
        );
      }
    }
  }

  const metrics = {
    development: {
      baseline: summary(observations.development.baseline),
      candidate: summary(observations.development.candidate),
    },
    heldout: {
      baseline: summary(observations.heldout.baseline),
      candidate: summary(observations.heldout.candidate),
    },
  };

  const baseline = metrics.heldout.baseline;
  const candidate = metrics.heldout.candidate;
  const rules = manifest.promotionRule;
  const gates = {
    exactSpanPrecision:
      candidate.exactSpanPrecision >= rules.exactSpanPrecision,
    unsupportedFalseAcceptanceRate:
      candidate.unsupportedFalseAcceptanceRate <=
      rules.unsupportedFalseAcceptanceRate,
    answerableRecallNonRegression:
      !rules.answerableRecallNonRegression ||
      candidate.answerableRecall >= baseline.answerableRecall,
    falseAcceptanceNonRegression:
      !rules.falseAcceptanceNonRegression ||
      candidate.falseAcceptanceRate <= baseline.falseAcceptanceRate,
    strictAccuracyNonRegression:
      !rules.strictAccuracyNonRegression ||
      candidate.strictAccuracy >= baseline.strictAccuracy,
    candidateAnswerableRecall:
      candidate.answerableRecall >= rules.candidateAnswerableRecallAtLeast,
    candidateStrictAccuracy:
      candidate.strictAccuracy >= rules.candidateStrictAccuracyAtLeast,
    precisionCoverageFrontierImprovement:
      !rules.requireHeldoutPrecisionCoverageFrontierImprovement ||
      frontierImproved(baseline, candidate),
  };
  const outcome = Object.values(gates).every(Boolean)
    ? "PROMOTE_TO_SHADOW_READER"
    : "REJECT";

  const configuration = {
    model,
    modelRevision,
    dtype,
    temperature: manifest.model.temperature,
    maxOutputTokens: manifest.model.maxOutputTokens,
    promptVersion: EVIDENCE_READER_PROMPT_VERSION,
    baselineVerifier: baselineVerifier.id,
    candidateVerifier: candidateVerifier.id,
  };
  const report = {
    schemaVersion: "akp.requested-slot-source-bound-reader-report.v1",
    generatedAt: new Date().toISOString(),
    outcome,
    promotionScope: "shadow-source-bound-reader-only",
    productionBehaviorChanged: false,
    productionAdmissionChanged: false,
    providerDefaultsChanged: false,
    baselineSha: manifest.baselineSha,
    candidateSha: await candidateHeadSha(),
    datasetHash: sha256(manifestRaw),
    configurationHash: sha256(JSON.stringify(configuration)),
    indexGeneration: "SUPPLIED_CANDIDATE_NO_INDEX",
    embeddingModelRevision: "NOT_APPLICABLE",
    rerankerRevision: "NOT_APPLICABLE",
    readerRevision: `${modelRevision}:${EVIDENCE_READER_PROMPT_VERSION}`,
    singleIndependentVariable: manifest.protocol.singleIndependentVariable,
    protocol: manifest.protocol,
    configuration,
    gates,
    metrics,
    observations,
    claimBoundary: [
      "Supplied-candidate shadow admission only; this report does not measure upstream retrieval.",
      "RequestedAnswerSlot is query representation and never evidence authority.",
      "SUPPORTS requires an exact visible source span mapped by the existing source-bound reader.",
      "A PROMOTE result permits only later shadow consumption; it does not change production admission or defaults.",
      "Heldout families are frozen and disjoint from development families; do not tune this heldout after observing the report.",
    ],
  };

  const outputPath = path.resolve(
    process.env.AKP_REQUESTED_SLOT_READER_REPORT ??
      "reports/ci/requested-slot-source-bound-reader.json",
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((error: unknown) => {
  process.stderr.write(
    (error instanceof Error ? (error.stack ?? error.message) : String(error)) +
      "\n",
  );
  process.exitCode = 1;
});
