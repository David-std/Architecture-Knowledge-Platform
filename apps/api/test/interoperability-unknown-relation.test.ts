import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  NEUTRAL_KNOWLEDGE_PROFILE_V1,
  canonicalKnowledgeProfileJson,
} from "@akp/contracts/knowledge-profile";
import { durableCompilerKnowledgeProfileContext } from "@akp/compiler";
import {
  OkfBundleV02,
  OkfInteropError,
  planOkfReviewImport,
} from "../src/interoperability.js";

const canonical = canonicalKnowledgeProfileJson(NEUTRAL_KNOWLEDGE_PROFILE_V1);
const profile = durableCompilerKnowledgeProfileContext({
  revisionId: "00000000-0000-4000-8000-000000000902",
  profileHash: createHash("sha256").update(canonical).digest("hex"),
  profile: NEUTRAL_KNOWLEDGE_PROFILE_V1,
});

describe("OKF unknown relation rejection", () => {
  it("fails closed when an imported relation is not declared or explicitly mapped", () => {
    const bundle = OkfBundleV02.parse({
      format: "OKF",
      version: "0.2",
      bundleId: "unknown-relation-bundle",
      exportedAt: "2026-09-15T00:00:00.000Z",
      source: { system: "Foreign Knowledge System" },
      documents: [
        {
          id: "FOREIGN-NOTE",
          title: "Foreign note",
          kind: "note",
          lifecycle: "DRAFT",
          trust: "UNVERIFIED",
          body: "# Foreign note\n\nA substantive foreign note used only to prove relation mapping fails closed before any local review draft is created.",
        },
        {
          id: "FOREIGN-PROCEDURE",
          title: "Foreign procedure",
          kind: "procedure",
          lifecycle: "DRAFT",
          trust: "UNVERIFIED",
          body: "# Foreign procedure\n\nA substantive foreign procedure used as the second endpoint of an undeclared relation in the import candidate.",
        },
      ],
      relations: [
        {
          fromId: "FOREIGN-NOTE",
          toId: "FOREIGN-PROCEDURE",
          type: "foreign-supports",
          weight: 1,
          provenance: "foreign-explicit",
        },
      ],
    });

    try {
      planOkfReviewImport({ bundle, knowledgeProfile: profile });
      throw new Error("expected unknown relation rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(OkfInteropError);
      expect((error as OkfInteropError).code).toBe(
        "OKF_RELATION_MAPPING_REQUIRED",
      );
    }
  });
});
