import { describe, expect, it } from "vitest";
import {
  compareEvaluationRuns,
  summarizePacketBenchmark,
} from "../src/metrics.js";

describe("evaluation comparison", () => {
  it("computes candidate-minus-baseline deltas without inventing absent metrics", () => {
    const comparison = compareEvaluationRuns(
      {
        id: "baseline",
        status: "PASSED",
        corpus_revision: "rev-1",
        metrics: { passed: 3, meanRecallAt10: 0.75 },
      },
      {
        id: "candidate",
        status: "PASSED",
        corpus_revision: "rev-1",
        metrics: { passed: 4, meanRecallAt10: 1 },
      },
    );

    expect(comparison.sameCorpusRevision).toBe(true);
    expect(
      comparison.metrics.find(({ name }) => name === "passed")?.delta,
    ).toBe(1);
    expect(
      comparison.metrics.find(({ name }) => name === "meanRecallAt10")?.delta,
    ).toBe(0.25);
    expect(
      comparison.metrics.find(({ name }) => name === "meanLatencyMs")?.delta,
    ).toBeNull();
  });
});

describe("packet benchmark summary", () => {
  it("reports observed latency, budgets, hashes and packet sizes", () => {
    const summary = summarizePacketBenchmark("bounded context", [
      {
        latencyMs: 20,
        packet: {
          packetId: "packet-1",
          packetHash: "same",
          status: "SUPPORTED",
          corpusRevision: "rev-1",
          budget: { usedTokens: 100, maxTokens: 500 },
          sections: [{ title: "one" }],
          citations: ["source"],
          gaps: [],
          conflicts: [],
        },
      },
      {
        latencyMs: 10,
        packet: {
          packetId: "packet-2",
          packetHash: "same",
          status: "SUPPORTED",
          corpusRevision: "rev-1",
          budget: { usedTokens: 100, maxTokens: 500 },
          sections: [{ title: "one" }],
          citations: ["source"],
          gaps: [],
          conflicts: [],
        },
      },
    ]);

    expect(summary.stablePacketHash).toBe(true);
    expect(summary.latencyMs).toEqual({
      minimum: 10,
      mean: 15,
      p50: 10,
      p95: 20,
      maximum: 20,
    });
  });
});
