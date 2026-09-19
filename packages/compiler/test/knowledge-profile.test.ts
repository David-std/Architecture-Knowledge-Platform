import { describe, expect, it } from "vitest";
import { NEUTRAL_KNOWLEDGE_PROFILE_V1 } from "@akp/contracts/knowledge-profile";
import {
  allowedCompilerKnowledgeKinds,
  assertCompilerKindAllowedByProfile,
  defaultCompilerKnowledgeProfileContext,
  durableCompilerKnowledgeProfileContext,
  knowledgeProfileHash,
} from "../src/knowledge-profile.js";

const REVISION_ID = "77777777-7777-4777-8777-777777777777";

describe("compiler knowledge profile binding", () => {
  it("preserves the v0.3 compatibility profile as the unbound default", () => {
    const context = defaultCompilerKnowledgeProfileContext();

    expect(context).toMatchObject({
      source: "V03_DEFAULT",
      revisionId: null,
      profile: {
        profileId: "default",
        version: "0.3-compat",
      },
    });
    expect(allowedCompilerKnowledgeKinds(context.profile)).toEqual([
      "claim",
      "concept",
      "counterexample",
      "decision",
      "example",
      "rule",
      "workflow",
    ]);
  });

  it("accepts a hash-pinned durable profile and rejects undeclared kinds", () => {
    const context = durableCompilerKnowledgeProfileContext({
      revisionId: REVISION_ID,
      profileHash: knowledgeProfileHash(NEUTRAL_KNOWLEDGE_PROFILE_V1),
      profile: NEUTRAL_KNOWLEDGE_PROFILE_V1,
    });

    expect(context.source).toBe("DURABLE_REVISION");
    expect(allowedCompilerKnowledgeKinds(context.profile)).toEqual([
      "note",
      "procedure",
    ]);
    expect(() =>
      assertCompilerKindAllowedByProfile(context, "note"),
    ).not.toThrow();
    expect(() => assertCompilerKindAllowedByProfile(context, "rule")).toThrow(
      /COMPILER_PROFILE_KIND_NOT_DECLARED:rule/,
    );
  });

  it("fails closed when the durable profile hash does not match", () => {
    expect(() =>
      durableCompilerKnowledgeProfileContext({
        revisionId: REVISION_ID,
        profileHash: "0".repeat(64),
        profile: NEUTRAL_KNOWLEDGE_PROFILE_V1,
      }),
    ).toThrow(/ACTIVE_KNOWLEDGE_PROFILE_HASH_MISMATCH/);
  });
});
