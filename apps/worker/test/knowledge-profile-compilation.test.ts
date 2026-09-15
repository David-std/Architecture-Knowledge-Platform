import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  deriveKnowledgePath,
  knowledgeProfileHash,
  type ConfiguredKnowledgeCompiler,
} from "@akp/compiler";
import { DocumentArtifact } from "@akp/contracts";
import {
  NEUTRAL_KNOWLEDGE_PROFILE_V1,
  canonicalKnowledgeProfileJson,
} from "@akp/contracts/knowledge-profile";
import type { Postgres } from "@akp/postgres";
import { buildCompilationStage } from "../src/compilation-stage.js";

const SPACE_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_ID = "33333333-3333-4333-8333-333333333333";
const ARTIFACT_ID = "44444444-4444-4444-8444-444444444444";
const EVIDENCE_ID = "55555555-5555-4555-8555-555555555555";
const PROFILE_REVISION_ID = "77777777-7777-4777-8777-777777777777";
const SOURCE_HASH = "a".repeat(64);
const EXCERPT = "Invalidate cached material when the authoritative revision changes.";
const EXCERPT_HASH = createHash("sha256").update(EXCERPT).digest("hex");

function locator() {
  return {
    kind: "paragraph" as const,
    source_hash: SOURCE_HASH,
    path: `source:${SOURCE_ID}`,
    paragraph: 1,
    heading_path: ["Guidance"],
  };
}

function artifact() {
  return DocumentArtifact.parse({
    source_id: SOURCE_ID,
    source_hash: SOURCE_HASH,
    media_type: "text/markdown",
    extractor: "fixture",
    extractor_version: "1",
    paragraphs: [
      {
        id: "p1",
        kind: "paragraph",
        text: EXCERPT,
        locator: locator(),
      },
    ],
    reading_order: ["p1"],
    locators: [locator()],
  });
}

function stageInput() {
  return {
    spaceId: SPACE_ID,
    vaultId: VAULT_ID,
    sourceId: SOURCE_ID,
    sourceArtifactId: ARTIFACT_ID,
    evidenceId: EVIDENCE_ID,
    sha256: SOURCE_HASH,
    title: "Cache guidance",
    mediaType: "text/markdown",
    extractor: "fixture",
    extractorVersion: "1",
    artifact: artifact(),
    vectorEnabled: false,
  };
}

function dbWithNeutralProfile() {
  const canonicalProfile = canonicalKnowledgeProfileJson(
    NEUTRAL_KNOWLEDGE_PROFILE_V1,
  );
  const query = vi
    .fn()
    .mockResolvedValueOnce({
      rows: [
        {
          schema_profile: {},
          current_revision: "managed:neutral-1",
          active_profile_revision_id: PROFILE_REVISION_ID,
          profile_revision_id: PROFILE_REVISION_ID,
          profile_hash: knowledgeProfileHash(NEUTRAL_KNOWLEDGE_PROFILE_V1),
          canonical_profile: canonicalProfile,
        },
      ],
    })
    .mockResolvedValueOnce({
      rows: [
        {
          id: EVIDENCE_ID,
          locator: locator(),
          content_hash: EXCERPT_HASH,
          excerpt: EXCERPT,
        },
      ],
    })
    .mockResolvedValueOnce({ rows: [] });
  return {
    db: { pool: { query } } as unknown as Postgres,
    query,
  };
}

function configuredCompiler(kind: "note" | "rule") {
  const statement = "Invalidate stale cached material after a revision change.";
  const compile = vi.fn(async () => ({
    identity: {
      classification: "DISTINCT" as const,
      candidates: [],
      reason: "New grounded guidance.",
    },
    evidenceCandidates: [
      {
        sourceArtifactId: ARTIFACT_ID,
        locator: locator(),
        excerptHash: EXCERPT_HASH,
      },
    ],
    knowledgeCandidates: [
      {
        candidateId: "candidate-1",
        kind,
        statement,
        scope: "Revision-addressed caches.",
        evidenceIds: [EVIDENCE_ID],
        confidence: 0.9,
        proposedAction: "CREATE" as const,
      },
    ],
    contradictions: [],
    proposedFileChanges: [
      {
        candidateId: "candidate-1",
        path: deriveKnowledgePath({ title: statement, kind }),
        operation: "CREATE" as const,
        content: `---\nid: CACHE-1\ntype: ${kind}\nstatus: draft\n---\n\n${statement}\n`,
        reasons: ["Grounded in source evidence."],
        evidenceIds: [EVIDENCE_ID],
      },
    ],
    impactedDocumentIds: [],
    probes: [
      {
        question: "Is the proposal grounded?",
        criticality: "CRITICAL" as const,
        evidenceIds: [EVIDENCE_ID],
      },
    ],
    warnings: [],
    summary: "One grounded proposal for review.",
  }));
  return {
    configured: {
      compiler: { compile },
      descriptor: {
        provider: "openai-compatible" as const,
        model: "fixture-compiler",
        baseUrl: "http://127.0.0.1:9999/v1",
      },
    } satisfies ConfiguredKnowledgeCompiler,
    compile,
  };
}

describe("active profile compiler integration", () => {
  it("passes the exact active profile revision and its allowed kinds to the provider", async () => {
    const { db } = dbWithNeutralProfile();
    const { configured, compile } = configuredCompiler("note");

    const output = await buildCompilationStage(db, stageInput(), configured);

    expect(output.plan.disposition).toBe("NEW");
    expect(compile).toHaveBeenCalledOnce();
    expect(compile.mock.calls[0]?.[0]).toMatchObject({
      knowledgeProfile: {
        source: "DURABLE_REVISION",
        revisionId: PROFILE_REVISION_ID,
        profile: {
          profileId: "neutral-notes",
          version: "1.0.0",
        },
      },
      policy: {
        allowedKnowledgeKinds: ["note", "procedure"],
      },
    });
  });

  it("rejects a model-emitted kind that the active profile does not declare", async () => {
    const { db } = dbWithNeutralProfile();
    const { configured } = configuredCompiler("rule");

    await expect(
      buildCompilationStage(db, stageInput(), configured),
    ).rejects.toThrow(/COMPILER_KIND_NOT_ALLOWED:rule/);
  });
});
