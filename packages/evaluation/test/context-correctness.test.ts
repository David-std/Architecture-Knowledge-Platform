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
  identifiers?: string[];
  expectations: Record<string, unknown>;
}

interface RegressionPack {
  schemaVersion: number;
  evidenceLevel: string;
  productionDefaultsChanged: boolean;
  cases: RegressionCase[];
}

async function loadPack(): Promise<RegressionPack> {
  const content = await readFile(fixturePath, "utf8");
  return JSON.parse(content) as RegressionPack;
}

function caseOf(pack: RegressionPack, kind: string): RegressionCase {
  const found = pack.cases.find((item) => item.kind === kind);
  expect(found, `missing regression family ${kind}`).toBeDefined();
  return found as RegressionCase;
}

function expectFlags(
  item: RegressionCase,
  expected: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(expected)) {
    expect(item.expectations[key]).toEqual(value);
  }
}

describe("context correctness regression contract", () => {
  it("registers every mandatory deep-spec regression family", async () => {
    const pack = await loadPack();
    expect(pack.schemaVersion).toBe(1);
    expect(pack.productionDefaultsChanged).toBe(false);
    expect(pack.evidenceLevel).toBe("P0_REGRESSION_SPEC");

    const temporal = caseOf(pack, "TEMPORAL_TRUTH_CONTRADICTION");
    const token = caseOf(pack, "TOKENIZATION_AND_EXACT_IDENTIFIER");
    const multivault = caseOf(pack, "MULTI_VAULT_COLLISION");
    const handoff = caseOf(pack, "TWO_AGENT_WORKSPACE_HANDOFF");
    const code = caseOf(pack, "CODE_GRAPH_FIXTURE");
    const disagreement = caseOf(pack, "DECLARED_VS_OBSERVED_SYSTEM");
    const truth = caseOf(pack, "TRUTH_MAINTENANCE_WITHDRAWAL");
    const placement = caseOf(
      pack,
      "CONTEXT_PLACEMENT_AND_MANDATORY_CONSTRAINTS",
    );

    const oldScore = temporal.denseScores?.["security-guide-v1"] ?? 0;
    const newScore = temporal.denseScores?.["security-guide-v3"] ?? Infinity;
    expect(oldScore).toBeGreaterThan(newScore);
    expect(Math.abs(oldScore - newScore)).toBeLessThan(0.01);
    expectFlags(temporal, {
      current: ["security-guide-v3"],
      asOfBeforeChange: ["security-guide-v1"],
      mustNotResolveBy: "DENSE_SCORE_ONLY",
      readTimeSupportValidationRequired: true,
    });

    expectFlags(token, {
      benchmarkLanguages: ["en", "es", "code"],
      approximateFallbackMustBeLabeled: true,
      serializedContextPacketMeasured: true,
      exactOrLexicalIdentifierChannelRequired: true,
    });
    expect(token.identifiers).toEqual(
      expect.arrayContaining([
        "AuthTokenRotationPolicy",
        "rotate_access_token",
        "rotateAccessToken",
        "auth-token-rotation",
        "ERR_AUTH_ROTATION_STALE",
        "5f4dcc3b-5aa7-4f4f-8a23-112233445566",
      ]),
    );

    expectFlags(multivault, {
      authorizationSeparatesCandidatesBeforeRanking: true,
      sameTitle: true,
      sameAlias: true,
      sameRelativePath: true,
      crossVaultLeakageAllowed: false,
    });

    expectFlags(handoff, {
      overlappingClaimRejectedOrFenced: true,
      structuredHandoffRequired: true,
      canonicalPublicationRequiresReview: true,
      normalAgentMayApprove: false,
      normalAgentMayPublish: false,
    });

    expectFlags(code, {
      crossFilePathPresent: true,
      inheritancePresent: true,
      testLinkagePresent: true,
      generatedAndVendorExcluded: true,
      ambiguousCallNotUpgradedToExtracted: true,
    });

    expectFlags(disagreement, {
      preserveAllObservations: true,
      runtimeAbsenceDoesNotDeleteCatalogRelation: true,
      mustNotFlattenToGenericRelatedTo: true,
    });

    expectFlags(truth, {
      conclusionMayRemainViaIndependentSourceB: true,
      sourceACitationRemovedFromCurrentExplanation: true,
      sourceADerivedCandidateRejectedBeforeRanking: true,
      physicalCleanupMayBeAsynchronous: true,
    });

    expectFlags(placement, {
      rulePlacedBeforeHigherScoreConcept: true,
      requiredActionsRetainedInFullPacket: true,
      requiredActionsRetainedInCompactPacket: true,
      requiredActionOrderPreserved: true,
      truncatedEvidenceUsesContinuation: true,
      mandatoryActionsNeverMoveIntoRetrievedContent: true,
    });
  });
});
