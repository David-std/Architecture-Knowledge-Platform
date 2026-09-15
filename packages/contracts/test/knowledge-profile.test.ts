import { describe, expect, it } from "vitest";
import {
  canonicalKnowledgeProfileJson,
  DEFAULT_KNOWLEDGE_PROFILE_V1,
  KnowledgeProfileV1,
  NEUTRAL_KNOWLEDGE_PROFILE_V1,
} from "../src/knowledge-profile.js";

describe("KnowledgeProfileV1", () => {
  it("encodes the v0.3 compatibility surface as the default profile", () => {
    const parsed = KnowledgeProfileV1.parse(DEFAULT_KNOWLEDGE_PROFILE_V1);
    expect(parsed.profileId).toBe("default");
    expect(parsed.version).toBe("0.3-compat");
    expect(Object.keys(parsed.knowledgeKinds).sort()).toEqual([
      "claim",
      "concept",
      "counterexample",
      "decision",
      "example",
      "rule",
      "workflow",
    ]);
    expect(parsed.reviewPolicies["human-review-v03"]?.required).toBe(true);
    expect(parsed.evidencePolicies["grounded-v03"]?.minimumEvidence).toBe(1);
    expect(parsed.retrievalPolicy.progressiveDisclosure).toEqual([
      "L0",
      "L1",
      "L2",
      "L3",
    ]);
  });

  it("supports a second neutral profile without platform-code changes", () => {
    const parsed = KnowledgeProfileV1.parse(NEUTRAL_KNOWLEDGE_PROFILE_V1);
    expect(Object.keys(parsed.knowledgeKinds).sort()).toEqual([
      "note",
      "procedure",
    ]);
    expect(parsed.lifecycles["procedure-flow"]?.states).toContain(
      "VALIDATED",
    );
    expect(parsed.relationTypes.follows?.from).toEqual(["procedure"]);
  });

  it(
    "canonicalizes semantic profiles independently of object key order",
    () => {
      const baseline = canonicalKnowledgeProfileJson(
        DEFAULT_KNOWLEDGE_PROFILE_V1,
      );
      const reordered = {
        freshnessPolicy: DEFAULT_KNOWLEDGE_PROFILE_V1.freshnessPolicy,
        promotionPolicy: DEFAULT_KNOWLEDGE_PROFILE_V1.promotionPolicy,
        retrievalPolicy: DEFAULT_KNOWLEDGE_PROFILE_V1.retrievalPolicy,
        artifactContracts: DEFAULT_KNOWLEDGE_PROFILE_V1.artifactContracts,
        reviewPolicies: DEFAULT_KNOWLEDGE_PROFILE_V1.reviewPolicies,
        evidencePolicies: DEFAULT_KNOWLEDGE_PROFILE_V1.evidencePolicies,
        lifecycles: DEFAULT_KNOWLEDGE_PROFILE_V1.lifecycles,
        relationTypes: DEFAULT_KNOWLEDGE_PROFILE_V1.relationTypes,
        knowledgeKinds: Object.fromEntries(
          Object.entries(DEFAULT_KNOWLEDGE_PROFILE_V1.knowledgeKinds).reverse(),
        ),
        displayName: DEFAULT_KNOWLEDGE_PROFILE_V1.displayName,
        version: DEFAULT_KNOWLEDGE_PROFILE_V1.version,
        profileId: DEFAULT_KNOWLEDGE_PROFILE_V1.profileId,
        schemaVersion: DEFAULT_KNOWLEDGE_PROFILE_V1.schemaVersion,
        modelRoleConstraints: DEFAULT_KNOWLEDGE_PROFILE_V1.modelRoleConstraints,
      };
      expect(canonicalKnowledgeProfileJson(reordered)).toBe(baseline);
    },
  );

  it("rejects relations that reference unknown knowledge kinds", () => {
    const invalid = structuredClone(NEUTRAL_KNOWLEDGE_PROFILE_V1);
    invalid.relationTypes.follows = {
      from: ["missing"],
      to: ["procedure"],
      symmetric: false,
      evidenceRequired: false,
    };
    const result = KnowledgeProfileV1.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          issue.message.includes("unknown knowledge kind"),
        ),
      ).toBe(true);
    }
  });

  it("rejects unsafe artifact paths", () => {
    const invalid = structuredClone(DEFAULT_KNOWLEDGE_PROFILE_V1);
    invalid.artifactContracts["markdown-v03"] = {
      root: "../../outside",
      pathTemplate: "{kind}/{candidateId}.md",
      extension: ".md",
    };
    expect(KnowledgeProfileV1.safeParse(invalid).success).toBe(false);
  });

  it("rejects outgoing transitions from terminal lifecycle states", () => {
    const invalid = structuredClone(NEUTRAL_KNOWLEDGE_PROFILE_V1);
    invalid.lifecycles["note-flow"]?.transitions.push({
      from: "RETIRED",
      to: "ACTIVE",
      allowedActors: ["ADMIN"],
      requiredEvidence: false,
      requiredReview: true,
    });
    expect(KnowledgeProfileV1.safeParse(invalid).success).toBe(false);
  });
});
