import { QueryIntent } from "@akp/contracts";
import { z } from "zod";

export const AkpContextAction = z.enum([
  "BOOTSTRAP",
  "SEARCH",
  "EXPLAIN",
  "IMPACT",
  "CODE",
  "TEMPORAL",
  "GLOBAL",
  "VERIFY",
  "CAPTURE",
  "TASK",
  "STATUS",
]);
export type AkpContextAction = z.infer<typeof AkpContextAction>;

const UUID = z.string().uuid();

const CodeSelector = z
  .object({
    repository: z.string().trim().min(1).max(2048),
    commitSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/i)
      .optional(),
    path: z.string().trim().min(1).max(4096).optional(),
    qualifiedName: z.string().trim().min(1).max(2048).optional(),
    name: z.string().trim().min(1).max(1024).optional(),
    kind: z.string().trim().min(1).max(120).optional(),
    signature: z.string().trim().min(1).max(4096).optional(),
  })
  .strict()
  .refine(
    (value) =>
      Boolean(
        value.path || value.qualifiedName || value.name || value.signature,
      ),
    {
      message:
        "At least one of path, qualifiedName, name, or signature is required.",
    },
  );

const CodeOptions = z
  .object({
    relationTypes: z
      .array(z.string().trim().min(1).max(160))
      .max(100)
      .optional(),
    maxHops: z.number().int().min(1).max(16).optional(),
    maxFanout: z.number().int().min(1).max(1000).optional(),
    maxCandidates: z.number().int().min(1).max(10000).optional(),
    timeBudgetMs: z.number().int().min(1).max(60000).optional(),
    direction: z.enum(["outgoing", "incoming", "both"]).optional(),
    includeTests: z.boolean().optional(),
    includeCatalogBridges: z.boolean().optional(),
    includeRulesDecisions: z.boolean().optional(),
    includeRuntimeObservations: z.boolean().optional(),
  })
  .strict();

const CaptureInput = z
  .object({
    eventType: z.enum([
      "FINDING",
      "BLOCKER",
      "QUESTION",
      "ARTIFACT",
      "DECISION_CANDIDATE",
      "NOTE",
    ]),
    payload: z.record(z.unknown()).default({}),
    claimId: UUID.optional(),
    fencingToken: z.number().int().min(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.claimId) !== Boolean(value.fencingToken)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["claimId"],
        message: "claimId and fencingToken must be provided together.",
      });
    }
  });

const TaskInput = z
  .object({
    status: z.enum(["OPEN", "BLOCKED", "COMPLETED", "ABANDONED"]),
    outcome: z.string().min(1).max(12000).nullable().optional(),
    followUps: z.array(z.string().min(1).max(2000)).max(50).optional(),
    touchedResources: z.array(z.string().min(1).max(1000)).max(100).optional(),
  })
  .strict();

const TemporalInput = z
  .object({
    subjectRef: z.string().trim().min(1).max(2048).optional(),
    predicate: z.string().trim().min(1).max(512).optional(),
    mode: z.enum(["CURRENT", "HISTORY"]).default("CURRENT"),
    validAt: z.string().datetime().optional(),
    recordedAtOrBefore: z.string().datetime().optional(),
    truthRevisionHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    changedSince: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(1000).default(100),
  })
  .strict();

export const AkpContextInput = z
  .object({
    action: AkpContextAction,
    sessionId: UUID.optional(),
    spaceId: UUID.optional(),
    vaultId: UUID.optional(),
    vaultIds: z.array(UUID).max(20).default([]),
    federated: z.boolean().default(false),
    query: z.string().trim().min(1).max(4096).optional(),
    intent: QueryIntent.optional(),
    limit: z.number().int().min(1).max(50).default(10),
    maxTokens: z.number().int().min(256).max(32000).default(6000),
    packetMode: z
      .enum(["COMPACT_AGENT_PACKET", "FULL_CONTEXT_PACKET"])
      .default("COMPACT_AGENT_PACKET"),
    resourceId: z.string().trim().min(1).max(2048).optional(),
    depth: z.number().int().min(1).max(5).default(2),
    idempotencyKey: z.string().min(8).max(200).optional(),
    codeOperation: z
      .enum([
        "SYMBOL",
        "CALLERS",
        "CALLEES",
        "PATH",
        "IMPACT",
        "CHANGE_IMPACT",
        "TESTS",
        "EXPLAIN_PATH",
      ])
      .default("SYMBOL"),
    selector: CodeSelector.optional(),
    sourceSelector: CodeSelector.optional(),
    targetSelector: CodeSelector.optional(),
    repository: z.string().trim().min(1).max(2048).optional(),
    commitSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/i)
      .optional(),
    changedPaths: z
      .array(z.string().trim().min(1).max(4096))
      .min(1)
      .max(500)
      .optional(),
    codeOptions: CodeOptions.optional(),
    temporal: TemporalInput.optional(),
    capture: CaptureInput.optional(),
    task: TaskInput.optional(),
  })
  .strict();

export type AkpContextInput = z.infer<typeof AkpContextInput>;

export type AkpContextApi = (
  route: string,
  init?: RequestInit,
) => Promise<unknown>;

export type AkpContextWriteApi = (
  route: string,
  idempotencyKey: string,
  body: unknown,
) => Promise<unknown>;

function required<T>(value: T | undefined, code: string): T {
  if (value === undefined || value === null || value === "") {
    throw new Error(code);
  }
  return value;
}

function scopedVaultIds(input: AkpContextInput): string[] {
  const ids = input.vaultIds.length
    ? input.vaultIds
    : input.vaultId
      ? [input.vaultId]
      : [];
  if (ids.length === 0) throw new Error("AKP_CONTEXT_VAULT_SCOPE_REQUIRED");
  return ids;
}

function contextBody(
  input: AkpContextInput,
  intent: z.infer<typeof QueryIntent>,
) {
  return {
    query: required(input.query, "AKP_CONTEXT_QUERY_REQUIRED"),
    spaceId: required(input.spaceId, "AKP_CONTEXT_SPACE_REQUIRED"),
    vaultIds: scopedVaultIds(input),
    federated: input.federated,
    intent,
    maxTokens: input.maxTokens,
    packetMode: input.packetMode,
    limit: input.limit,
  };
}

function codeScope(input: AkpContextInput) {
  return {
    spaceId: required(input.spaceId, "AKP_CONTEXT_SPACE_REQUIRED"),
    ...(input.vaultId ? { vaultId: input.vaultId } : {}),
    vaultIds: input.vaultIds,
    federated: input.federated,
    freshnessPolicy: "FRESH_ONLY" as const,
  };
}

function envelope(
  action: AkpContextAction,
  result: unknown,
  delegatedTo: string,
) {
  return {
    schemaVersion: 1,
    action,
    status: "OK" as const,
    delegatedTo,
    result,
  };
}

export async function dispatchAkpContext(
  rawInput: unknown,
  deps: { api: AkpContextApi; writeApi: AkpContextWriteApi },
) {
  const input = AkpContextInput.parse(rawInput);
  switch (input.action) {
    case "STATUS":
      return envelope(input.action, await deps.api("/v1/status"), "akp_status");

    case "BOOTSTRAP": {
      const sessionId = required(
        input.sessionId,
        "AKP_CONTEXT_SESSION_REQUIRED",
      );
      return envelope(
        input.action,
        await deps.api(
          `/v1/sessions/${encodeURIComponent(sessionId)}/bootstrap`,
          {
            method: "POST",
            body: JSON.stringify({
              ...(input.query ? { query: input.query } : {}),
              intent: input.intent ?? "WORKFLOW_EXECUTION",
              packetMode: input.packetMode,
            }),
          },
        ),
        "akp_bootstrap_session_context",
      );
    }

    case "SEARCH":
      return envelope(
        input.action,
        await deps.api("/v1/search", {
          method: "POST",
          body: JSON.stringify({
            query: required(input.query, "AKP_CONTEXT_QUERY_REQUIRED"),
            spaceId: required(input.spaceId, "AKP_CONTEXT_SPACE_REQUIRED"),
            vaultIds: scopedVaultIds(input),
            federated: input.federated,
            intent: input.intent ?? "CONCEPTUAL",
            limit: input.limit,
          }),
        }),
        "akp_search",
      );

    case "EXPLAIN":
      return envelope(
        input.action,
        await deps.api("/v1/context", {
          method: "POST",
          body: JSON.stringify(
            contextBody(input, input.intent ?? "CONCEPTUAL"),
          ),
        }),
        "akp_build_context",
      );

    case "GLOBAL":
      return envelope(
        input.action,
        await deps.api("/v1/context", {
          method: "POST",
          body: JSON.stringify(contextBody(input, "GLOBAL_SYNTHESIS")),
        }),
        "akp_build_context",
      );

    case "IMPACT": {
      const resourceId = required(
        input.resourceId,
        "AKP_CONTEXT_RESOURCE_REQUIRED",
      );
      return envelope(
        input.action,
        await deps.api(
          `/v1/impact/${encodeURIComponent(resourceId)}?depth=${input.depth}`,
        ),
        "akp_analyze_impact",
      );
    }

    case "VERIFY": {
      if (input.resourceId) {
        return envelope(
          input.action,
          await deps.api(
            `/v1/documents/${encodeURIComponent(input.resourceId)}/evidence`,
          ),
          "akp_get_source_evidence",
        );
      }
      return envelope(
        input.action,
        await deps.api("/v1/context", {
          method: "POST",
          body: JSON.stringify(contextBody(input, "SOURCE_VERIFICATION")),
        }),
        "akp_build_context",
      );
    }

    case "TEMPORAL": {
      const spaceId = required(input.spaceId, "AKP_CONTEXT_SPACE_REQUIRED");
      const vaultId = required(
        input.vaultId ?? input.vaultIds[0],
        "AKP_CONTEXT_VAULT_SCOPE_REQUIRED",
      );
      const temporal = input.temporal ?? {
        mode: "CURRENT" as const,
        limit: 100,
      };
      const params = new URLSearchParams({
        spaceId,
        vaultId,
        mode: temporal.mode,
        limit: String(temporal.limit),
      });
      if (temporal.subjectRef) params.set("subjectRef", temporal.subjectRef);
      if (temporal.predicate) params.set("predicate", temporal.predicate);
      if (temporal.validAt) params.set("validAt", temporal.validAt);
      if (temporal.recordedAtOrBefore) {
        params.set("recordedAtOrBefore", temporal.recordedAtOrBefore);
      }
      if (temporal.truthRevisionHash) {
        params.set("truthRevisionHash", temporal.truthRevisionHash);
      }
      if (temporal.changedSince) {
        params.set("changedSince", temporal.changedSince);
      }
      return envelope(
        input.action,
        await deps.api(`/v1/truth/facts?${params.toString()}`),
        "temporal_truth",
      );
    }

    case "CODE": {
      const scope = codeScope(input);
      const options = input.codeOptions;
      const call = async (route: string, body: unknown, delegatedTo: string) =>
        envelope(
          input.action,
          await deps.api(route, {
            method: "POST",
            body: JSON.stringify(body),
          }),
          delegatedTo,
        );

      switch (input.codeOperation) {
        case "SYMBOL":
          return call(
            "/v1/code/symbol",
            {
              ...scope,
              selector: required(
                input.selector,
                "AKP_CONTEXT_CODE_SELECTOR_REQUIRED",
              ),
            },
            "akp_find_code_symbol",
          );
        case "CALLERS":
          return call(
            "/v1/code/callers",
            {
              ...scope,
              selector: required(
                input.selector,
                "AKP_CONTEXT_CODE_SELECTOR_REQUIRED",
              ),
            },
            "akp_find_code_callers",
          );
        case "CALLEES":
          return call(
            "/v1/code/callees",
            {
              ...scope,
              selector: required(
                input.selector,
                "AKP_CONTEXT_CODE_SELECTOR_REQUIRED",
              ),
            },
            "akp_find_code_callees",
          );
        case "PATH":
          return call(
            "/v1/code/path",
            {
              ...scope,
              source: required(
                input.sourceSelector,
                "AKP_CONTEXT_CODE_SOURCE_REQUIRED",
              ),
              target: required(
                input.targetSelector,
                "AKP_CONTEXT_CODE_TARGET_REQUIRED",
              ),
              ...(options ? { options } : {}),
            },
            "akp_find_code_path",
          );
        case "IMPACT":
          return call(
            "/v1/code/impact",
            {
              ...scope,
              selector: required(
                input.selector,
                "AKP_CONTEXT_CODE_SELECTOR_REQUIRED",
              ),
              ...(options ? { options } : {}),
            },
            "akp_analyze_code_impact",
          );
        case "CHANGE_IMPACT":
          return call(
            "/v1/code/change-impact",
            {
              ...scope,
              repository: required(
                input.repository,
                "AKP_CONTEXT_CODE_REPOSITORY_REQUIRED",
              ),
              commitSha: required(
                input.commitSha,
                "AKP_CONTEXT_CODE_COMMIT_REQUIRED",
              ),
              changedPaths: required(
                input.changedPaths,
                "AKP_CONTEXT_CODE_CHANGED_PATHS_REQUIRED",
              ),
              ...(options ? { options } : {}),
            },
            "akp_analyze_code_change_impact",
          );
        case "TESTS":
          return call(
            "/v1/code/tests",
            {
              ...scope,
              selector: required(
                input.selector,
                "AKP_CONTEXT_CODE_SELECTOR_REQUIRED",
              ),
            },
            "akp_find_code_tests",
          );
        case "EXPLAIN_PATH":
          return call(
            "/v1/code/explain",
            {
              ...scope,
              source: required(
                input.sourceSelector,
                "AKP_CONTEXT_CODE_SOURCE_REQUIRED",
              ),
              target: required(
                input.targetSelector,
                "AKP_CONTEXT_CODE_TARGET_REQUIRED",
              ),
              ...(options ? { options } : {}),
            },
            "akp_explain_code_path",
          );
      }
    }

    case "CAPTURE": {
      const sessionId = required(
        input.sessionId,
        "AKP_CONTEXT_SESSION_REQUIRED",
      );
      const idempotencyKey = required(
        input.idempotencyKey,
        "AKP_CONTEXT_IDEMPOTENCY_KEY_REQUIRED",
      );
      const capture = required(input.capture, "AKP_CONTEXT_CAPTURE_REQUIRED");
      return envelope(
        input.action,
        await deps.writeApi(
          `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
          idempotencyKey,
          capture,
        ),
        "akp_append_workspace_event",
      );
    }

    case "TASK": {
      const sessionId = required(
        input.sessionId,
        "AKP_CONTEXT_SESSION_REQUIRED",
      );
      const idempotencyKey = required(
        input.idempotencyKey,
        "AKP_CONTEXT_IDEMPOTENCY_KEY_REQUIRED",
      );
      const task = required(input.task, "AKP_CONTEXT_TASK_REQUIRED");
      return envelope(
        input.action,
        await deps.writeApi(
          `/v1/sessions/${encodeURIComponent(sessionId)}/work-context`,
          idempotencyKey,
          task,
        ),
        "akp_update_work_context",
      );
    }
  }
  const exhaustive: never = input.action;
  throw new Error(`AKP_CONTEXT_ACTION_UNSUPPORTED:${exhaustive}`);
}
