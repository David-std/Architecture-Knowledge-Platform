import { describe, expect, it, vi } from "vitest";
import type { ContextRevisionSet, ReasoningPlan } from "@akp/contracts";
import {
  executeReasoningPlan,
  executeWithReasoningPlanner,
  type ReasoningExecutionTrace,
  type ReasoningExecutionValue,
  type ReasoningOperatorPorts,
} from "../src/reasoning-executor.js";

const SPACE_ID = "00000000-0000-4000-8000-000000000001";
const VAULT_ID = "00000000-0000-4000-8000-000000000002";

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

function validationContext() {
  return {
    currentRevisionSet: revisions(),
    policy: {
      authorizedSpaceId: SPACE_ID,
      authorizedVaultIds: [VAULT_ID],
      rawAllowed: false,
      maxSteps: 32,
      maxWallMs: 60_000,
      maxTokens: 32_000,
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

function impactPlan(): ReasoningPlan {
  return {
    schemaVersion: 1,
    query: "What breaks if RepositoryB changes?",
    intent: "IMPACT_ANALYSIS",
    revisionSet: revisions(),
    steps: [
      {
        id: "resolve",
        dependsOn: [],
        executionTarget: { kind: "LOCAL" },
        operator: "RESOLVE_ENTITY",
        args: {
          query: "RepositoryB",
          limit: 10,
          entityKinds: ["code-symbol"],
        },
      },
      {
        id: "traverse",
        dependsOn: ["resolve"],
        executionTarget: { kind: "LOCAL" },
        operator: "TRAVERSE_TYPED",
        args: {
          seedStepId: "resolve",
          relationTypes: ["requires"],
          direction: "incoming",
          maxHops: 2,
          limit: 50,
        },
      },
      {
        id: "verify",
        dependsOn: ["traverse"],
        executionTarget: { kind: "LOCAL" },
        operator: "VERIFY_SUPPORT",
        args: {
          inputStepId: "traverse",
          minimumTrust: "MACHINE_SUPPORTED",
          requireCitation: true,
        },
      },
      {
        id: "context",
        dependsOn: ["verify"],
        executionTarget: { kind: "LOCAL" },
        operator: "BUILD_CONTEXT",
        args: {
          inputStepIds: ["verify"],
          contextLevel: "L2",
          maxTokens: 4_000,
        },
      },
    ],
    budget: {
      maxSteps: 8,
      maxWallMs: 30_000,
      maxTokens: 8_000,
      maxCost: 1,
    },
  };
}

function documentValue(
  ref: string,
  payload: unknown = { documents: [ref] },
): ReasoningExecutionValue {
  return {
    kind: "DOCUMENT_SET",
    refs: [ref],
    payload,
    channel: "test",
    revision: "corpus-1",
    tokenUsage: 10,
    cost: 0,
  };
}

describe("reasoning executor", () => {
  it("delegates to typed ports, returns an inspectable trace, and never traces payload content", async () => {
    const persisted: ReasoningExecutionTrace[] = [];
    const ports: ReasoningOperatorPorts = {
      RESOLVE_ENTITY: async () =>
        documentValue("doc:repo-b", {
          secret: "TOP-SECRET-RAW-CONTENT",
        }),
      TRAVERSE_TYPED: async ({ inputs }) => {
        expect(inputs.get("resolve")?.refs).toEqual(["doc:repo-b"]);
        return documentValue("doc:dependent-a");
      },
      VERIFY_SUPPORT: async ({ inputs }) => {
        expect(inputs.get("traverse")?.refs).toEqual(["doc:dependent-a"]);
        return documentValue("doc:dependent-a");
      },
      BUILD_CONTEXT: async ({ inputs }) => ({
        kind: "CONTEXT_PACKET",
        refs: ["packet:1"],
        payload: {
          sections: [...(inputs.get("verify")?.refs ?? [])],
          secret: "CONTEXT-SECRET",
        },
        revision: "corpus-1",
        tokenUsage: 100,
        cost: 0,
      }),
    };

    const result = await executeReasoningPlan(
      impactPlan(),
      validationContext(),
      {
        ports,
        traceSink: {
          persist: async (trace) => {
            persisted.push(trace);
          },
        },
      },
    );

    expect(result.status).toBe("SUCCESS");
    if (result.status === "REJECTED") throw new Error("unexpected rejection");
    expect(result.results.get("context")?.refs).toEqual(["packet:1"]);
    expect(result.tracePersistence).toBe("PERSISTED");
    expect(persisted).toHaveLength(1);
    expect(result.trace.steps.map((step) => step.status)).toEqual([
      "SUCCESS",
      "SUCCESS",
      "SUCCESS",
      "SUCCESS",
    ]);
    expect(result.trace.budget).toMatchObject({
      attemptedSteps: 4,
      successfulSteps: 4,
      failedSteps: 0,
      skippedSteps: 0,
      tokens: 130,
    });
    const serializedTrace = JSON.stringify(result.trace);
    expect(serializedTrace).not.toContain("TOP-SECRET-RAW-CONTENT");
    expect(serializedTrace).not.toContain("CONTEXT-SECRET");
    expect(result.trace.steps[0]?.resultHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.trace.steps[1]?.inputHashes).toEqual([
      result.trace.steps[0]?.resultHash,
    ]);
  });

  it("continues independent work after a partial operator failure and skips only dependents", async () => {
    const plan: ReasoningPlan = {
      schemaVersion: 1,
      query: "Compare retry guidance",
      intent: "COMPARISON",
      revisionSet: revisions(),
      steps: [
        {
          id: "lexical",
          dependsOn: [],
          executionTarget: { kind: "LOCAL" },
          operator: "SEARCH_LEXICAL",
          args: { query: "retry", limit: 10 },
        },
        {
          id: "vector",
          dependsOn: [],
          executionTarget: { kind: "LOCAL" },
          operator: "SEARCH_VECTOR",
          args: { query: "retry", limit: 10 },
        },
        {
          id: "aggregate",
          dependsOn: ["lexical"],
          executionTarget: { kind: "LOCAL" },
          operator: "AGGREGATE",
          args: {
            inputStepId: "lexical",
            operation: "COUNT",
          },
        },
        {
          id: "compare",
          dependsOn: ["lexical", "vector"],
          executionTarget: { kind: "LOCAL" },
          operator: "COMPARE",
          args: {
            leftStepId: "lexical",
            rightStepId: "vector",
            fields: [],
          },
        },
      ],
      budget: {
        maxSteps: 4,
        maxWallMs: 10_000,
        maxTokens: 1_000,
        maxCost: 1,
      },
    };
    const compare = vi.fn();
    const result = await executeReasoningPlan(plan, validationContext(), {
      ports: {
        SEARCH_LEXICAL: async () => documentValue("doc:retry"),
        SEARCH_VECTOR: async () => {
          throw new Error("VECTOR_PROVIDER_DOWN");
        },
        AGGREGATE: async ({ inputs }) => ({
          kind: "AGGREGATE",
          refs: ["aggregate:count"],
          payload: { count: inputs.get("lexical")?.refs.length ?? 0 },
        }),
        COMPARE: compare,
      },
    });

    expect(result.status).toBe("PARTIAL");
    if (result.status === "REJECTED") throw new Error("unexpected rejection");
    expect(result.results.has("aggregate")).toBe(true);
    expect(result.results.has("vector")).toBe(false);
    expect(compare).not.toHaveBeenCalled();
    expect(
      result.trace.steps.find((step) => step.stepId === "vector"),
    ).toMatchObject({
      status: "FAILED",
      errorCode: "VECTOR_PROVIDER_DOWN",
    });
    expect(
      result.trace.steps.find((step) => step.stepId === "compare"),
    ).toMatchObject({
      status: "SKIPPED",
      errorCode: "REASONING_PLAN_DEPENDENCY_UNAVAILABLE",
    });
  });

  it("hard-stops when the revision fence changes between operators", async () => {
    const plan: ReasoningPlan = {
      schemaVersion: 1,
      query: "revision-sensitive lookup",
      intent: "CONCEPTUAL",
      revisionSet: revisions(),
      steps: [
        {
          id: "first",
          dependsOn: [],
          executionTarget: { kind: "LOCAL" },
          operator: "SEARCH_LEXICAL",
          args: { query: "first", limit: 5 },
        },
        {
          id: "second",
          dependsOn: [],
          executionTarget: { kind: "LOCAL" },
          operator: "SEARCH_LEXICAL",
          args: { query: "second", limit: 5 },
        },
      ],
      budget: {
        maxSteps: 2,
        maxWallMs: 10_000,
        maxTokens: 100,
        maxCost: 1,
      },
    };
    let guardChecks = 0;
    const first = vi.fn(async () => documentValue("doc:first"));
    const second = vi.fn(async () => documentValue("doc:second"));

    await expect(
      executeReasoningPlan(plan, validationContext(), {
        ports: {
          SEARCH_LEXICAL: async ({ step }) =>
            step.id === "first" ? first() : second(),
        },
        revisionGuard: async () => {
          guardChecks += 1;
          return guardChecks < 3;
        },
      }),
    ).rejects.toThrow("CONTEXT_REVISION_CHANGED");

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(guardChecks).toBe(3);
  });

  it("rethrows operator revision drift instead of degrading to partial", async () => {
    const plan: ReasoningPlan = {
      schemaVersion: 1,
      query: "operator revision drift",
      intent: "CONCEPTUAL",
      revisionSet: revisions(),
      steps: [
        {
          id: "drift",
          dependsOn: [],
          executionTarget: { kind: "LOCAL" },
          operator: "SEARCH_LEXICAL",
          args: { query: "drift", limit: 5 },
        },
        {
          id: "later",
          dependsOn: [],
          executionTarget: { kind: "LOCAL" },
          operator: "SEARCH_LEXICAL",
          args: { query: "later", limit: 5 },
        },
      ],
      budget: {
        maxSteps: 2,
        maxWallMs: 10_000,
        maxTokens: 100,
        maxCost: 1,
      },
    };
    const later = vi.fn(async () => documentValue("doc:later"));

    await expect(
      executeReasoningPlan(plan, validationContext(), {
        ports: {
          SEARCH_LEXICAL: async ({ step }) => {
            if (step.id === "later") return later();
            throw new Error("CONTEXT_REVISION_CHANGED");
          },
        },
      }),
    ).rejects.toThrow("CONTEXT_REVISION_CHANGED");

    expect(later).not.toHaveBeenCalled();
  });

  it("halts later steps when actual token usage exceeds the validated runtime budget", async () => {
    const plan: ReasoningPlan = {
      schemaVersion: 1,
      query: "Find two things",
      intent: "CONCEPTUAL",
      revisionSet: revisions(),
      steps: [
        {
          id: "first",
          dependsOn: [],
          executionTarget: { kind: "LOCAL" },
          operator: "SEARCH_LEXICAL",
          args: { query: "first", limit: 5 },
        },
        {
          id: "second",
          dependsOn: [],
          executionTarget: { kind: "LOCAL" },
          operator: "SEARCH_LEXICAL",
          args: { query: "second", limit: 5 },
        },
      ],
      budget: {
        maxSteps: 2,
        maxWallMs: 10_000,
        maxTokens: 4,
        maxCost: 1,
      },
    };

    const second = vi.fn();
    const result = await executeReasoningPlan(plan, validationContext(), {
      ports: {
        SEARCH_LEXICAL: async ({ step }) => {
          if (step.id === "second") return second();
          return { ...documentValue("doc:first"), tokenUsage: 5 };
        },
      },
    });

    expect(result.status).toBe("FAILED");
    if (result.status === "REJECTED") throw new Error("unexpected rejection");
    expect(second).not.toHaveBeenCalled();
    expect(result.trace.steps).toEqual([
      expect.objectContaining({
        stepId: "first",
        status: "FAILED",
        errorCode: "REASONING_PLAN_TOKEN_BUDGET_EXCEEDED",
      }),
      expect.objectContaining({
        stepId: "second",
        status: "SKIPPED",
        errorCode: "REASONING_PLAN_BUDGET_HALTED",
      }),
    ]);
  });

  it("aborts a timed-out operator and does not start later steps", async () => {
    const plan: ReasoningPlan = {
      schemaVersion: 1,
      query: "slow lookup",
      intent: "CONCEPTUAL",
      revisionSet: revisions(),
      steps: [
        {
          id: "slow",
          dependsOn: [],
          executionTarget: { kind: "LOCAL" },
          operator: "SEARCH_LEXICAL",
          args: { query: "slow", limit: 5 },
        },
        {
          id: "later",
          dependsOn: [],
          executionTarget: { kind: "LOCAL" },
          operator: "SEARCH_LEXICAL",
          args: { query: "later", limit: 5 },
        },
      ],
      budget: {
        maxSteps: 2,
        maxWallMs: 15,
        maxTokens: 100,
        maxCost: 1,
      },
    };
    const later = vi.fn();
    const result = await executeReasoningPlan(plan, validationContext(), {
      ports: {
        SEARCH_LEXICAL: async ({ step, signal }) => {
          if (step.id === "later") return later();
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new Error("PORT_OBSERVED_ABORT");
        },
      },
    });

    expect(result.status).toBe("FAILED");
    if (result.status === "REJECTED") throw new Error("unexpected rejection");
    expect(later).not.toHaveBeenCalled();
    expect(result.trace.steps[0]).toMatchObject({
      stepId: "slow",
      status: "FAILED",
      errorCode: "REASONING_PLAN_WALL_BUDGET_EXCEEDED",
    });
  });

  it("never executes an external-peer step through local operator ports", async () => {
    const plan: ReasoningPlan = {
      schemaVersion: 1,
      query: "remote lookup",
      intent: "CONCEPTUAL",
      revisionSet: revisions(),
      steps: [
        {
          id: "remote",
          dependsOn: [],
          executionTarget: { kind: "EXTERNAL_PEER", peerId: "peer-1" },
          operator: "SEARCH_LEXICAL",
          args: { query: "remote", limit: 5 },
        },
      ],
      budget: {
        maxSteps: 1,
        maxWallMs: 10_000,
        maxTokens: 100,
        maxCost: 1,
      },
    };
    const permittedContext = {
      ...validationContext(),
      policy: {
        ...validationContext().policy,
        allowExternalPeers: true,
        allowedExternalPeerIds: ["peer-1"],
      },
    };
    const local = vi.fn(async () => documentValue("doc:local"));
    const remote = vi.fn(async () => documentValue("doc:remote"));

    const unavailable = await executeReasoningPlan(plan, permittedContext, {
      ports: { SEARCH_LEXICAL: local },
    });
    expect(unavailable.status).toBe("FAILED");
    if (unavailable.status === "REJECTED") {
      throw new Error("unexpected rejection");
    }
    expect(local).not.toHaveBeenCalled();
    expect(unavailable.trace.steps[0]).toMatchObject({
      status: "FAILED",
      errorCode: "REASONING_EXTERNAL_PEER_EXECUTOR_UNAVAILABLE",
    });

    const routed = await executeReasoningPlan(plan, permittedContext, {
      ports: { SEARCH_LEXICAL: local },
      externalPeerPorts: (peerId) => {
        expect(peerId).toBe("peer-1");
        return { SEARCH_LEXICAL: remote };
      },
    });
    expect(routed.status).toBe("SUCCESS");
    expect(local).not.toHaveBeenCalled();
    expect(remote).toHaveBeenCalledTimes(1);
  });

  it("falls back deterministically when the planner is unavailable or proposes an invalid plan", async () => {
    const fallback = vi.fn(async (reason: string) => ({
      source: "direct-retrieval",
      reason,
    }));

    const unavailable = await executeWithReasoningPlanner({
      fallback,
      validationContext: validationContext(),
      executor: { ports: {} },
    });
    expect(unavailable).toEqual({
      mode: "DIRECT_FALLBACK",
      reason: "PLANNER_UNAVAILABLE",
      result: {
        source: "direct-retrieval",
        reason: "PLANNER_UNAVAILABLE",
      },
    });

    const invalid = await executeWithReasoningPlanner({
      planner: {
        propose: async () => ({
          ...impactPlan(),
          steps: [
            {
              id: "escape",
              operator: "EXECUTE_QUERY",
              dependsOn: [],
              args: { sql: "drop table knowledge_documents" },
            },
          ],
        }),
      },
      fallback,
      validationContext: validationContext(),
      executor: { ports: {} },
    });
    expect(invalid).toEqual({
      mode: "DIRECT_FALLBACK",
      reason: "PLAN_INVALID",
      result: {
        source: "direct-retrieval",
        reason: "PLAN_INVALID",
      },
    });
  });
});
