import { createHash } from "node:crypto";
import type { GoldCase } from "./dataset.js";
import { REQUIRED_GENERIC_SLICES } from "./dataset.js";
import {
  aggregateBenchmarkRun,
  RETRIEVAL_BENCHMARK_MATRIX,
  selectBenchmarkDefault,
  type BenchmarkConfiguration,
  type BenchmarkObservation,
  type BenchmarkRunMetrics,
} from "./benchmark.js";

const OFFLINE_SCHEMA_VERSION = "akp.retrieval.offline-benchmark.v1";
const SYNTHETIC_PROVIDER = "synthetic-gold-projection-v1";

export interface OfflineBenchmarkInput {
  datasetRoot: string;
  datasetHash: string;
  datasetFiles: Readonly<Record<string, string>>;
  runnerHash?: string;
  generatedAt?: string;
}

export interface VectorDisabledProbe {
  status: "LOGIC_ONLY";
  requestedChannels: readonly ["exact", "lexical", "vector"];
  effectiveChannels: readonly ["exact", "lexical"];
  vectorInvoked: false;
  runtimeVerificationRequired: true;
}

export interface OfflineBenchmarkReport {
  schemaVersion: typeof OFFLINE_SCHEMA_VERSION;
  status: "IMPLEMENTED_AND_EXECUTED";
  evidenceLevel: "LOGIC_ONLY_SYNTHETIC";
  qualityClaim: "NONE";
  provider: {
    mode: "synthetic";
    name: typeof SYNTHETIC_PROVIDER;
    description: string;
    readsPrivateVault: false;
    readsDatabase: false;
  };
  generatedAt: string;
  input: {
    datasetRoot: string;
    files: Readonly<Record<string, string>>;
    datasetHash: string;
    caseCount: number;
    slices: string[];
  };
  matrix: {
    size: number;
    configurations: Array<{
      name: string;
      channels: readonly string[];
      vectorBenchmarkOnly: boolean;
      rerank: boolean;
    }>;
  };
  metricDefinitions: Record<string, string>;
  requiredSlices: readonly string[];
  sliceCoverage: Array<{ slice: string; cases: number }>;
  vectorDisabled: VectorDisabledProbe;
  runs: BenchmarkRunMetrics[];
  measuredSelection: ReturnType<typeof selectBenchmarkDefault>;
  productionDefault: {
    selected: null;
    reason: string;
  };
  limitations: string[];
  runnerHash?: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashNumber(seed: string): number {
  return Number.parseInt(digest(seed).slice(0, 8), 16) >>> 0;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Generate a deterministic ranking solely to exercise scorer and selection
 * logic.  It intentionally does not inspect document content or the private
 * vault.  Vector configurations receive a controlled synthetic penalty so
 * this harness cannot manufacture a vector lift and activate a default.
 */
export function synthesizeObservation(
  testCase: GoldCase,
  configuration: BenchmarkConfiguration,
  datasetHash: string,
): BenchmarkObservation {
  const seed = `${datasetHash}\u0000${configuration.name}\u0000${testCase.id}`;
  if (testCase.expect_no_answer) {
    return {
      configurationName: configuration.name,
      caseId: testCase.id,
      slice: testCase.slice ?? testCase.category,
      rankedDocumentIds: [],
      goldDocumentIds: [...testCase.gold_documents],
      ...(testCase.must_not_include
        ? { mustNotInclude: [...testCase.must_not_include] }
        : {}),
      expectNoAnswer: true,
      returnedAnswer: false,
      latencyMs: 1 + (hashNumber(`${seed}:latency`) % 3),
      estimatedTokens: 0,
      ...(testCase.critical === undefined
        ? {}
        : { critical: testCase.critical }),
    };
  }

  const noise = `synthetic-noise-${digest(seed).slice(0, 10)}`;
  // Negative labels are exercised only by graph-only, where a graph neighbor
  // is deliberately surfaced as a false positive.  Other configurations keep
  // the negative candidate out of the synthetic top-k set.
  const negative =
    configuration.name === "graph-only"
      ? (testCase.must_not_include ?? [])
      : [];
  const candidates = unique([...testCase.gold_documents, ...negative, noise]);
  const vector = configuration.channels.includes("vector");
  const exactOrPack =
    configuration.channels.includes("exact") ||
    configuration.channels.includes("context-pack");
  const ordered = [...candidates].sort((left, right) => {
    const leftGold = testCase.gold_documents.includes(left);
    const rightGold = testCase.gold_documents.includes(right);
    if (leftGold !== rightGold) {
      // Vector is intentionally not allowed to look better than a lexical
      // baseline in a logic-only fixture.  This is not a corpus claim.
      if (vector) return leftGold ? 1 : -1;
      if (exactOrPack) return leftGold ? -1 : 1;
    }
    return (
      hashNumber(`${seed}\u0000${left}`) - hashNumber(`${seed}\u0000${right}`)
    );
  });
  const ranked = ordered.slice(0, 10);
  return {
    configurationName: configuration.name,
    caseId: testCase.id,
    slice: testCase.slice ?? testCase.category,
    rankedDocumentIds: ranked,
    goldDocumentIds: [...testCase.gold_documents],
    ...(testCase.must_not_include
      ? { mustNotInclude: [...testCase.must_not_include] }
      : {}),
    returnedAnswer: true,
    latencyMs:
      1 + configuration.channels.length + (hashNumber(`${seed}:latency`) % 5),
    estimatedTokens: 24 + (hashNumber(`${seed}:tokens`) % 64),
    ...(testCase.critical === undefined ? {} : { critical: testCase.critical }),
  };
}

function slicesOf(cases: readonly GoldCase[]): string[] {
  return [
    ...new Set(cases.map((testCase) => testCase.slice ?? testCase.category)),
  ].sort();
}

function coverageOf(
  cases: readonly GoldCase[],
): Array<{ slice: string; cases: number }> {
  const counts = new Map<string, number>();
  for (const testCase of cases) {
    const slice = testCase.slice ?? testCase.category;
    counts.set(slice, (counts.get(slice) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([slice, count]) => ({ slice, cases: count }));
}

export function buildOfflineBenchmarkReport(
  cases: readonly GoldCase[],
  input: OfflineBenchmarkInput,
): OfflineBenchmarkReport {
  const runs = RETRIEVAL_BENCHMARK_MATRIX.map((configuration) =>
    aggregateBenchmarkRun(
      configuration,
      cases.map((testCase) =>
        synthesizeObservation(testCase, configuration, input.datasetHash),
      ),
    ),
  );
  const slices = slicesOf(cases);
  const report: OfflineBenchmarkReport = {
    schemaVersion: OFFLINE_SCHEMA_VERSION,
    status: "IMPLEMENTED_AND_EXECUTED",
    evidenceLevel: "LOGIC_ONLY_SYNTHETIC",
    qualityClaim: "NONE",
    provider: {
      mode: "synthetic",
      name: SYNTHETIC_PROVIDER,
      description:
        "Ranks gold identifiers and deterministic noise without reading document content; used only to validate scoring, matrix coverage and default guardrails.",
      readsPrivateVault: false,
      readsDatabase: false,
    },
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    input: {
      datasetRoot: input.datasetRoot,
      files: input.datasetFiles,
      datasetHash: input.datasetHash,
      caseCount: cases.length,
      slices,
    },
    matrix: {
      size: RETRIEVAL_BENCHMARK_MATRIX.length,
      configurations: RETRIEVAL_BENCHMARK_MATRIX.map((configuration) => ({
        name: configuration.name,
        channels: [...configuration.channels],
        vectorBenchmarkOnly: Boolean(configuration.allowVectorForBenchmark),
        rerank: Boolean(configuration.deterministicRerank),
      })),
    },
    metricDefinitions: {
      recallAt5: "Relevant gold document fraction in the first five ranks.",
      recallAt10: "Relevant gold document fraction in the first ten ranks.",
      mrr: "Reciprocal rank of the first relevant gold document.",
      ndcgAt10: "Binary relevance nDCG at ten.",
      evidenceRecall:
        "Only measured when gold_evidence labels are present; otherwise coverage is zero.",
      citationPrecision:
        "Only measured when gold_citations labels are present; otherwise coverage is zero.",
      unsupportedClaimRate:
        "Returned answer with explicitly supplied evidence IDs empty; coverage is zero when no evidence labels are supplied.",
      noAnswerAccuracy:
        "Accuracy over cases explicitly marked expect_no_answer.",
      exactIdentifierRecall: "Recall@10 over the exact-identifiers slice.",
      crossLanguageRecall: "Recall@10 over the cross-language slice.",
      tokenCost:
        "Deterministic synthetic estimate; not an LLM billing measurement.",
      latency:
        "Deterministic synthetic estimate; not a service latency measurement.",
    },
    requiredSlices: [...REQUIRED_GENERIC_SLICES],
    sliceCoverage: coverageOf(cases),
    vectorDisabled: {
      status: "LOGIC_ONLY",
      requestedChannels: ["exact", "lexical", "vector"],
      effectiveChannels: ["exact", "lexical"],
      vectorInvoked: false,
      runtimeVerificationRequired: true,
    },
    runs,
    measuredSelection: selectBenchmarkDefault(runs),
    productionDefault: {
      selected: null,
      reason:
        "Synthetic rankings are not evidence for a production retrieval default; run the API benchmark against captured or real indexed data first.",
    },
    limitations: [
      "This report is a logic-only synthetic execution and makes no retrieval-quality claim.",
      "No private vault, PostgreSQL index, embeddings, graph edges or document content were read.",
      "Evidence recall and citation precision have zero labelled coverage in the current generic fixtures.",
      "Token and latency values are deterministic estimates, not runtime measurements.",
      "Vector-disabled behavior is a pure harness probe; API/index revision integration still requires runtime verification.",
      "The measuredSelection is diagnostic only and must not change the runtime planner or production default.",
    ],
    ...(input.runnerHash ? { runnerHash: input.runnerHash } : {}),
  };
  return report;
}

export { OFFLINE_SCHEMA_VERSION, SYNTHETIC_PROVIDER };
