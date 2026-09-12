import { describe, expect, it, vi } from "vitest";
import {
  KnowledgeCompilerInput,
  OpenAICompatibleKnowledgeCompiler,
  deriveKnowledgePath,
  normalizeKnowledgeCompilerResult,
  resultToCompilationPlan,
} from "../src/index.js";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const ARTIFACT_ID = "22222222-2222-4222-8222-222222222222";
const EVIDENCE_ID = "33333333-3333-4333-8333-333333333333";
const DOCUMENT_ID = "44444444-4444-4444-8444-444444444444";
const SPACE_ID = "55555555-5555-4555-8555-555555555555";
const VAULT_ID = "66666666-6666-4666-8666-666666666666";
const SOURCE_HASH = "a".repeat(64);
const EXCERPT_HASH = "b".repeat(64);

function compilerInput() {
  return KnowledgeCompilerInput.parse({
    source: {
      sourceId: SOURCE_ID,
      sourceArtifactId: ARTIFACT_ID,
      sha256: SOURCE_HASH,
      title: "Portable cache invalidation guidance",
      mediaType: "text/markdown",
    },
    documentArtifact: {
      source_id: SOURCE_ID,
      source_hash: SOURCE_HASH,
      media_type: "text/markdown",
      extractor: "fixture",
      extractor_version: "1",
    },
    evidence: [
      {
        id: EVIDENCE_ID,
        sourceArtifactId: ARTIFACT_ID,
        locator: {
          kind: "paragraph",
          source_hash: SOURCE_HASH,
          path: `source:${SOURCE_ID}`,
          paragraph: 1,
          heading_path: ["Guidance"],
        },
        excerpt:
          "Invalidate cached material when its authoritative revision changes.",
        excerptHash: EXCERPT_HASH,
      },
    ],
    existingCandidates: [
      {
        documentId: DOCUMENT_ID,
        externalId: "GEN-001",
        path: "20-knowledge/concept/cache.md",
        title: "Cache behavior",
        type: "concept",
        lifecycle: "ACTIVE",
        trust: "HUMAN_REVIEWED",
        revision: "rev-1",
        contentExcerpt: "Cached material is revision-aware.",
        score: 0.9,
        reasons: ["lexical:title"],
      },
    ],
    schemaProfile: {},
    policy: {},
    budget: {
      maxInputCharacters: 48_000,
      maxEvidence: 4,
      maxExistingCandidates: 4,
      maxProposedChanges: 4,
      maxProbes: 4,
    },
    corpusRevision: "corpus-7",
    spaceId: SPACE_ID,
    vaultId: VAULT_ID,
  });
}

function groundedResult() {
  return {
    identity: {
      classification: "DISTINCT" as const,
      reason: "The source adds a bounded operational rule.",
    },
    evidenceCandidates: [
      {
        evidenceId: EVIDENCE_ID,
        sourceArtifactId: ARTIFACT_ID,
        locator: {
          kind: "paragraph",
          source_hash: SOURCE_HASH,
          path: `source:${SOURCE_ID}`,
          paragraph: 1,
          heading_path: ["Guidance"],
        },
        excerptHash: EXCERPT_HASH,
      },
    ],
    knowledgeCandidates: [
      {
        candidateId: "candidate-1",
        kind: "rule" as const,
        statement:
          "Invalidate cached material when its authoritative revision changes.",
        scope: "Applies to revision-addressed cached knowledge.",
        evidenceIds: [EVIDENCE_ID],
        confidence: 0.92,
        proposedAction: "CREATE" as const,
      },
    ],
    contradictions: [],
    proposedFileChanges: [
      {
        path: "20-knowledge/generated/rule/cache-invalidation.md",
        operation: "CREATE" as const,
        content:
          "---\nid: GEN-CACHE-INVALIDATION\ntype: rule\nstatus: draft\n---\n\n# Cache invalidation\n\nInvalidate cached material when its authoritative revision changes.\n",
        reasons: ["Grounded in extracted evidence."],
        evidenceIds: [EVIDENCE_ID],
      },
    ],
    impactedDocumentIds: [DOCUMENT_ID],
    probes: [
      {
        question: "Is the proposed rule supported by the supplied evidence?",
        criticality: "CRITICAL" as const,
        evidenceIds: [EVIDENCE_ID],
      },
    ],
    warnings: [],
    summary: "Propose one review-required rule without publishing it.",
  };
}

describe("Knowledge Compiler contracts", () => {
  it("rejects unbounded/unknown root fields", () => {
    expect(() =>
      KnowledgeCompilerInput.parse({ ...compilerInput(), surprise: true }),
    ).toThrow();
  });

  it("fails closed when generated material cites unknown evidence", () => {
    const invalid = groundedResult();
    invalid.knowledgeCandidates[0]!.evidenceIds = [
      "77777777-7777-4777-8777-777777777777",
    ];
    expect(() =>
      normalizeKnowledgeCompilerResult(compilerInput(), invalid),
    ).toThrow(/UNKNOWN_EVIDENCE/);
  });

  it("rejects traversal in configured or generated knowledge paths", () => {
    expect(() =>
      deriveKnowledgePath({
        title: "Safe title",
        kind: "concept",
        schemaProfile: { compiledRoot: "../outside" },
      }),
    ).toThrow(/Unsafe knowledge path/);

    const invalid = groundedResult();
    invalid.proposedFileChanges[0]!.path = "../outside.md";
    expect(() =>
      normalizeKnowledgeCompilerResult(compilerInput(), invalid),
    ).toThrow(/Unsafe knowledge path/);
  });

  it("converts a grounded result into the existing review plan without publication", () => {
    const plan = resultToCompilationPlan(compilerInput(), groundedResult());
    expect(plan).toMatchObject({
      sourceId: SOURCE_ID,
      corpusRevision: "corpus-7",
      disposition: "NEW",
      impactedDocumentIds: [DOCUMENT_ID],
    });
    expect(plan.proposedChanges[0]?.evidenceIds).toEqual([EVIDENCE_ID]);
    expect(plan.probes[0]?.evidenceIds).toEqual([EVIDENCE_ID]);
  });

  it("executes a bounded OpenAI-compatible structured generation request", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: JSON.stringify(groundedResult()) } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const compiler = new OpenAICompatibleKnowledgeCompiler(
      {
        baseUrl: "https://compiler.example.test/v1",
        apiKey: "test-secret",
        model: "bounded-compiler",
        maxRetries: 0,
      },
      fetchMock,
    );

    const result = await compiler.compile(compilerInput());
    expect(result.knowledgeCandidates[0]?.candidateId).toBe("candidate-1");
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1];
    expect(String(init?.body)).toContain("allowDirectPublication");
    expect(String(init?.body)).not.toContain("test-secret");
  });
});
