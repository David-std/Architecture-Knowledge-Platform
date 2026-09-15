import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const fixturePath = path.join(
  repositoryRoot,
  "evals",
  "registered",
  "context-correctness-regressions.json",
);

interface RegressionCase {
  id: string;
  kind: string;
  denseScores?: Record<string, number>;
  expectations: Record<string, unknown>;
}

interface RegressionPack {
  schemaVersion: number;
  evidenceLevel: string;
  productionDefaultsChanged: boolean;
  cases: RegressionCase[];
}

async function loadRegressionPack(): Promise<RegressionPack> {
  return JSON.parse(await readFile(fixturePath, "utf8")) as RegressionPack;
}

describe("context correctness regression contract", () => {
  it("pins every mandatory deep-spec P0 regression family", async () => {
    const pack = await loadRegressionPack();
    expect(pack.schemaVersion).toBe(1);
    expect(pack.productionDefaultsChanged).toBe(false);
    expect(pack.evidenceLevel).toBe("P0_REGRESSION_SPEC");

    const requiredKinds = [
      "TEMPORAL_TRUTH_CONTRADICTION",
      "TOKENIZATION_AND_EXACT_IDENTIFIER",
      "MULTI_VAULT_COLLISION",
      "TWO_AGENT_WORKSPACE_HANDOFF",
      "CODE_GRAPH_FIXTURE",
      "DECLARED_VS_OBSERVED_SYSTEM",
      "TRUTH_MAINTENANCE_WITHDRAWAL",
      "CONTEXT_PLACEMENT_AND_MANDATORY_CONSTRAINTS",
    ];
    const actualKinds = new Set(pack.cases.map((item) => item.kind));
    for (const kind of requiredKinds) {
      expect(actualKinds.has(kind), `missing P0 regression family ${kind}`).toBe(
        true,
      );
    }

    const temporal = pack.cases.find(
      (item) => item.kind === "TEMPORAL_TRUTH_CONTRADICTION",
    );
    const scores = temporal?.denseScores;
    const oldScore = scores?.["security-guide-v1"] ?? 0;
    const currentScore = scores?.["security-guide-v3"] ?? Infinity;
    expect(oldScore).toBeGreaterThan(currentScore);
    expect(Math.abs(oldScore - currentScore)).toBeLessThan(0.01);
    expect(temporal?.expectations.current).toEqual(["security-guide-v3"]);
    expect(temporal?.expectations.asOfBeforeChange).toEqual([
      "security-guide-v1",
    ]);
    expect(temporal?.expectations.mustNotResolveBy).toBe("DENSE_SCORE_ONLY");
    expect(temporal?.expectations.readTimeSupportValidationRequired).toBe(true);

    const tokenCase = pack.cases.find(
      (item) => item.kind === "TOKENIZATION_AND_EXACT_IDENTIFIER",
    );
    expect(tokenCase?.expectations.benchmarkLanguages).toEqual([
      "en",
      "es",
      "code",
    ]);
    expect(tokenCase?.expectations.approximateFallbackMustBeLabeled).toBe(true);
    expect(tokenCase?.expectations.serializedContextPacketMeasured).toBe(true);
    expect(tokenCase?.expectations.exactOrLexicalIdentifierChannelRequired).toBe(
      true,
    );

    const multivault = pack.cases.find(
      (item) => item.kind === "MULTI_VAULT_COLLISION",
    );
    expect(
      multivault?.expectations.authorizationSeparatesCandidatesBeforeRanking,
    ).toBe(true);
    expect(multivault?.expectations.sameTitle).toBe(true);
    expect(multivault?.expectations.sameAlias).toBe(true);
    expect(multivault?.expectations.sameRelativePath).toBe(true);
    expect(multivault?.expectations.crossVaultLeakageAllowed).toBe(false);

    const handoff = pack.cases.find(
      (item) => item.kind === "TWO_AGENT_WORKSPACE_HANDOFF",
    );
    expect(handoff?.expectations.overlappingClaimRejectedOrFenced).toBe(true);
    expect(handoff?.expectations.structuredHandoffRequired).toBe(true);
    expect(handoff?.expectations.canonicalPublicationRequiresReview).toBe(true);
    expect(handoff?.expectations.normalAgentMayApprove).toBe(false);
    expect(handoff?.expectations.normalAgentMayPublish).toBe(false);

    const codeGraph = pack.cases.find(
      (item) => item.kind === "CODE_GRAPH_FIXTURE",
    );
    expect(codeGraph?.expectations.crossFilePathPresent).toBe(true);
    expect(codeGraph?.expectations.inheritancePresent).toBe(true);
    expect(codeGraph?.expectations.testLinkagePresent).toBe(true);
    expect(codeGraph?.expectations.generatedAndVendorExcluded).toBe(true);
    expect(codeGraph?.expectations.ambiguousCallNotUpgradedToExtracted).toBe(true);

    const disagreement = pack.cases.find(
      (item) => item.kind === "DECLARED_VS_OBSERVED_SYSTEM",
    );
    expect(disagreement?.expectations.preserveAllObservations).toBe(true);
    expect(disagreement?.expectations.runtimeAbsenceDoesNotDeleteCatalogRelation).toBe(
      true,
    );
    expect(disagreement?.expectations.mustNotFlattenToGenericRelatedTo).toBe(
      true,
    );

    const truthMaintenance = pack.cases.find(
      (item) => item.kind === "TRUTH_MAINTENANCE_WITHDRAWAL",
    );
    expect(
      truthMaintenance?.expectations.conclusionMayRemainViaIndependentSourceB,
    ).toBe(true);
    expect(
      truthMaintenance?.expectations.sourceACitationRemovedFromCurrentExplanation,
    ).toBe(true);
    expect(
      truthMaintenance?.expectations.sourceADerivedCandidateRejectedBeforeRanking,
    ).toBe(true);
    expect(truthMaintenance?.expectations.physicalCleanupMayBeAsynchronous).toBe(
      true,
    );

    const placement = pack.cases.find(
      (item) => item.kind === "CONTEXT_PLACEMENT_AND_MANDATORY_CONSTRAINTS",
    );
    expect(placement?.expectations.rulePlacedBeforeHigherScoreConcept).toBe(true);
    expect(placement?.expectations.requiredActionsRetainedInFullPacket).toBe(true);
    expect(placement?.expectations.requiredActionsRetainedInCompactPacket).toBe(
      true,
    );
    expect(placement?.expectations.requiredActionOrderPreserved).toBe(true);
    expect(placement?.expectations.truncatedEvidenceUsesContinuation).toBe(true);
    expect(placement?.expectations.mandatoryActionsNeverMoveIntoRetrievedContent).toBe(
      true,
    );
  });
});
