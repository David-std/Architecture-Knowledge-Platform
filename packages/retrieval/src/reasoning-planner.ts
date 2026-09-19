import type {
  ContextDisclosureLevel,
  ContextRevisionSet,
  QueryIntent,
  ReasoningPlan,
  ReasoningStep,
} from "@akp/contracts";
import type { QueryPlannerCapabilities } from "./query-planner.js";

export interface DeterministicReasoningPlannerInput {
  query: string;
  intent: QueryIntent;
  revisionSet: ContextRevisionSet;
  capabilities?: Partial<QueryPlannerCapabilities>;
  projectId?: string;
  contextLevel?: ContextDisclosureLevel;
  contextMaxTokens?: number;
}

const local = { kind: "LOCAL" as const };

function boundedContextTokens(value: number | undefined): number {
  return Math.min(32_000, Math.max(256, value ?? 4_000));
}

function verifyStep(inputStepId: string): ReasoningStep {
  return {
    id: "verify",
    dependsOn: [inputStepId],
    executionTarget: local,
    operator: "VERIFY_SUPPORT",
    args: {
      inputStepId,
      minimumTrust: "MACHINE_SUPPORTED",
      requireCitation: true,
    },
  };
}

function contextStep(
  inputStepIds: string[],
  level: ContextDisclosureLevel,
  maxTokens: number,
): ReasoningStep {
  return {
    id: "context",
    dependsOn: inputStepIds,
    executionTarget: local,
    operator: "BUILD_CONTEXT",
    args: {
      inputStepIds,
      contextLevel: level,
      maxTokens,
    },
  };
}

function lexicalSearch(query: string, id = "search"): ReasoningStep {
  return {
    id,
    dependsOn: [],
    executionTarget: local,
    operator: "SEARCH_LEXICAL",
    args: { query, limit: 20 },
  };
}

export function buildDeterministicReasoningPlan(
  input: DeterministicReasoningPlannerInput,
): ReasoningPlan {
  const capabilities = input.capabilities ?? {};
  const contextLevel = input.contextLevel ?? "L2";
  const contextMaxTokens = boundedContextTokens(input.contextMaxTokens);
  let steps: ReasoningStep[];

  switch (input.intent) {
    case "COMPARISON": {
      const left = lexicalSearch(input.query, "lexical");
      const right: ReasoningStep = capabilities.vectorAvailable
        ? {
            id: "alternate",
            dependsOn: [],
            executionTarget: local,
            operator: "SEARCH_VECTOR",
            args: { query: input.query, limit: 20 },
          }
        : {
            id: "alternate",
            dependsOn: [],
            executionTarget: local,
            operator: "EXACT_LOOKUP",
            args: { query: input.query, limit: 20 },
          };
      const compare: ReasoningStep = {
        id: "compare",
        dependsOn: ["lexical", "alternate"],
        executionTarget: local,
        operator: "COMPARE",
        args: {
          leftStepId: "lexical",
          rightStepId: "alternate",
          fields: [],
        },
      };
      steps = [
        left,
        right,
        compare,
        contextStep(
          ["lexical", "alternate", "compare"],
          contextLevel,
          contextMaxTokens,
        ),
      ];
      break;
    }

    case "IMPACT_ANALYSIS": {
      if (capabilities.graphConsistent) {
        steps = [
          {
            id: "resolve",
            dependsOn: [],
            executionTarget: local,
            operator: "RESOLVE_ENTITY",
            args: {
              query: input.query,
              limit: 20,
              entityKinds: ["code-symbol", "knowledge"],
            },
          },
          {
            id: "traverse",
            dependsOn: ["resolve"],
            executionTarget: local,
            operator: "TRAVERSE_TYPED",
            args: {
              seedStepId: "resolve",
              relationTypes: [],
              direction: "both",
              maxHops: 3,
              limit: 100,
            },
          },
          verifyStep("traverse"),
          contextStep(["verify"], contextLevel, contextMaxTokens),
        ];
      } else {
        steps = [
          lexicalSearch(input.query),
          verifyStep("search"),
          contextStep(["verify"], contextLevel, contextMaxTokens),
        ];
      }
      break;
    }

    case "SOURCE_VERIFICATION": {
      const base = lexicalSearch(input.query);
      const verify = verifyStep("search");
      if (capabilities.rawAllowed) {
        const raw: ReasoningStep = {
          id: "raw",
          dependsOn: ["verify"],
          executionTarget: local,
          operator: "LOAD_RAW",
          args: {
            inputStepId: "verify",
            sourceIds: [],
            maxBytes: 1_000_000,
          },
        };
        steps = [
          base,
          verify,
          raw,
          contextStep(["verify", "raw"], contextLevel, contextMaxTokens),
        ];
      } else {
        steps = [
          base,
          verify,
          contextStep(["verify"], contextLevel, contextMaxTokens),
        ];
      }
      break;
    }

    case "PROJECT_CODE": {
      const search: ReasoningStep = capabilities.codeAdapterAvailable
        ? {
            id: "search",
            dependsOn: [],
            executionTarget: local,
            operator: "SEARCH_CODE",
            args: {
              query: input.query,
              limit: 20,
              ...(input.projectId ? { projectId: input.projectId } : {}),
            },
          }
        : lexicalSearch(input.query);
      steps = [
        search,
        verifyStep("search"),
        contextStep(["verify"], contextLevel, contextMaxTokens),
      ];
      break;
    }

    case "CONCEPTUAL":
    default: {
      steps = [
        lexicalSearch(input.query),
        verifyStep("search"),
        contextStep(["verify"], contextLevel, contextMaxTokens),
      ];
      break;
    }
  }

  return {
    schemaVersion: 1,
    query: input.query,
    intent: input.intent,
    revisionSet: input.revisionSet,
    steps,
    budget: {
      maxSteps: Math.min(32, steps.length + 2),
      maxWallMs: 30_000,
      maxTokens: Math.max(8_000, contextMaxTokens * 2),
      maxCost: 2,
    },
  };
}
