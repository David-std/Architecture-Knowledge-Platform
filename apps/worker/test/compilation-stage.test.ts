import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Postgres } from "@akp/postgres";
import {
  deriveKnowledgePath,
  type ConfiguredKnowledgeCompiler,
  type KnowledgeCompilerRouteCandidate,
} from "@akp/compiler";
import { DocumentArtifact, ModelRolePolicy } from "@akp/contracts";
import {
  buildCompilationStage,
  modelProviderMetricAttributes,
} from "../src/compilation-stage.js";

const SPACE_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_ID = "33333333-3333-4333-8333-333333333333";
const ARTIFACT_ID = "44444444-4444-4444-8444-444444444444";
const EVIDENCE_ID = "55555555-5555-4555-8555-555555555555";
const SOURCE_HASH = "a".repeat(64);

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

function compilerCandidate(
  configured: ConfiguredKnowledgeCompiler,
  residency:
    "LOCAL_ONLY" | "ORG_APPROVED" | "EXTERNAL_ALLOWED" = "EXTERNAL_ALLOWED",
): KnowledgeCompilerRouteCandidate {
  return {
    policy: ModelRolePolicy.parse({
      role: "KNOWLEDGE_COMPILE",
      provider: "openai-compatible",
      model: configured.descriptor.model,
      endpointRef: configured.descriptor.endpointRef,
      timeoutMs: 30_000,
      maxRetries: 1,
      concurrency: 1,
      structuredOutputRequired: true,
      dataResidency: residency,
    }),
    descriptor: {
      ...configured.descriptor,
      policyDataResidency: residency,
      dataResidency: residency,
    },
    supportsStructuredOutput: true,
    createConfigured: () => ({
      ...configured,
      descriptor: {
        ...configured.descriptor,
        policyDataResidency: residency,
        dataResidency: residency,
      },
    }),
  };
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
  it("emits bounded provider telemetry dimensions without endpoint or source labels", () => {
    const candidate = compilerCandidate(
      {
        compiler: { compile: vi.fn() },
        descriptor: {
          role: "KNOWLEDGE_COMPILE",
          provider: "openai-compatible",
          model: "local-compiler",
          endpointRef: "private-endpoint-ref",
          policyDataResidency: "LOCAL_ONLY",
          dataResidency: "LOCAL_ONLY",
          configurationHash: "f".repeat(64),
        },
      },
      "LOCAL_ONLY",
    );

    const attributes = modelProviderMetricAttributes(
      candidate,
      "success",
      true,
    );

    expect(attributes).toEqual({
      role: "KNOWLEDGE_COMPILE",
      provider: "openai-compatible",
      model: "local-compiler",
      status: "success",
      fallback_used: "true",
    });
    expect(JSON.stringify(attributes)).not.toContain("private-endpoint-ref");
    expect(JSON.stringify(attributes)).not.toContain(SOURCE_ID);
    expect(JSON.stringify(attributes)).not.toContain(VAULT_ID);
  });

  it("keeps the provenance-preserving source-summary fallback explicit", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ schema_profile: {}, current_revision: "managed:7" }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            space_model_residency: "EXTERNAL_ALLOWED",
            source_model_residency: "EXTERNAL_ALLOWED",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const db = { pool: { query } } as unknown as Postgres;

    const output = await buildCompilationStage(db, stageInput(), null);

    expect(output.metadata).toMatchObject({
      mode: "SOURCE_SUMMARY_FALLBACK",
      reason: "GENERIC_COMPILER_DISABLED_OR_UNCONFIGURED",
      modelRoute: {
        requiredResidency: "EXTERNAL_ALLOWED",
        rejected: [],
      },
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

  it("never instantiates an external compiler for LOCAL_ONLY source data", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ schema_profile: {}, current_revision: "managed:8" }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            space_model_residency: "EXTERNAL_ALLOWED",
            source_model_residency: "LOCAL_ONLY",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const createConfigured = vi.fn(() => {
      throw new Error("external compiler must not be instantiated");
    });
    const candidate: KnowledgeCompilerRouteCandidate = {
      policy: ModelRolePolicy.parse({
        role: "KNOWLEDGE_COMPILE",
        provider: "openai-compatible",
        model: "external-compiler",
        endpointRef: "external",
        timeoutMs: 30_000,
        maxRetries: 1,
        concurrency: 1,
        structuredOutputRequired: true,
        dataResidency: "EXTERNAL_ALLOWED",
      }),
      descriptor: {
        role: "KNOWLEDGE_COMPILE",
        provider: "openai-compatible",
        model: "external-compiler",
        endpointRef: "external",
        policyDataResidency: "EXTERNAL_ALLOWED",
        dataResidency: "EXTERNAL_ALLOWED",
        configurationHash: "e".repeat(64),
      },
      supportsStructuredOutput: true,
      createConfigured,
    };
    const db = { pool: { query } } as unknown as Postgres;

    const output = await buildCompilationStage(db, stageInput(), [candidate]);

    expect(createConfigured).not.toHaveBeenCalled();
    expect(output.metadata).toMatchObject({
      mode: "SOURCE_SUMMARY_FALLBACK",
      reason: "MODEL_ROUTE_NO_COMPATIBLE_CANDIDATE",
      modelRoute: {
        requiredResidency: "LOCAL_ONLY",
        rejected: [
          {
            candidate: expect.objectContaining({ model: "external-compiler" }),
            reason: "RESIDENCY_INCOMPATIBLE",
          },
        ],
      },
    });
  });

  it("falls back only after a normalized provider failure when degradation is safe", async () => {
    const excerpt =
      "Invalidate cached material when the authoritative revision changes.";
    const excerptHash = createHash("sha256").update(excerpt).digest("hex");
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
            space_model_residency: "EXTERNAL_ALLOWED",
            source_model_residency: "EXTERNAL_ALLOWED",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: EVIDENCE_ID,
            locator,
            content_hash: excerptHash,
            excerpt,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ schema_profile: {}, current_revision: "managed:8" }],
      });
    const primaryCompile = vi.fn(async () => {
      throw new Error("COMPILER_PROVIDER_TIMEOUT");
    });
    const fallbackCompile = vi.fn(async () => ({
      identity: {
        classification: "DISTINCT" as const,
        candidates: [],
        reason: "Fallback produced a grounded rule.",
      },
      evidenceCandidates: [
        {
          sourceArtifactId: ARTIFACT_ID,
          locator,
          excerptHash,
        },
      ],
      knowledgeCandidates: [
        {
          candidateId: "candidate-fallback",
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
          candidateId: "candidate-fallback",
          path: deriveKnowledgePath({
            title:
              "Invalidate cached material when the authoritative revision changes.",
            kind: "rule",
          }),
          operation: "CREATE" as const,
          content:
            "---\nid: CACHE-FALLBACK\ntype: rule\nstatus: draft\n---\n\n# Cache invalidation\n\nInvalidate cached material when the authoritative revision changes.\n",
          reasons: ["Grounded fallback rule."],
          evidenceIds: [EVIDENCE_ID],
        },
      ],
      impactedDocumentIds: [],
      probes: [
        {
          question: "Is the fallback rule grounded?",
          criticality: "CRITICAL" as const,
          evidenceIds: [EVIDENCE_ID],
        },
      ],
      warnings: [],
      summary: "One grounded fallback rule for review.",
    }));
    const descriptor = (model: string, hash: string) => ({
      role: "KNOWLEDGE_COMPILE",
      provider: "openai-compatible" as const,
      model,
      endpointRef: model,
      policyDataResidency: "EXTERNAL_ALLOWED" as const,
      dataResidency: "EXTERNAL_ALLOWED" as const,
      configurationHash: hash.repeat(64),
    });
    const candidate = (
      model: string,
      hash: string,
      compile: typeof primaryCompile | typeof fallbackCompile,
      degradationSafe: boolean,
    ): KnowledgeCompilerRouteCandidate => {
      const configured = {
        compiler: { compile },
        descriptor: descriptor(model, hash),
      } satisfies ConfiguredKnowledgeCompiler;
      return {
        policy: ModelRolePolicy.parse({
          role:
            model === "primary"
              ? "KNOWLEDGE_COMPILE"
              : "KNOWLEDGE_COMPILE_FALLBACK",
          provider: "openai-compatible",
          model,
          endpointRef: model,
          timeoutMs: 30_000,
          maxRetries: 0,
          concurrency: 1,
          structuredOutputRequired: true,
          dataResidency: "EXTERNAL_ALLOWED",
          degradationSafe,
        }),
        descriptor: configured.descriptor,
        supportsStructuredOutput: true,
        createConfigured: () => configured,
      };
    };
    const db = { pool: { query } } as unknown as Postgres;

    const output = await buildCompilationStage(db, stageInput(), [
      candidate("primary", "1", primaryCompile, true),
      candidate("fallback", "2", fallbackCompile, false),
    ]);

    expect(primaryCompile).toHaveBeenCalledOnce();
    expect(fallbackCompile).toHaveBeenCalledOnce();
    expect(output.metadata).toMatchObject({
      mode: "GENERATIVE",
      provider: { model: "fallback" },
      modelRoute: {
        selected: { model: "fallback" },
        degraded: true,
        attempts: [
          {
            candidate: { model: "primary" },
            outcome: "FAILED",
            errorCode: "COMPILER_PROVIDER_TIMEOUT",
          },
          {
            candidate: { model: "fallback" },
            outcome: "SUCCEEDED",
          },
        ],
      },
    });
  });

  it("grounds generative compilation in evidence reloaded from the same vault", async () => {
    const excerpt =
      "Invalidate cached material when the authoritative revision changes.";
    const excerptHash = createHash("sha256").update(excerpt).digest("hex");
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
            space_model_residency: "EXTERNAL_ALLOWED",
            source_model_residency: "EXTERNAL_ALLOWED",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: EVIDENCE_ID,
            locator,
            content_hash: excerptHash,
            excerpt,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ schema_profile: {}, current_revision: "managed:8" }],
      });
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
          excerptHash,
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
          candidateId: "candidate-1",
          path: deriveKnowledgePath({
            title:
              "Invalidate cached material when the authoritative revision changes.",
            kind: "rule",
          }),
          operation: "CREATE" as const,
          content:
            "---\nid: CACHE-1\ntype: rule\nstatus: draft\n---\n\n# Cache invalidation\n\nInvalidate cached material when the authoritative revision changes.\n",
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
        role: "KNOWLEDGE_COMPILE",
        provider: "openai-compatible" as const,
        model: "fixture-compiler",
        endpointRef: "fixture",
        policyDataResidency: "EXTERNAL_ALLOWED" as const,
        dataResidency: "EXTERNAL_ALLOWED" as const,
        configurationHash: "f".repeat(64),
      },
    } satisfies ConfiguredKnowledgeCompiler;
    const db = { pool: { query } } as unknown as Postgres;

    const output = await buildCompilationStage(db, stageInput(), [
      compilerCandidate(configured),
    ]);

    expect(output.metadata).toMatchObject({
      mode: "GENERATIVE",
      provider: configured.descriptor,
      retrievalChannels: ["exact", "lexical"],
      retrievalWarnings: ["COMPILER_SEMANTIC_RETRIEVAL_DISABLED"],
      knowledgeCandidateCount: 1,
      contradictionCount: 0,
      compilerResult: expect.objectContaining({
        identity: expect.objectContaining({ classification: "DISTINCT" }),
        knowledgeCandidates: [
          expect.objectContaining({ candidateId: "candidate-1" }),
        ],
      }),
    });
    expect(output.plan.proposedChanges[0]?.evidenceIds).toEqual([EVIDENCE_ID]);
    expect(output.plan.reviewContext).toMatchObject({
      identity: {
        classification: "DISTINCT",
      },
      evidence: [
        {
          id: EVIDENCE_ID,
          sourceArtifactId: ARTIFACT_ID,
          excerptHash,
        },
      ],
      knowledgeCandidates: [
        {
          candidateId: "candidate-1",
          proposedAction: "CREATE",
          evidenceIds: [EVIDENCE_ID],
        },
      ],
    });
    expect(output.plan.reviewContext?.evidence[0]).not.toHaveProperty(
      "excerpt",
    );
    expect(compile).toHaveBeenCalledOnce();
    expect(compile.mock.calls[0]?.[0]).toMatchObject({
      spaceId: SPACE_ID,
      vaultId: VAULT_ID,
      evidence: [
        {
          id: EVIDENCE_ID,
          sourceArtifactId: ARTIFACT_ID,
          excerptHash,
        },
      ],
    });
    expect(query.mock.calls[2]?.[1]).toEqual([
      EVIDENCE_ID,
      SPACE_ID,
      VAULT_ID,
      SOURCE_ID,
      ARTIFACT_ID,
    ]);
  });
});
