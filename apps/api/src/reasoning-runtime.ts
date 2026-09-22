import type {
  ContextRevisionSet,
  GraphRelationType,
  SearchHit,
  SearchRequest,
} from "@akp/contracts";
import {
  buildContextPacketPair,
  buildDeterministicReasoningPlan,
  executeReasoningPlan,
  type QueryPlannerCapabilities,
  type ReasoningExecutionTrace,
  type ReasoningExecutionValue,
  type ReasoningOperatorPorts,
  type ReasoningPlanExecutionResult,
  type ReasoningRevisionGuard,
  type ReasoningPlanValidationContext,
  type ReasoningTraceSink,
  type Tokenizer,
} from "@akp/retrieval";

const TRUST_RANK: Record<SearchHit["trust"], number> = {
  UNVERIFIED: 0,
  MACHINE_SUPPORTED: 1,
  HUMAN_REVIEWED: 2,
  ATTESTED: 3,
};

export type ReasoningRetrievalKind =
  | "RESOLVE_ENTITY"
  | "EXACT_LOOKUP"
  | "SEARCH_LEXICAL"
  | "SEARCH_VECTOR"
  | "SEARCH_CODE"
  | "TRAVERSE_TYPED"
  | "PPR_EXPAND"
  | "COMMUNITY_SEARCH"
  | "TEMPORAL_AT"
  | "LOAD_RAW";

export interface ReasoningRetrievalInvocation {
  kind: ReasoningRetrievalKind;
  query: string;
  limit: number;
  seedHits?: SearchHit[];
  relationTypes?: GraphRelationType[];
  direction?: "outgoing" | "incoming" | "both";
  maxHops?: number;
  damping?: number;
  maxIterations?: number;
  strategy?: "GLOBAL" | "DRIFT";
  asOf?: string;
  sourceIds?: string[];
  maxBytes?: number;
}

export type ReasoningRetrievalDelegate = (
  invocation: ReasoningRetrievalInvocation,
  signal: AbortSignal,
) => Promise<SearchHit[]>;

export interface ApplicationReasoningInput {
  request: SearchRequest;
  revisionSet: ContextRevisionSet;
  validationContext: ReasoningPlanValidationContext;
  capabilities: Partial<QueryPlannerCapabilities>;
  corpusRevision: string;
  indexRevisions: Record<string, string | null>;
  retrievalConfiguration?: Record<string, unknown>;
  retrieve: ReasoningRetrievalDelegate;
  traceSink?: ReasoningTraceSink;
  revisionGuard?: ReasoningRevisionGuard;
  tokenizer?: Tokenizer;
  contextLevel?: "L0" | "L1" | "L2" | "L3";
  contextMaxTokens?: number;
}

export interface ApplicationReasoningResult {
  execution: Exclude<ReasoningPlanExecutionResult, { status: "REJECTED" }>;
  hits: SearchHit[];
  reasoningTrace: ReasoningExecutionTrace;
}

function searchHitsFromPayload(payload: unknown): SearchHit[] {
  if (Array.isArray(payload)) return payload as SearchHit[];
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const arrays = [
    record.hits,
    record.leftHits,
    record.rightHits,
    record.documents,
  ].filter(Array.isArray) as SearchHit[][];
  return arrays.flat();
}

function hitsFromValue(
  value: ReasoningExecutionValue | undefined,
): SearchHit[] {
  return value ? searchHitsFromPayload(value.payload) : [];
}

function uniqueHits(hits: readonly SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const result: SearchHit[] = [];
  for (const hit of hits) {
    const key = hit.unitId ? `${hit.documentId}:${hit.unitId}` : hit.documentId;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(hit);
  }
  return result;
}

function documentValue(
  hits: readonly SearchHit[],
  channel: string,
): ReasoningExecutionValue {
  const unique = uniqueHits(hits);
  return {
    kind: "DOCUMENT_SET",
    refs: unique.map((hit) => hit.documentId),
    payload: unique,
    channel,
    ...(unique[0]?.revision ? { revision: unique[0].revision } : {}),
  };
}

function candidateKind(
  hit: SearchHit,
):
  | "rule"
  | "workflow"
  | "concept"
  | "profile"
  | "decision"
  | "example"
  | "counterexample"
  | "evidence"
  | "source" {
  const value = hit.type.toLowerCase();
  if (value.includes("rule") || value.includes("policy")) return "rule";
  if (value.includes("workflow") || value.includes("procedure"))
    return "workflow";
  if (value.includes("profile")) return "profile";
  if (value.includes("decision") || value.includes("adr")) return "decision";
  if (value.includes("counterexample")) return "counterexample";
  if (value.includes("example")) return "example";
  if (value.includes("evidence")) return "evidence";
  if (value.includes("source") || value.includes("resource")) return "source";
  return "concept";
}

function numericField(value: unknown, field: string | undefined): number[] {
  const candidates = Array.isArray(value) ? value : [value];
  return candidates
    .map((entry) => {
      if (!field) return typeof entry === "number" ? entry : Number.NaN;
      if (!entry || typeof entry !== "object") return Number.NaN;
      const raw = (entry as Record<string, unknown>)[field];
      return typeof raw === "number" ? raw : Number(raw);
    })
    .filter((entry) => Number.isFinite(entry));
}

function aggregateValues(
  operation: "COUNT" | "DISTINCT_COUNT" | "SUM" | "AVERAGE" | "MIN" | "MAX",
  payload: unknown,
  field?: string,
): unknown {
  const items = Array.isArray(payload) ? payload : [payload];
  if (operation === "COUNT") return items.length;
  if (operation === "DISTINCT_COUNT") {
    const values = field
      ? items.map((item) =>
          item && typeof item === "object"
            ? (item as Record<string, unknown>)[field]
            : undefined,
        )
      : items;
    return new Set(values.map((value) => JSON.stringify(value))).size;
  }
  const values = numericField(payload, field);
  if (values.length === 0) return null;
  if (operation === "SUM") return values.reduce((sum, value) => sum + value, 0);
  if (operation === "AVERAGE") {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  if (operation === "MIN") return Math.min(...values);
  return Math.max(...values);
}

function refsFromHits(hits: readonly SearchHit[]): string[] {
  return [...new Set(hits.map((hit) => hit.documentId))];
}

export function createApplicationReasoningPorts(
  input: ApplicationReasoningInput,
): ReasoningOperatorPorts {
  const retrieve = async (
    invocation: ReasoningRetrievalInvocation,
    signal: AbortSignal,
  ) => documentValue(await input.retrieve(invocation, signal), invocation.kind);

  return {
    RESOLVE_ENTITY: async ({ step, signal }) => {
      if (step.operator !== "RESOLVE_ENTITY") {
        throw new Error("REASONING_OPERATOR_STEP_MISMATCH");
      }
      return retrieve(
        {
          kind: "RESOLVE_ENTITY",
          query: step.args.query,
          limit: step.args.limit,
        },
        signal,
      );
    },

    EXACT_LOOKUP: async ({ step, signal }) => {
      if (step.operator !== "EXACT_LOOKUP") {
        throw new Error("REASONING_OPERATOR_STEP_MISMATCH");
      }
      return retrieve(
        {
          kind: "EXACT_LOOKUP",
          query: step.args.query,
          limit: step.args.limit,
        },
        signal,
      );
    },

    SEARCH_LEXICAL: async ({ step, signal }) => {
      if (step.operator !== "SEARCH_LEXICAL") {
        throw new Error("REASONING_OPERATOR_STEP_MISMATCH");
      }
      return retrieve(
        {
          kind: "SEARCH_LEXICAL",
          query: step.args.query,
          limit: step.args.limit,
        },
        signal,
      );
    },

    SEARCH_VECTOR: async ({ step, signal }) => {
      if (step.operator !== "SEARCH_VECTOR") {
        throw new Error("REASONING_OPERATOR_STEP_MISMATCH");
      }
      return retrieve(
        {
          kind: "SEARCH_VECTOR",
          query: step.args.query,
          limit: step.args.limit,
        },
        signal,
      );
    },

    SEARCH_CODE: async ({ step, signal }) => {
      if (step.operator !== "SEARCH_CODE") {
        throw new Error("REASONING_OPERATOR_STEP_MISMATCH");
      }
      return retrieve(
        {
          kind: "SEARCH_CODE",
          query: step.args.query,
          limit: step.args.limit,
        },
        signal,
      );
    },

    TRAVERSE_TYPED: async ({ step, inputs, signal }) => {
      if (step.operator !== "TRAVERSE_TYPED") {
        throw new Error("REASONING_OPERATOR_STEP_MISMATCH");
      }
      const seeds = hitsFromValue(inputs.get(step.args.seedStepId));
      return retrieve(
        {
          kind: "TRAVERSE_TYPED",
          query:
            seeds[0]?.document.externalId ??
            seeds[0]?.document.title ??
            input.request.query,
          limit: step.args.limit,
          seedHits: seeds,
          relationTypes: step.args.relationTypes,
          direction: step.args.direction,
          maxHops: step.args.maxHops,
        },
        signal,
      );
    },

    PPR_EXPAND: async ({ step, inputs, signal }) => {
      if (step.operator !== "PPR_EXPAND") {
        throw new Error("REASONING_OPERATOR_STEP_MISMATCH");
      }
      const seeds = uniqueHits(
        step.args.seedStepIds.flatMap((stepId) =>
          hitsFromValue(inputs.get(stepId)),
        ),
      );
      return retrieve(
        {
          kind: "PPR_EXPAND",
          query:
            seeds[0]?.document.externalId ??
            seeds[0]?.document.title ??
            input.request.query,
          limit: step.args.limit,
          seedHits: seeds,
          damping: step.args.damping,
          maxIterations: step.args.maxIterations,
        },
        signal,
      );
    },

    COMMUNITY_SEARCH: async ({ step, signal }) => {
      if (step.operator !== "COMMUNITY_SEARCH") {
        throw new Error("REASONING_OPERATOR_STEP_MISMATCH");
      }
      return retrieve(
        {
          kind: "COMMUNITY_SEARCH",
          query: step.args.query,
          limit: step.args.limit,
          strategy: step.args.strategy,
        },
        signal,
      );
    },

    TEMPORAL_AT: async ({ step, inputs, signal }) => {
      if (step.operator !== "TEMPORAL_AT") {
        throw new Error("REASONING_OPERATOR_STEP_MISMATCH");
      }
      const seeds = hitsFromValue(inputs.get(step.args.inputStepId));
      return retrieve(
        {
          kind: "TEMPORAL_AT",
          query: input.request.query,
          limit: input.request.limit,
          seedHits: seeds,
          asOf: step.args.asOf,
        },
        signal,
      );
    },

    FILTER_SCOPE: async ({ step, inputs }) => {
      if (step.operator !== "FILTER_SCOPE") {
        throw new Error("REASONING_OPERATOR_STEP_MISMATCH");
      }
      const allowedVaults = new Set(step.args.vaultIds);
      const prefixes = step.args.pathPrefixes;
      const hits = hitsFromValue(inputs.get(step.args.inputStepId)).filter(
        (hit) =>
          (allowedVaults.size === 0 || allowedVaults.has(hit.vaultId)) &&
          (prefixes.length === 0 ||
            prefixes.some(
              (prefix) =>
                hit.document.path === prefix ||
                hit.document.path.startsWith(`${prefix}/`),
            )),
      );
      return documentValue(hits, "FILTER_SCOPE");
    },

    JOIN_EVIDENCE: async ({ step, inputs }) => {
      if (step.operator !== "JOIN_EVIDENCE") {
        throw new Error("REASONING_OPERATOR_STEP_MISMATCH");
      }
      const hits = hitsFromValue(inputs.get(step.args.inputStepId)).filter(
        (hit) => hit.citations.length >= step.args.minimumSupport,
      );
      return documentValue(hits, "JOIN_EVIDENCE");
    },

    VERIFY_SUPPORT: async ({ step, inputs }) => {
      if (step.operator !== "VERIFY_SUPPORT") {
        throw new Error("REASONING_OPERATOR_STEP_MISMATCH");
      }
      const minimumTrust = TRUST_RANK[step.args.minimumTrust];
      const hits = hitsFromValue(inputs.get(step.args.inputStepId)).filter(
        (hit) =>
          TRUST_RANK[hit.trust] >= minimumTrust &&
          (!step.args.requireCitation || hit.citations.length > 0),
      );
      return documentValue(hits, "VERIFY_SUPPORT");
    },

    COMPARE: async ({ step, inputs }) => {
      if (step.operator !== "COMPARE") {
        throw new Error("REASONING_OPERATOR_STEP_MISMATCH");
      }
      const leftHits = hitsFromValue(inputs.get(step.args.leftStepId));
      const rightHits = hitsFromValue(inputs.get(step.args.rightStepId));
      return {
        kind: "COMPARISON",
        refs: refsFromHits([...leftHits, ...rightHits]),
        payload: {
          leftHits,
          rightHits,
          fields: step.args.fields,
        },
        channel: "COMPARE",
      };
    },

    AGGREGATE: async ({ step, inputs }) => {
      if (step.operator !== "AGGREGATE") {
        throw new Error("REASONING_OPERATOR_STEP_MISMATCH");
      }
      const value = inputs.get(step.args.inputStepId);
      const payload = value?.payload ?? [];
      const result = aggregateValues(
        step.args.operation,
        payload,
        step.args.field,
      );
      return {
        kind: "AGGREGATE",
        refs: value?.refs ?? [],
        payload: {
          operation: step.args.operation,
          field: step.args.field ?? null,
          groupBy: step.args.groupBy ?? null,
          value: result,
        },
        channel: "AGGREGATE",
      };
    },

    CALCULATE: async ({ step, inputs }) => {
      if (step.operator !== "CALCULATE") {
        throw new Error("REASONING_OPERATOR_STEP_MISMATCH");
      }
      const values = step.args.inputStepIds.map(
        (stepId) => inputs.get(stepId)?.payload,
      );
      const flattened = values.flatMap((value) =>
        Array.isArray(value) ? value : [value],
      );
      let result: unknown;
      if (step.args.operation === "RATIO") {
        const numerator = numericField(flattened, step.args.numeratorField);
        const denominator = numericField(flattened, step.args.denominatorField);
        const numeratorValue = numerator.reduce((sum, value) => sum + value, 0);
        const denominatorValue = denominator.reduce(
          (sum, value) => sum + value,
          0,
        );
        result =
          denominatorValue === 0 ? null : numeratorValue / denominatorValue;
      } else {
        result = aggregateValues(
          step.args.operation,
          flattened,
          step.args.field,
        );
      }
      return {
        kind: "AGGREGATE",
        refs: [
          ...new Set(
            step.args.inputStepIds.flatMap(
              (stepId) => inputs.get(stepId)?.refs ?? [],
            ),
          ),
        ],
        payload: {
          operation: step.args.operation,
          value: result,
        },
        channel: "CALCULATE",
      };
    },

    LOAD_RAW: async ({ step, inputs, signal }) => {
      if (step.operator !== "LOAD_RAW") {
        throw new Error("REASONING_OPERATOR_STEP_MISMATCH");
      }
      const seeds = step.args.inputStepId
        ? hitsFromValue(inputs.get(step.args.inputStepId))
        : [];
      const hits = await input.retrieve(
        {
          kind: "LOAD_RAW",
          query: input.request.query,
          limit: Math.min(100, input.request.limit),
          seedHits: seeds,
          sourceIds: step.args.sourceIds,
          maxBytes: step.args.maxBytes,
        },
        signal,
      );
      return {
        kind: "RAW_CONTENT",
        refs: refsFromHits(hits),
        payload: { hits: uniqueHits(hits) },
        channel: "RAW",
        ...(hits[0]?.revision ? { revision: hits[0].revision } : {}),
      };
    },

    BUILD_CONTEXT: async ({ step, inputs }) => {
      if (step.operator !== "BUILD_CONTEXT") {
        throw new Error("REASONING_OPERATOR_STEP_MISMATCH");
      }
      const hits = uniqueHits(
        step.args.inputStepIds.flatMap((stepId) =>
          hitsFromValue(inputs.get(stepId)),
        ),
      );
      const packet = buildContextPacketPair({
        request: input.request,
        intent: input.request.intent ?? "CONCEPTUAL",
        corpusRevision: input.corpusRevision,
        maxTokens: step.args.maxTokens,
        requestedContextLevel: step.args.contextLevel,
        candidates: hits.map((hit) => ({
          hit,
          content: hit.parentContext ?? hit.excerpt,
          kind: candidateKind(hit),
        })),
        indexRevisions: input.indexRevisions,
        retrievalConfiguration: {
          ...(input.retrievalConfiguration ?? {}),
          reasoningPlan: true,
        },
        ...(input.tokenizer ? { tokenizer: input.tokenizer } : {}),
      });
      return {
        kind: "CONTEXT_PACKET",
        refs: [packet.full.packetId],
        payload: packet,
        channel: "BUILD_CONTEXT",
        revision: input.corpusRevision,
        tokenUsage: packet.compact.budget.usedTokens,
      };
    },
  };
}

function finalDocumentHits(
  execution: Exclude<ReasoningPlanExecutionResult, { status: "REJECTED" }>,
): SearchHit[] {
  const contextStep = [...execution.plan.steps]
    .reverse()
    .find((step) => step.operator === "BUILD_CONTEXT");
  if (contextStep?.operator === "BUILD_CONTEXT") {
    return uniqueHits(
      contextStep.args.inputStepIds.flatMap((stepId) =>
        hitsFromValue(execution.results.get(stepId)),
      ),
    );
  }
  for (const step of [...execution.plan.steps].reverse()) {
    const value = execution.results.get(step.id);
    if (value?.kind !== "DOCUMENT_SET") continue;
    return uniqueHits(hitsFromValue(value));
  }
  return [];
}

export async function executeApplicationReasoning(
  input: ApplicationReasoningInput,
): Promise<ApplicationReasoningResult> {
  const plan = buildDeterministicReasoningPlan({
    query: input.request.query,
    intent: input.request.intent ?? "CONCEPTUAL",
    revisionSet: input.revisionSet,
    capabilities: input.capabilities,
    ...(input.request.projectId ? { projectId: input.request.projectId } : {}),
    ...(input.contextLevel ? { contextLevel: input.contextLevel } : {}),
    ...(input.contextMaxTokens !== undefined
      ? { contextMaxTokens: input.contextMaxTokens }
      : {}),
  });
  const execution = await executeReasoningPlan(plan, input.validationContext, {
    ports: createApplicationReasoningPorts(input),
    ...(input.traceSink ? { traceSink: input.traceSink } : {}),
    ...(input.revisionGuard ? { revisionGuard: input.revisionGuard } : {}),
  });
  if (execution.status === "REJECTED") {
    throw new Error("REASONING_PLAN_VALIDATION_FAILED");
  }
  const hits = finalDocumentHits(execution);
  if (execution.status === "FAILED") {
    throw new Error("REASONING_PLAN_EXECUTION_FAILED");
  }
  if (execution.status === "PARTIAL" && hits.length === 0) {
    throw new Error("REASONING_PLAN_PARTIAL_WITHOUT_CONTEXT");
  }
  return {
    execution,
    hits,
    reasoningTrace: execution.trace,
  };
}
