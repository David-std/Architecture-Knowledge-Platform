import { describe, expect, it } from "vitest";
import { DEFAULT_KNOWLEDGE_PROFILE_V1 } from "../src/knowledge-profile.js";
import { classifyKnowledgeProfileCompatibility } from "../src/knowledge-profile-compatibility.js";

describe("classifyKnowledgeProfileCompatibility", () => {
  it("keeps version and display metadata changes non-breaking", () => {
    const candidate = structuredClone(DEFAULT_KNOWLEDGE_PROFILE_V1);
    candidate.version = "0.3-compat-metadata";
    candidate.displayName = "Renamed compatibility profile";

    const result = classifyKnowledgeProfileCompatibility(
      DEFAULT_KNOWLEDGE_PROFILE_V1,
      candidate,
    );

    expect(result.compatibilityClass).toBe("NON_BREAKING");
    expect(result.requiresReview).toBe(false);
    expect(result.issues).toEqual([]);
  });

  it("classifies retrieval-only policy changes as reindex required", () => {
    const candidate = structuredClone(DEFAULT_KNOWLEDGE_PROFILE_V1);
    candidate.version = "0.3-compat-retrieval";
    candidate.retrievalPolicy.progressiveDisclosure = ["L0", "L1"];

    const result = classifyKnowledgeProfileCompatibility(
      DEFAULT_KNOWLEDGE_PROFILE_V1,
      candidate,
    );

    expect(result.compatibilityClass).toBe("REINDEX_REQUIRED");
    expect(result.requiredActions).toEqual(["REINDEX"]);
    expect(result.issues.map((issue) => issue.code)).toContain(
      "RETRIEVAL_POLICY_CHANGED",
    );
  });

  it("requires migration when a required field is added to a kind in use", () => {
    const candidate = structuredClone(DEFAULT_KNOWLEDGE_PROFILE_V1);
    candidate.version = "0.3-compat-required-field";
    candidate.knowledgeKinds.claim!.fields.owner = {
      type: "string",
      required: true,
    };

    const result = classifyKnowledgeProfileCompatibility(
      DEFAULT_KNOWLEDGE_PROFILE_V1,
      candidate,
      { kindCounts: { claim: 7 } },
    );

    expect(result.compatibilityClass).toBe("MIGRATION_REQUIRED");
    expect(result.requiresReview).toBe(true);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "REQUIRED_FIELD_ADDED",
          usageCount: 7,
        }),
      ]),
    );
  });

  it("blocks removal of a lifecycle state that is currently in use", () => {
    const candidate = structuredClone(DEFAULT_KNOWLEDGE_PROFILE_V1);
    candidate.version = "0.3-compat-no-active";
    const lifecycle = candidate.lifecycles["knowledge-v03"]!;
    lifecycle.states = lifecycle.states.filter((state) => state !== "ACTIVE");
    lifecycle.transitions = lifecycle.transitions.filter(
      (transition) =>
        transition.from !== "ACTIVE" && transition.to !== "ACTIVE",
    );

    const result = classifyKnowledgeProfileCompatibility(
      DEFAULT_KNOWLEDGE_PROFILE_V1,
      candidate,
      { lifecycleStateCounts: { "knowledge-v03": { ACTIVE: 3 } } },
    );

    expect(result.compatibilityClass).toBe("UNSAFE");
    expect(result.requiredActions).toContain("BLOCK_ACTIVATION");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "LIFECYCLE_STATE_REMOVED",
          usageCount: 3,
        }),
      ]),
    );
  });

  it("uses corpus relation usage when relation semantics change", () => {
    const usedCandidate = structuredClone(DEFAULT_KNOWLEDGE_PROFILE_V1);
    usedCandidate.version = "0.3-compat-relation-used";
    usedCandidate.relationTypes.supports!.evidenceRequired = false;

    const used = classifyKnowledgeProfileCompatibility(
      DEFAULT_KNOWLEDGE_PROFILE_V1,
      usedCandidate,
      { relationCounts: { supports: 2 } },
    );
    expect(used.compatibilityClass).toBe("MIGRATION_REQUIRED");
    expect(used.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "RELATION_SEMANTICS_CHANGED",
          usageCount: 2,
        }),
      ]),
    );

    const unusedCandidate = structuredClone(DEFAULT_KNOWLEDGE_PROFILE_V1);
    unusedCandidate.version = "0.3-compat-relation-unused";
    unusedCandidate.relationTypes.supports!.evidenceRequired = false;
    const unused = classifyKnowledgeProfileCompatibility(
      DEFAULT_KNOWLEDGE_PROFILE_V1,
      unusedCandidate,
    );
    expect(unused.compatibilityClass).toBe("RECOMPILE_REQUIRED");
  });

  it("rejects a silent profile identity change as unsafe", () => {
    const candidate = structuredClone(DEFAULT_KNOWLEDGE_PROFILE_V1);
    candidate.profileId = "different-profile";
    candidate.version = "1.0.0";

    const result = classifyKnowledgeProfileCompatibility(
      DEFAULT_KNOWLEDGE_PROFILE_V1,
      candidate,
    );

    expect(result.compatibilityClass).toBe("UNSAFE");
    expect(result.issues[0]?.code).toBe("PROFILE_ID_CHANGED");
  });
});
