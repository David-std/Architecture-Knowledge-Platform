import { describe, expect, it, vi } from "vitest";
import type { Postgres } from "@akp/postgres";
import type { ConfiguredKnowledgeCompiler } from "@akp/compiler";
import { DocumentArtifact } from "@akp/contracts";
import { buildCompilationStage } from "../src/compilation-stage.js";

const SPACE_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_ID = "33333333-3333-4333-8333-333333333333";
const ARTIFACT_ID = "44444444-4444-4444-8444-444444444444";
const EVIDENCE_ID = "55555555-5555-4555-8555-555555555555";
const SOURCE_HASH = "a".repeat(64);
const EXCERPT_HASH = "b".repeat(64);

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
        text: "Invalidate cached material when the authoritative revision changes.",
        locator: {
          kind: "paragraph",
          source_hash: SOURCE_HASH,
          path: `source:${SOURCE_ID}`,
          paragraph: 1,
          heading_path: ["Guidance"],
        },
      },
    ],
    reading_order: ["p1"],
    locators: [
      {
        kind: "paragraph",
        source_hash: SOURCE_HASH,
        path: `source:${SOURCE_ID}`,
        paragraph: 1,
        heading_path: ["Guidance"],
      },
    ],
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

describe("compilation stage", () => {
  it("keeps the provenance-preserving source-summary fallback explicit", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ schema_profile: {}, current_revision: "managed:7" }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const db = { pool: { query } } as unknown as Postgres;

    const output = await buildCompilationStage(db, stageInput(), null);

    expect(output.metadata).toEqual({
      mode: "SOURCE_SUMMARY_FALLBACK",
      reason: "GENERIC_COMPILER_DISABLED_OR_UNCONFIGURED",
    });
    expect(output.plan).toMatchObject({
      sourceId: SOURCE_ID,
      corpusRevision: "managed:7",
      disposition: "NEW",
    });
    expect(output.plan.proposedChanges[0]?.evidenceIds).toEqual([EVIDENCE_ID]);
    expect(output.plan.probes[0]?.evidenceIds).toEqual([EVIDENCE_ID]);
    expect(output.plan.summary).toContain("no semantic compilation occurred");
  });

  it("grounds generative compilation in evidence reloaded from the same vault", async () => {
    const locator = {
      kind: "paragraph",
      source_hash: SOURCE_HASH,
      path: `source:${SOURCE_ID}`,
      paragraph: 1,
      heading_path: ["Guidance"],
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ schema_profile: {}, current_revision: "managed:8" }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: EVIDENCE_ID,
            locator,
            content_hash: EXCERPT_HASH,
            excerpt:
              "Invalidate cached material when the authoritative revision changes.",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const compile = vi.fn(async (input) => ({
      identity: {
        classification: "DISTINCT" as const,
        candidates: [],
        reason: "New grounded rule.",
      },
      evidenceCandidates: [
        {
          sourceArtifactId: ARTIFACT_ID,
          locator,
          excerptHash: EXCERPT_HASH,
        },
      ],
      knowledgeCandidates: [
        {
          candidateId: "candidate-1",
          kind: "rule" as const,
          statement:
            "Invalidate cached material when the authoritative revision changes.",
          scope: "Revision-addressed caches.",
          evidenceIds: [EVIDENCE_ID],
          confidence: 0.9,
          proposedAction: "CREATE" as const,
        },
      ],
      contradictions: [],
      proposedFileChanges: [
        {
          path: "20-knowledge/generated/rule/cache-invalidation.md",
          operation: "CREATE" as const,
          content:
            "---\nid: CACHE-1\ntype: rule\nstatus: draft\n---\n\n# Cache invalidation\n",
          reasons: ["Grounded rule."],
          evidenceIds: [EVIDENCE_ID],
        },
      ],
      impactedDocumentIds: [],
      probes: [
        {
          question: "Is the rule grounded?",
          criticality: "CRITICAL" as const,
          evidenceIds: [EVIDENCE_ID],
        },
      ],
      warnings: [],
      summary: "One grounded rule for review.",
    }));
    const configured = {
      compiler: { compile },
      descriptor: {
        provider: "openai-compatible" as const,
        model: "fixture-compiler",
        baseUrl: "http://127.0.0.1:9999/v1",
      },
    } satisfies ConfiguredKnowledgeCompiler;
    const db = { pool: { query } } as unknown as Postgres;

    const output = await buildCompilationStage(db, stageInput(), configured);

    expect(output.metadata).toMatchObject({
      mode: "GENERATIVE",
      provider: configured.descriptor,
      retrievalChannels: ["exact", "lexical"],
      retrievalWarnings: ["COMPILER_SEMANTIC_RETRIEVAL_DISABLED"],
      knowledgeCandidateCount: 1,
      contradictionCount: 0,
    });
    expect(output.plan.proposedChanges[0]?.evidenceIds).toEqual([EVIDENCE_ID]);
    expect(compile).toHaveBeenCalledOnce();
    expect(compile.mock.calls[0]?.[0]).toMatchObject({
      spaceId: SPACE_ID,
      vaultId: VAULT_ID,
      evidence: [
        {
          id: EVIDENCE_ID,
          sourceArtifactId: ARTIFACT_ID,
          excerptHash: EXCERPT_HASH,
        },
      ],
    });
    expect(query.mock.calls[1]?.[1]).toEqual([
      EVIDENCE_ID,
      SPACE_ID,
      VAULT_ID,
      SOURCE_ID,
      ARTIFACT_ID,
    ]);
  });
});
