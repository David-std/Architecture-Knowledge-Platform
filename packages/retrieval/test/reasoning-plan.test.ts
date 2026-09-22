import { describe, expect, it } from "vitest";
import {
  ReasoningOperator,
  ReasoningPlan,
  type ContextRevisionSet,
} from "@akp/contracts";
import {
  REASONING_OPERATOR_CONTRACTS,
  reasoningOperatorContract,
  validateReasoningPlan,
} from "../src/reasoning-plan.js";

const SPACE_ID = "00000000-0000-4000-8000-000000000001";
const VAULT_ID = "00000000-0000-4000-8000-000000000002";
const PROJECT_ID = "00000000-0000-4000-8000-000000000003";

function revisions(
  overrides: Partial<ContextRevisionSet> = {},
): ContextRevisionSet {
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
    ...overrides,
  };
}

function validPlan() {
  return {
    schemaVersion: 1 as const,
    query: "What is the impact of changing retry policy?",
    intent: "IMPACT_ANALYSIS" as const,
    revisionSet: revisions(),
    steps: [
      {
        id: "resolve",
        dependsOn: [],
        operator: "RESOLVE_ENTITY" as const,
        args: { query: "retry policy", limit: 10, entityKinds: ["policy"] },
      },
      {
        id: "traverse",
        dependsOn: ["resolve"],
        operator: "TRAVERSE_TYPED" as const,
        args: {
          seedStepId: "resolve",
          relationTypes: ["requires"],
          direction: "both" as const,
          maxHops: 2,
          limit: 100,
        },
      },
      {
        id: "evidence",
        dependsOn: ["traverse"],
        operator: "JOIN_EVIDENCE" as const,
        args: { inputStepId: "traverse", minimumSupport: 1 },
      },
      {
        id: "verify",
        dependsOn: ["evidence"],
        operator: "VERIFY_SUPPORT" as const,
        args: {
          inputStepId: "evidence",
          minimumTrust: "MACHINE_SUPPORTED" as const,
          requireCitation: true,
        },
      },
      {
        id: "context",
        dependsOn: ["verify"],
        operator: "BUILD_CONTEXT" as const,
        args: {
          inputStepIds: ["verify"],
          contextLevel: "L2" as const,
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

function context(overrides: Record<string, unknown> = {}) {
  return {
    currentRevisionSet: revisions(),
    policy: {
      authorizedSpaceId: SPACE_ID,
      authorizedVaultIds: [VAULT_ID],
      authorizedProjectIds: [PROJECT_ID],
      rawAllowed: false,
      maxSteps: 16,
      maxWallMs: 60_000,
      maxTokens: 16_000,
      maxCost: 5,
      maxFanout: 4,
      maxGraphHops: 3,
      allowExternalPeers: false,
      allowedExternalPeerIds: [],
      allowedModelRoles: ["REASONING_PLAN"],
      allowedModelProviders: ["local-model"],
      allowedDataResidencies: ["local"],
      allowedResidenciesByModelRole: {
        REASONING_PLAN: ["local"],
      },
      pathAuthorizer: (_vaultId: string, prefix: string) =>
        prefix.startsWith("allowed/"),
      ...overrides,
    },
  };
}

describe("safe reasoning plan schema and validation", () => {
  it("defines an exhaustive bounded contract for every reasoning operator", () => {
    expect(Object.keys(REASONING_OPERATOR_CONTRACTS).sort()).toEqual(
      [...ReasoningOperator.options].sort(),
    );
    for (const operator of ReasoningOperator.options) {
      const contract = reasoningOperatorContract(operator);
      expect(contract.inputSchema).toEqual({
        schemaVersion: 1,
        operator,
      });
      expect(contract.outputReferenceSchema).toBe("STRING_ARRAY");
      expect(contract.estimatedCost).toBeGreaterThan(0);
      expect(contract.timeoutMs).toBeGreaterThan(0);
      expect(contract.timeoutMs).toBeLessThanOrEqual(30_000);
      expect(contract.maxResults).toBeGreaterThan(0);
    }
    expect(reasoningOperatorContract("LOAD_RAW")).toMatchObject({
      requiredCapability: "RAW_READ",
      allowedSourceDomains: ["AUTHORIZED_SOURCE_ARTIFACT"],
      maxResults: 100,
    });
    expect(
      reasoningOperatorContract("SEARCH_CODE").allowedGraphDomains,
    ).toEqual(["CODE", "EPISTEMIC"]);
  });

  it("rejects a plan whose static operator estimate already exceeds maxCost", () => {
    const plan = validPlan();
    const estimated = plan.steps.reduce(
      (sum, step) =>
        sum + reasoningOperatorContract(step.operator).estimatedCost,
      0,
    );
    plan.budget.maxCost = Math.max(0, estimated - 0.01);

    const result = validateReasoningPlan(plan, context());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((entry) => entry.code)).toContain(
        "REASONING_PLAN_ESTIMATED_COST_EXCEEDED",
      );
    }
  });

  it("accepts a typed impact plan bound to the current revision set", () => {
    const result = validateReasoningPlan(validPlan(), context());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.steps.map((step) => step.operator)).toEqual([
        "RESOLVE_ENTITY",
        "TRAVERSE_TYPED",
        "JOIN_EVIDENCE",
        "VERIFY_SUPPORT",
        "BUILD_CONTEXT",
      ]);
    }
  });

  it("treats SQL-like text as search data but has no arbitrary query operator", () => {
    const searchPlan = validPlan();
    searchPlan.steps = [
      {
        id: "search",
        dependsOn: [],
        operator: "SEARCH_LEXICAL",
        args: {
          query: "SELECT * FROM users; MATCH (n) DETACH DELETE n; rm -rf /",
          limit: 10,
        },
      },
    ] as typeof searchPlan.steps;
    searchPlan.budget.maxSteps = 1;
    expect(validateReasoningPlan(searchPlan, context()).ok).toBe(true);

    const executeQuery = {
      ...validPlan(),
      steps: [
        {
          id: "danger",
          operator: "EXECUTE_QUERY",
          dependsOn: [],
          args: { sql: "drop table knowledge_documents" },
        },
      ],
    };
    expect(ReasoningPlan.safeParse(executeQuery).success).toBe(false);

    const executableField = {
      ...validPlan(),
      steps: [
        {
          id: "search",
          operator: "SEARCH_LEXICAL",
          dependsOn: [],
          args: {
            query: "safe search",
            limit: 10,
            sql: "delete from knowledge_documents",
          },
        },
      ],
    };
    expect(ReasoningPlan.safeParse(executableField).success).toBe(false);
  });

  it("rejects forward references, undeclared dependencies and incompatible operator I/O", () => {
    const forward = validPlan();
    forward.steps = [
      {
        id: "traverse",
        dependsOn: ["resolve"],
        operator: "TRAVERSE_TYPED",
        args: {
          seedStepId: "resolve",
          relationTypes: [],
          direction: "both",
          maxHops: 1,
          limit: 10,
        },
      },
      {
        id: "resolve",
        dependsOn: [],
        operator: "RESOLVE_ENTITY",
        args: { query: "x", limit: 10, entityKinds: [] },
      },
    ] as typeof forward.steps;
    const forwardResult = validateReasoningPlan(forward, context());
    expect(forwardResult.ok).toBe(false);
    if (!forwardResult.ok) {
      expect(forwardResult.issues.map((entry) => entry.code)).toContain(
        "REASONING_PLAN_FORWARD_OR_UNKNOWN_REFERENCE",
      );
    }

    const undeclared = validPlan();
    undeclared.steps[1] = {
      ...undeclared.steps[1]!,
      dependsOn: [],
    };
    const undeclaredResult = validateReasoningPlan(undeclared, context());
    expect(undeclaredResult.ok).toBe(false);
    if (!undeclaredResult.ok) {
      expect(undeclaredResult.issues.map((entry) => entry.code)).toContain(
        "REASONING_PLAN_DEPENDENCY_NOT_DECLARED",
      );
    }

    const ioMismatch = validPlan();
    ioMismatch.steps = [
      {
        id: "search",
        dependsOn: [],
        operator: "SEARCH_LEXICAL",
        args: { query: "latency", limit: 10 },
      },
      {
        id: "aggregate",
        dependsOn: ["search"],
        operator: "AGGREGATE",
        args: {
          inputStepId: "search",
          operation: "COUNT",
        },
      },
      {
        id: "traverse",
        dependsOn: ["aggregate"],
        operator: "TRAVERSE_TYPED",
        args: {
          seedStepId: "aggregate",
          relationTypes: [],
          direction: "both",
          maxHops: 1,
          limit: 10,
        },
      },
    ] as typeof ioMismatch.steps;
    const ioResult = validateReasoningPlan(ioMismatch, context());
    expect(ioResult.ok).toBe(false);
    if (!ioResult.ok) {
      expect(ioResult.issues.map((entry) => entry.code)).toContain(
        "REASONING_PLAN_IO_MISMATCH",
      );
    }
  });

  it("enforces step, wall, token, cost, graph-hop and fanout budgets", () => {
    const plan = validPlan();
    plan.budget = {
      maxSteps: 99,
      maxWallMs: 90_000,
      maxTokens: 99_000,
      maxCost: 99,
    };
    plan.steps[1] = {
      ...plan.steps[1]!,
      args: {
        ...(
          plan.steps[1] as Extract<
            (typeof plan.steps)[number],
            { operator: "TRAVERSE_TYPED" }
          >
        ).args,
        maxHops: 7,
      },
    } as (typeof plan.steps)[number];
    const result = validateReasoningPlan(plan, context({ maxFanout: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.issues.map((entry) => entry.code);
      expect(codes).toContain("REASONING_PLAN_STEP_BUDGET_EXCEEDED");
      expect(codes).toContain("REASONING_PLAN_WALL_BUDGET_EXCEEDED");
      expect(codes).toContain("REASONING_PLAN_TOKEN_BUDGET_EXCEEDED");
      expect(codes).toContain("REASONING_PLAN_COST_BUDGET_EXCEEDED");
      expect(codes).toContain("REASONING_PLAN_GRAPH_HOPS_EXCEEDED");
    }
  });

  it("counts declared dependency branches toward the fanout budget", () => {
    const plan = validPlan();
    plan.steps = [
      {
        id: "seed",
        dependsOn: [],
        operator: "SEARCH_LEXICAL",
        args: { query: "seed", limit: 10 },
      },
      {
        id: "branch-a",
        dependsOn: ["seed"],
        operator: "SEARCH_LEXICAL",
        args: { query: "branch a", limit: 10 },
      },
      {
        id: "branch-b",
        dependsOn: ["seed"],
        operator: "SEARCH_LEXICAL",
        args: { query: "branch b", limit: 10 },
      },
    ] as typeof plan.steps;
    plan.budget.maxSteps = 3;

    const result = validateReasoningPlan(plan, context({ maxFanout: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((entry) => entry.code)).toContain(
        "REASONING_PLAN_BRANCH_FANOUT_EXCEEDED",
      );
    }
  });

  it("rejects arbitrary LOAD_RAW resource locators while accepting source IDs", () => {
    const safe = validPlan();
    safe.steps = [
      {
        id: "raw",
        dependsOn: [],
        operator: "LOAD_RAW",
        args: {
          sourceIds: ["00000000-0000-4000-8000-000000000004"],
          maxBytes: 1_000,
        },
      },
    ] as typeof safe.steps;
    expect(ReasoningPlan.safeParse(safe).success).toBe(true);

    const attacks: Array<Record<string, unknown>> = [
      { sourceIds: ["../../etc/passwd"], maxBytes: 1_000 },
      { sourceIds: [], maxBytes: 1_000, path: "../../etc/passwd" },
      { sourceIds: [], maxBytes: 1_000, url: "file:///etc/passwd" },
      {
        sourceIds: [],
        maxBytes: 1_000,
        url: "http://169.254.169.254/latest/meta-data/",
      },
    ];
    for (const args of attacks) {
      const attacked = validPlan();
      attacked.steps = [
        {
          id: "raw",
          dependsOn: [],
          operator: "LOAD_RAW",
          args,
        },
      ] as typeof attacked.steps;
      expect(ReasoningPlan.safeParse(attacked).success).toBe(false);
    }
  });

  it("rejects unauthorized vaults, stale revisions and path/project/raw access", () => {
    const stale = validPlan();
    stale.revisionSet = revisions({
      vaults: [
        {
          ...revisions().vaults[0]!,
          corpusRevision: "corpus-old",
        },
      ],
    });
    const staleResult = validateReasoningPlan(stale, context());
    expect(staleResult.ok).toBe(false);
    if (!staleResult.ok) {
      expect(staleResult.issues.map((entry) => entry.code)).toContain(
        "REASONING_PLAN_REVISION_MISMATCH",
      );
    }

    const scoped = validPlan();
    scoped.steps = [
      {
        id: "search",
        dependsOn: [],
        operator: "SEARCH_CODE",
        args: {
          query: "RetryService",
          projectId: "00000000-0000-4000-8000-000000000099",
          limit: 10,
        },
      },
      {
        id: "filter",
        dependsOn: ["search"],
        operator: "FILTER_SCOPE",
        args: {
          inputStepId: "search",
          vaultIds: [VAULT_ID],
          pathPrefixes: ["secret/"],
        },
      },
      {
        id: "raw",
        dependsOn: ["filter"],
        operator: "LOAD_RAW",
        args: {
          inputStepId: "filter",
          sourceIds: [],
          maxBytes: 1_000,
        },
      },
    ] as typeof scoped.steps;
    const scopedResult = validateReasoningPlan(scoped, context());
    expect(scopedResult.ok).toBe(false);
    if (!scopedResult.ok) {
      const codes = scopedResult.issues.map((entry) => entry.code);
      expect(codes).toContain("REASONING_PLAN_PROJECT_DENIED");
      expect(codes).toContain("REASONING_PLAN_PATH_SCOPE_DENIED");
      expect(codes).toContain("REASONING_PLAN_RAW_DENIED");
    }
  });

  it("enforces peer, model-role, provider and residency policy", () => {
    const plan = validPlan();
    plan.steps[0] = {
      ...plan.steps[0]!,
      executionTarget: { kind: "EXTERNAL_PEER", peerId: "peer-unapproved" },
      processing: {
        modelRole: "REASONING_PLAN",
        modelProvider: "remote-unapproved",
        dataResidency: "outside-policy",
      },
    } as (typeof plan.steps)[number];
    const result = validateReasoningPlan(plan, context());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.issues.map((entry) => entry.code);
      expect(codes).toContain("REASONING_PLAN_EXTERNAL_PEER_DENIED");
      expect(codes).toContain("REASONING_PLAN_MODEL_PROVIDER_DENIED");
      expect(codes).toContain("REASONING_PLAN_DATA_RESIDENCY_DENIED");
      expect(codes).toContain("REASONING_PLAN_MODEL_ROLE_RESIDENCY_DENIED");
    }
  });
});
