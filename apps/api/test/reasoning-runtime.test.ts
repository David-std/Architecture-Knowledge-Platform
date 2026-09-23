import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ContextRevisionSet,
  QueryIntent,
  SearchHit,
  SearchRequest,
} from "@akp/contracts";
import {
  executeApplicationReasoning,
  type ReasoningRetrievalInvocation,
} from "../src/reasoning-runtime.js";

const SPACE_ID = "00000000-0000-4000-8000-000000000001";
const VAULT_ID = "00000000-0000-4000-8000-000000000002";
const PROJECT_ID = "00000000-0000-4000-8000-000000000003";

function revisions(): ContextRevisionSet {
  return {
    spaceId: SPACE_ID,
    vaults: [
      {
        vaultId: VAULT_ID,
        corpusRevision: "corpus-1",
        lexicalRevision: "corpus-1",
        vectorRevision: "corpus-1",
        graphRevision: "corpus-1",
        contextPackRevision: "corpus-1",
        communityRevision: "community-1",
      },
    ],
    retrievalConfigurationVersion: "rrf-v1",
    capturedAt: "2026-09-19T00:00:00.000Z",
  };
}

function request(intent: QueryIntent): SearchRequest {
  return {
    query: `query for ${intent}`,
    intent,
    spaceId: SPACE_ID,
    vaultId: VAULT_ID,
    vaultIds: [],
    federated: false,
    projectId: PROJECT_ID,
    truthConsistency: "STRICT",
    types: [],
    minimumTrust: "MACHINE_SUPPORTED",
    mode: intent === "PROJECT_CODE" ? "PROJECT_CODE" : "SOURCE_BACKED",
    limit: 20,
  };
}

function hit(label: string, overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    documentId: randomUUID(),
    vaultId: VAULT_ID,
    document: {
      externalId: `DOC-${label.toUpperCase()}`,
      path: `allowed/${label}.md`,
      title: `Document ${label}`,
    },
    revision: "corpus-1",
    title: `Document ${label}`,
    type: "concept",
    trust: "HUMAN_REVIEWED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1,
    reasons: ["fixture"],
    excerpt: `Evidence for ${label}`,
    citations: [`source:${label}`],
    ...overrides,
  };
}

function validationContext() {
  return {
    currentRevisionSet: revisions(),
    policy: {
      authorizedSpaceId: SPACE_ID,
      authorizedVaultIds: [VAULT_ID],
      authorizedProjectIds: [PROJECT_ID],
      rawAllowed: true,
      maxSteps: 32,
      maxWallMs: 60_000,
      maxTokens: 64_000,
      maxCost: 10,
      maxFanout: 8,
      maxGraphHops: 3,
      allowExternalPeers: false,
      allowedExternalPeerIds: [],
      allowedModelProviders: ["local-model"],
      allowedDataResidencies: ["local"],
    },
  };
}

function capabilities(intent: QueryIntent) {
  return {
    vectorAvailable: intent === "COMPARISON",
    graphConsistent: intent === "IMPACT_ANALYSIS",
    communityAvailable: false,
    rawAllowed: intent === "SOURCE_VERIFICATION",
    codeAdapterAvailable: intent === "PROJECT_CODE",
    contextPackAvailable: true,
  };
}

describe("reasoning application runtime", () => {
  for (const intent of [
    "CONCEPTUAL",
    "COMPARISON",
    "IMPACT_ANALYSIS",
    "SOURCE_VERIFICATION",
    "PROJECT_CODE",
  ] as const) {
    it(`executes ${intent} through the plan engine and assembles final context`, async () => {
      const invocations: ReasoningRetrievalInvocation[] = [];
      const base = hit(intent.toLowerCase());
      const alternate = hit(`${intent.toLowerCase()}-alternate`);
      const raw = hit(`${intent.toLowerCase()}-raw`, {
        type: "source",
        excerpt: `Raw evidence for ${intent}`,
      });

      const result = await executeApplicationReasoning({
        request: request(intent),
        revisionSet: revisions(),
        validationContext: validationContext(),
        capabilities: capabilities(intent),
        corpusRevision: "corpus-1",
        indexRevisions: {
          corpus: "corpus-1",
          lexical: "corpus-1",
          vector: intent === "COMPARISON" ? "corpus-1" : null,
          graph: intent === "IMPACT_ANALYSIS" ? "corpus-1" : null,
          community: null,
        },
        retrieve: async (invocation) => {
          invocations.push(invocation);
          switch (invocation.kind) {
            case "SEARCH_VECTOR":
              return [alternate];
            case "TRAVERSE_TYPED":
              return [alternate];
            case "LOAD_RAW":
              return [raw];
            default:
              return [base];
          }
        },
      });

      expect(result.execution.status).toBe("SUCCESS");
      expect(result.reasoningTrace.status).toBe("SUCCESS");
      expect(result.reasoningTrace.steps.at(-1)).toMatchObject({
        operator: "BUILD_CONTEXT",
        status: "SUCCESS",
      });
      expect(result.hits.length).toBeGreaterThan(0);
      expect(
        JSON.stringify(result.reasoningTrace).includes("Raw evidence for"),
      ).toBe(false);

      const kinds = invocations.map((invocation) => invocation.kind);
      if (intent === "COMPARISON") {
        expect(kinds).toEqual(["SEARCH_LEXICAL", "SEARCH_VECTOR"]);
        expect(result.hits.map((item) => item.documentId)).toEqual(
          expect.arrayContaining([base.documentId, alternate.documentId]),
        );
      } else if (intent === "IMPACT_ANALYSIS") {
        expect(kinds).toEqual(["RESOLVE_ENTITY", "TRAVERSE_TYPED"]);
        expect(result.hits.map((item) => item.documentId)).toContain(
          alternate.documentId,
        );
      } else if (intent === "SOURCE_VERIFICATION") {
        expect(kinds).toEqual(["SEARCH_LEXICAL", "LOAD_RAW"]);
        expect(result.hits.map((item) => item.documentId)).toEqual(
          expect.arrayContaining([base.documentId, raw.documentId]),
        );
      } else if (intent === "PROJECT_CODE") {
        expect(kinds).toEqual(["SEARCH_CODE"]);
      } else {
        expect(kinds).toEqual(["SEARCH_LEXICAL"]);
      }
    });
  }

  it("treats SEARCH_CODE injection-shaped text strictly as search data", async () => {
    const injection = "x'); DROP TABLE facts; --";
    const invocations: ReasoningRetrievalInvocation[] = [];

    const result = await executeApplicationReasoning({
      request: { ...request("PROJECT_CODE"), query: injection },
      revisionSet: revisions(),
      validationContext: validationContext(),
      capabilities: capabilities("PROJECT_CODE"),
      corpusRevision: "corpus-1",
      indexRevisions: {
        corpus: "corpus-1",
        lexical: "corpus-1",
        codeGraph: "corpus-1",
      },
      retrieve: async (invocation) => {
        invocations.push(invocation);
        return [hit("code-injection")];
      },
    });

    expect(result.execution.status).toBe("SUCCESS");
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toEqual({
      kind: "SEARCH_CODE",
      query: injection,
      limit: 20,
    });
    expect(Object.keys(invocations[0] ?? {})).toEqual([
      "kind",
      "query",
      "limit",
    ]);
  });

  it("propagates revision drift as a hard halt instead of partial context", async () => {
    let guardChecks = 0;
    let retrievalCalls = 0;

    await expect(
      executeApplicationReasoning({
        request: request("CONCEPTUAL"),
        revisionSet: revisions(),
        validationContext: validationContext(),
        capabilities: capabilities("CONCEPTUAL"),
        corpusRevision: "corpus-1",
        indexRevisions: { corpus: "corpus-1" },
        revisionGuard: async () => {
          guardChecks += 1;
          return guardChecks < 3;
        },
        retrieve: async () => {
          retrievalCalls += 1;
          return [hit("revision-guard")];
        },
      }),
    ).rejects.toThrow("CONTEXT_REVISION_CHANGED");

    expect(retrievalCalls).toBe(1);
    expect(guardChecks).toBe(3);
  });

  it("filters unsupported hits before context assembly", async () => {
    const trusted = hit("trusted");
    const untrusted = hit("untrusted", {
      trust: "UNVERIFIED",
      citations: [],
    });
    const result = await executeApplicationReasoning({
      request: request("CONCEPTUAL"),
      revisionSet: revisions(),
      validationContext: validationContext(),
      capabilities: capabilities("CONCEPTUAL"),
      corpusRevision: "corpus-1",
      indexRevisions: { corpus: "corpus-1" },
      retrieve: async () => [trusted, untrusted],
    });

    expect(result.hits.map((item) => item.documentId)).toEqual([
      trusted.documentId,
    ]);
  });

  it("rejects failed or contextless partial executions so callers can fall back directly", async () => {
    await expect(
      executeApplicationReasoning({
        request: request("CONCEPTUAL"),
        revisionSet: revisions(),
        validationContext: validationContext(),
        capabilities: capabilities("CONCEPTUAL"),
        corpusRevision: "corpus-1",
        indexRevisions: { corpus: "corpus-1" },
        retrieve: async () => {
          throw new Error("CONTROLLED_RETRIEVAL_FAILURE");
        },
      }),
    ).rejects.toThrow("REASONING_PLAN_EXECUTION_FAILED");
  });
});
