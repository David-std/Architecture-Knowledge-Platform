import { describe, expect, it } from "vitest";
import type { ContextRevisionSet, QueryIntent } from "@akp/contracts";
import { buildDeterministicReasoningPlan } from "../src/reasoning-planner.js";
import { validateReasoningPlan } from "../src/reasoning-plan.js";

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

function context() {
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

function operators(intent: QueryIntent, capabilities = {}) {
  const plan = buildDeterministicReasoningPlan({
    query: `fixture query for ${intent}`,
    intent,
    revisionSet: revisions(),
    projectId: PROJECT_ID,
    capabilities,
  });
  const validated = validateReasoningPlan(plan, context());
  expect(validated.ok).toBe(true);
  return plan.steps.map((step) => step.operator);
}

describe("deterministic reasoning planner", () => {
  it("produces validator-clean plans for every P7 exit scenario", () => {
    expect(operators("CONCEPTUAL")).toEqual([
      "SEARCH_LEXICAL",
      "VERIFY_SUPPORT",
      "BUILD_CONTEXT",
    ]);

    expect(
      operators("COMPARISON", {
        vectorAvailable: true,
      }),
    ).toEqual(["SEARCH_LEXICAL", "SEARCH_VECTOR", "COMPARE", "BUILD_CONTEXT"]);

    expect(
      operators("IMPACT_ANALYSIS", {
        graphConsistent: true,
      }),
    ).toEqual([
      "RESOLVE_ENTITY",
      "TRAVERSE_TYPED",
      "VERIFY_SUPPORT",
      "BUILD_CONTEXT",
    ]);

    expect(
      operators("SOURCE_VERIFICATION", {
        rawAllowed: true,
      }),
    ).toEqual([
      "SEARCH_LEXICAL",
      "VERIFY_SUPPORT",
      "LOAD_RAW",
      "BUILD_CONTEXT",
    ]);

    expect(
      operators("PROJECT_CODE", {
        codeAdapterAvailable: true,
      }),
    ).toEqual(["SEARCH_CODE", "VERIFY_SUPPORT", "BUILD_CONTEXT"]);
  });

  it("fails capabilities closed inside the plan shape", () => {
    expect(operators("IMPACT_ANALYSIS")).toEqual([
      "SEARCH_LEXICAL",
      "VERIFY_SUPPORT",
      "BUILD_CONTEXT",
    ]);
    expect(operators("SOURCE_VERIFICATION")).toEqual([
      "SEARCH_LEXICAL",
      "VERIFY_SUPPORT",
      "BUILD_CONTEXT",
    ]);
    expect(operators("PROJECT_CODE")).toEqual([
      "SEARCH_LEXICAL",
      "VERIFY_SUPPORT",
      "BUILD_CONTEXT",
    ]);
    expect(operators("COMPARISON")).toEqual([
      "SEARCH_LEXICAL",
      "EXACT_LOOKUP",
      "COMPARE",
      "BUILD_CONTEXT",
    ]);
  });

  it("keeps budgets bounded and revision-bound to the caller snapshot", () => {
    const plan = buildDeterministicReasoningPlan({
      query: "compare retry approaches",
      intent: "COMPARISON",
      revisionSet: revisions(),
      capabilities: { vectorAvailable: true },
      contextLevel: "L3",
      contextMaxTokens: 12_000,
    });

    expect(plan.revisionSet).toEqual(revisions());
    expect(plan.budget).toMatchObject({
      maxSteps: 6,
      maxWallMs: 30_000,
      maxTokens: 24_000,
      maxCost: 2,
    });
    expect(plan.steps.at(-1)).toMatchObject({
      operator: "BUILD_CONTEXT",
      args: {
        contextLevel: "L3",
        maxTokens: 12_000,
      },
    });
  });
});
