import { describe, expect, it } from "vitest";
import {
  buildCompetitiveArenaReport,
  measured,
  percentile,
  unmeasured,
  type CompetitiveSystemResult,
} from "../src/competitive-arena.js";

function emptyMetrics() {
  return {
    retrievalRuns: [],
    graph: {
      typedPathPrecision: unmeasured("not run"),
      multiHopRecall: unmeasured("not run"),
      pprAssociativeRecall: unmeasured("not run"),
      globalCommunityCoverage: unmeasured("not run"),
      bridgeAccuracy: unmeasured("not run"),
      staleEdgeSuppression: unmeasured("not run"),
      unauthorizedPathRate: unmeasured("not run"),
      pathExplainability: unmeasured("not run"),
    },
    code: {
      symbolResolution: unmeasured("not run"),
      callersCalleesCorrectness: unmeasured("not run"),
      dependencyPathPrecision: unmeasured("not run"),
      blastRadiusRecall: unmeasured("not run"),
      changeImpactRecall: unmeasured("not run"),
      testLinkageAccuracy: unmeasured("not run"),
      ruleDecisionBridgePrecision: unmeasured("not run"),
      buildTimeMs: unmeasured("not run"),
      incrementalUpdateMs: unmeasured("not run"),
      staleDetection: unmeasured("not run"),
    },
    temporal: {
      currentTruthAccuracy: unmeasured("not run"),
      asOfAccuracy: unmeasured("not run"),
      changedSinceAccuracy: unmeasured("not run"),
      withdrawalBehavior: unmeasured("not run"),
      alternativeSupportAccuracy: unmeasured("not run"),
      staleDerivedSuppression: unmeasured("not run"),
      mixedRevisionDetection: unmeasured("not run"),
    },
    team: {
      crossSpaceLeakRate: unmeasured("not run"),
      privateToTeamLeakRate: unmeasured("not run"),
      revokedPrincipalAccessRate: unmeasured("not run"),
      pinnedContextReproducibility: unmeasured("not run"),
      handoffCompleteness: unmeasured("not run"),
      overlappingClaimFencing: unmeasured("not run"),
      promotionCorrectness: unmeasured("not run"),
      offlineStaleDisclosure: unmeasured("not run"),
      federationPartialFailure: unmeasured("not run"),
    },
  };
}

describe("competitive arena evidence", () => {
  it("keeps unmeasured metrics null instead of coercing them to zero", () => {
    expect(unmeasured("external adapter unavailable")).toEqual({
      value: null,
      measured: false,
      reason: "external adapter unavailable",
    });
  });

  it("computes deterministic percentiles", () => {
    expect(percentile([10, 30, 20, 40], 0.5)).toBe(20);
    expect(percentile([10, 30, 20, 40], 0.95)).toBe(40);
    expect(percentile([], 0.95)).toBeNull();
  });

  it("reports coverage without manufacturing a winner", () => {
    const base = emptyMetrics();
    const system: CompetitiveSystemResult = {
      id: "akp-current",
      label: "AKP current runtime",
      executionStatus: "EXECUTED",
      executionKind: "CURRENT_RUNTIME",
      source: "registered retrieval report",
      limitations: [],
      ...base,
      retrievalRuns: [
        {
          configuration: "lexical",
          metrics: {
            recallAt5: measured(1),
            recallAt10: measured(1),
            mrr: measured(1),
            ndcgAt10: measured(1),
            contextPrecision: unmeasured("not labelled"),
            claimSupportRecall: unmeasured("not labelled"),
            citationPrecision: measured(1),
            unsupportedClaimRate: measured(0),
            noAnswerAccuracy: measured(1),
            contradictionRecall: unmeasured("not in this dataset"),
            latencyP50Ms: measured(10),
            latencyP95Ms: measured(20),
            contextTokens: measured(100),
            providerCost: unmeasured("local retrieval has no provider billing"),
          },
        },
      ],
    };
    const report = buildCompetitiveArenaReport(
      [system],
      "registered corpus only",
      "2026-09-20T07:00:00.000Z",
    );
    expect(report.status).toBe("PARTIAL");
    expect(report.winner).toBeNull();
    expect(report.superiorityClaimAllowed).toBe(false);
    expect(report.coverage.executed).toEqual(["akp-current"]);
  });
});
