import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  runRequestedAnswerFollowUp,
  type RequestedAnswerSupportAssessment,
} from "../packages/retrieval/src/index.js";

type ExpectedOutcome =
  "SUPPORTED_INITIAL" | "SUPPORTED_FOLLOW_UP" | "INSUFFICIENT_KNOWLEDGE";

type Case = {
  id: string;
  family: string;
  query: string;
  initialSupported: boolean;
  followUpSupported: boolean;
  expected: {
    outcome: ExpectedOutcome;
    followUpAttemptCount: 0 | 1;
    followUpQuery: string | null;
    assessCallCount: 0 | 1;
  };
};

type Manifest = {
  schemaVersion: string;
  frozen: boolean;
  frozenAt: string;
  baselineSha: string;
  protocol: {
    singleIndependentVariable: string;
    developmentFamilies: string[];
    heldoutFamilies: string[];
    familyDisjoint: boolean;
    noTuningAfterHeldout: boolean;
    productionBehaviorChanged: boolean;
    productionAdmissionChanged: boolean;
    retrievalQualityMeasured: boolean;
  };
  promotionRule: {
    developmentStrictContractAccuracy: number;
    heldoutStrictContractAccuracy: number;
    maxFollowUpAttempts: number;
    unsupportedQueryFollowUpRate: number;
    originalQueryReassessmentRate: number;
    relevanceCanGrantSupport: boolean;
    promotionScope: string;
  };
  splits: {
    development: Case[];
    heldout: Case[];
  };
};

type Observation = {
  id: string;
  family: string;
  query: string;
  expected: Case["expected"];
  actual: {
    outcome: ExpectedOutcome;
    followUpAttemptCount: 0 | 1;
    followUpQuery: string | null;
    retrieveCallCount: number;
    assessCallCount: number;
    assessmentQueries: string[];
  };
  exact: boolean;
};

const root = path.resolve(".");
const manifestPath = path.resolve(
  "evals/generic/requested-answer-followup/manifest.json",
);
const outputPath = path.resolve(
  process.env.AKP_REQUESTED_ANSWER_FOLLOWUP_REPORT ??
    "reports/ci/requested-answer-followup-shadow.json",
);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function support(supported: boolean): RequestedAnswerSupportAssessment {
  return {
    supported,
    reason: supported ? "PASSAGE_TEXT_SUPPORT" : "SUPPORT_NOT_DEMONSTRATED",
    supportedCandidateKeys: supported ? ["fixture:source-bound"] : [],
  };
}

async function observe(testCase: Case): Promise<Observation> {
  let retrieveCallCount = 0;
  let assessCallCount = 0;
  const assessmentQueries: string[] = [];

  const result = await runRequestedAnswerFollowUp({
    query: testCase.query,
    initialCandidates: ["initial"],
    initialAssessment: support(testCase.initialSupported),
    retrieve: async () => {
      retrieveCallCount += 1;
      return ["follow-up"];
    },
    assess: async (_candidates, originalQuery) => {
      assessCallCount += 1;
      assessmentQueries.push(originalQuery);
      return support(testCase.followUpSupported);
    },
  });

  const actual = {
    outcome: result.outcome,
    followUpAttemptCount: result.followUpAttemptCount,
    followUpQuery: result.followUpQuery,
    retrieveCallCount,
    assessCallCount,
    assessmentQueries,
  };
  const expected = testCase.expected;
  const exact =
    actual.outcome === expected.outcome &&
    actual.followUpAttemptCount === expected.followUpAttemptCount &&
    actual.followUpQuery === expected.followUpQuery &&
    actual.retrieveCallCount === expected.followUpAttemptCount &&
    actual.assessCallCount === expected.assessCallCount &&
    actual.assessmentQueries.every((query) => query === testCase.query);

  return {
    id: testCase.id,
    family: testCase.family,
    query: testCase.query,
    expected,
    actual,
    exact,
  };
}

function strictAccuracy(rows: readonly Observation[]): number {
  return rows.length === 0
    ? 1
    : rows.filter((row) => row.exact).length / rows.length;
}

const manifestRaw = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(manifestRaw) as Manifest;

if (
  manifest.schemaVersion !== "akp.requested-answer-followup-shadow.v1" ||
  manifest.frozen !== true ||
  manifest.baselineSha !== "d36231af1c69705d92f21e2bc95bf5c8c93b71cf" ||
  manifest.protocol.familyDisjoint !== true ||
  manifest.protocol.noTuningAfterHeldout !== true ||
  manifest.protocol.productionBehaviorChanged !== false ||
  manifest.protocol.productionAdmissionChanged !== false ||
  manifest.protocol.retrievalQualityMeasured !== false
) {
  throw new Error("Requested-answer follow-up manifest contract drifted.");
}

const development = await Promise.all(manifest.splits.development.map(observe));
const heldout = await Promise.all(manifest.splits.heldout.map(observe));
const all = [...development, ...heldout];

const developmentStrictContractAccuracy = strictAccuracy(development);
const heldoutStrictContractAccuracy = strictAccuracy(heldout);
const maxFollowUpAttempts = Math.max(
  0,
  ...all.map((row) => row.actual.followUpAttemptCount),
);
const unsupported = heldout.filter((row) => row.family === "UNSUPPORTED");
const unsupportedQueryFollowUpRate =
  unsupported.length === 0
    ? 0
    : unsupported.filter((row) => row.actual.followUpAttemptCount > 0).length /
      unsupported.length;
const reassessments = all.flatMap((row) => row.actual.assessmentQueries);
const originalQueryReassessmentRate =
  reassessments.length === 0
    ? 1
    : all.reduce(
        (count, row) =>
          count +
          row.actual.assessmentQueries.filter((query) => query === row.query)
            .length,
        0,
      ) / reassessments.length;

const gates = {
  developmentStrictContractAccuracy:
    developmentStrictContractAccuracy ===
    manifest.promotionRule.developmentStrictContractAccuracy,
  heldoutStrictContractAccuracy:
    heldoutStrictContractAccuracy ===
    manifest.promotionRule.heldoutStrictContractAccuracy,
  maxFollowUpAttempts:
    maxFollowUpAttempts <= manifest.promotionRule.maxFollowUpAttempts,
  unsupportedQueryFollowUpRate:
    unsupportedQueryFollowUpRate ===
    manifest.promotionRule.unsupportedQueryFollowUpRate,
  originalQueryReassessmentRate:
    originalQueryReassessmentRate ===
    manifest.promotionRule.originalQueryReassessmentRate,
  relevanceCanGrantSupport:
    manifest.promotionRule.relevanceCanGrantSupport === false,
  productionBehaviorChanged:
    manifest.protocol.productionBehaviorChanged === false,
  productionAdmissionChanged:
    manifest.protocol.productionAdmissionChanged === false,
  retrievalQualityMeasured:
    manifest.protocol.retrievalQualityMeasured === false,
};

const outcome = Object.values(gates).every(Boolean)
  ? "PROMOTE_TO_SHADOW_ORCHESTRATOR"
  : "REJECT";

const report = {
  schemaVersion: manifest.schemaVersion,
  generatedAt: new Date().toISOString(),
  baselineSha: manifest.baselineSha,
  manifestHash: hash(manifestRaw),
  outcome,
  promotionScope: manifest.promotionRule.promotionScope,
  productionBehaviorChanged: false,
  productionAdmissionChanged: false,
  retrievalQualityMeasured: false,
  singleIndependentVariable: manifest.protocol.singleIndependentVariable,
  metrics: {
    developmentStrictContractAccuracy,
    heldoutStrictContractAccuracy,
    maxFollowUpAttempts,
    unsupportedQueryFollowUpRate,
    originalQueryReassessmentRate,
  },
  gates,
  observations: { development, heldout },
  claimBoundary: [
    "This experiment validates shadow orchestration semantics only; it does not measure retrieval quality.",
    "RequestedAnswerSlot may trigger retrieval assistance but never grants evidence support.",
    "The follow-up assessment always receives the original user query.",
    "Unsupported query forms do not trigger follow-up retrieval.",
    "At most one follow-up retrieval is permitted; unsupported second-pass evidence returns INSUFFICIENT_KNOWLEDGE.",
    "No production route or admission default is changed by this experiment.",
  ],
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
