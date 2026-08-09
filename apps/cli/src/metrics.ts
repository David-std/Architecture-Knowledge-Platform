export type JsonRecord = Record<string, unknown>;

const COMPARABLE_METRICS = [
  { name: "cases", preferredDirection: "neutral" },
  { name: "passed", preferredDirection: "higher" },
  { name: "criticalFailures", preferredDirection: "lower" },
  { name: "meanRecallAt10", preferredDirection: "higher" },
  { name: "meanReciprocalRank", preferredDirection: "higher" },
  { name: "meanNdcgAt10", preferredDirection: "higher" },
  { name: "meanCitationPrecision", preferredDirection: "higher" },
  { name: "unsupportedAnswerRate", preferredDirection: "lower" },
  { name: "meanLatencyMs", preferredDirection: "lower" },
] as const;

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function finiteNumber(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export interface EvaluationComparison {
  baseline: {
    runId: string;
    status: string;
    corpusRevision: string;
    createdAt: string;
  };
  candidate: {
    runId: string;
    status: string;
    corpusRevision: string;
    createdAt: string;
  };
  sameCorpusRevision: boolean;
  metrics: Array<{
    name: string;
    baseline: number | null;
    candidate: number | null;
    delta: number | null;
    preferredDirection: "higher" | "lower" | "neutral";
  }>;
}

export function compareEvaluationRuns(
  baselineRun: JsonRecord,
  candidateRun: JsonRecord,
): EvaluationComparison {
  const baselineMetrics = record(baselineRun.metrics);
  const candidateMetrics = record(candidateRun.metrics);
  const baselineRevision = String(
    baselineRun.corpus_revision ?? baselineRun.corpusRevision ?? "",
  );
  const candidateRevision = String(
    candidateRun.corpus_revision ?? candidateRun.corpusRevision ?? "",
  );

  return {
    baseline: {
      runId: String(baselineRun.id ?? baselineRun.runId ?? ""),
      status: String(baselineRun.status ?? "UNKNOWN"),
      corpusRevision: baselineRevision,
      createdAt: String(baselineRun.created_at ?? baselineRun.createdAt ?? ""),
    },
    candidate: {
      runId: String(candidateRun.id ?? candidateRun.runId ?? ""),
      status: String(candidateRun.status ?? "UNKNOWN"),
      corpusRevision: candidateRevision,
      createdAt: String(
        candidateRun.created_at ?? candidateRun.createdAt ?? "",
      ),
    },
    sameCorpusRevision: baselineRevision === candidateRevision,
    metrics: COMPARABLE_METRICS.map(({ name, preferredDirection }) => {
      const baseline = finiteNumber(baselineMetrics[name]);
      const candidate = finiteNumber(candidateMetrics[name]);
      return {
        name,
        baseline,
        candidate,
        delta:
          baseline === null || candidate === null ? null : candidate - baseline,
        preferredDirection,
      };
    }),
  };
}

export interface PacketObservation {
  latencyMs: number;
  packet: JsonRecord;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * fraction) - 1,
  );
  return sorted[Math.max(0, index)] ?? 0;
}

export function summarizePacketBenchmark(
  query: string,
  observations: PacketObservation[],
): JsonRecord {
  if (observations.length === 0) {
    throw new Error("At least one packet observation is required.");
  }

  const latencies = observations
    .map(({ latencyMs }) => latencyMs)
    .sort((a, b) => a - b);
  const packetHashes = observations.map(({ packet }) =>
    String(packet.packetHash ?? ""),
  );
  const statuses = observations.map(({ packet }) =>
    String(packet.status ?? "UNKNOWN"),
  );
  const usedTokens = observations.map(({ packet }) =>
    finiteNumber(record(packet.budget).usedTokens),
  );
  const maxTokens = observations.map(({ packet }) =>
    finiteNumber(record(packet.budget).maxTokens),
  );

  return {
    benchmark: "context-packet",
    query,
    runs: observations.length,
    latencyMs: {
      minimum: latencies[0] ?? 0,
      mean: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      maximum: latencies.at(-1) ?? 0,
    },
    stablePacketHash: new Set(packetHashes).size === 1,
    packetHashes,
    statuses,
    packets: observations.map(({ latencyMs, packet }) => ({
      packetId: String(packet.packetId ?? ""),
      packetHash: String(packet.packetHash ?? ""),
      status: String(packet.status ?? "UNKNOWN"),
      corpusRevision: String(packet.corpusRevision ?? ""),
      latencyMs,
      usedTokens: finiteNumber(record(packet.budget).usedTokens),
      maxTokens: finiteNumber(record(packet.budget).maxTokens),
      sections: Array.isArray(packet.sections) ? packet.sections.length : 0,
      citations: Array.isArray(packet.citations) ? packet.citations.length : 0,
      gaps: Array.isArray(packet.gaps) ? packet.gaps.length : 0,
      conflicts: Array.isArray(packet.conflicts) ? packet.conflicts.length : 0,
    })),
    tokenBudget: {
      usedTokens,
      maxTokens,
    },
  };
}
