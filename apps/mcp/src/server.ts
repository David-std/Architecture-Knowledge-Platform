import "./instrumentation.js";
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QueryIntent, SearchRequest } from "@akp/contracts";
import { McpContextRequest } from "./context-request.js";
import { AkpContextInput, dispatchAkpContext } from "./context-facade.js";
import {
  AGENT_INSTRUCTION_BUNDLE,
  AGENT_INSTRUCTION_RESOURCE_URI,
} from "./instruction-bundle.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { shutdownOpenTelemetry, withSpan } from "@akp/observability";

config({
  path: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../.env",
  ),
});

const apiBase = process.env.AKP_API_URL ?? "http://127.0.0.1:8080";
const token = process.env.AKP_API_TOKEN;
if (!token) throw new Error("AKP_API_TOKEN is required for MCP.");

async function api(route: string, init?: RequestInit): Promise<unknown> {
  const routeTemplate =
    route.split("?")[0]?.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id") ?? "/";
  return withSpan("mcp.tool", { "akp.mcp.route": routeTemplate }, async () => {
    const response = await fetch(`${apiBase}${route}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(`AKP API ${response.status}: ${JSON.stringify(body)}`);
    }
    return body;
  });
}

async function writeApi(
  route: string,
  idempotencyKey: string,
  body: unknown,
): Promise<unknown> {
  return api(route, {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify(body),
  });
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function compactTextResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

const codeScopeInput = {
  spaceId: z.string().uuid(),
  vaultId: z.string().uuid().optional(),
  vaultIds: z.array(z.string().uuid()).max(100).default([]),
  federated: z.boolean().default(false),
  freshnessPolicy: z.enum(["FRESH_ONLY", "ALLOW_STALE"]).default("FRESH_ONLY"),
};

const codeSymbolSelectorInput = z
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

const codePathOptionsInput = z.object({
  relationTypes: z.array(z.string().trim().min(1).max(160)).max(100).optional(),
  maxHops: z.number().int().min(1).max(16).optional(),
  maxFanout: z.number().int().min(1).max(1000).optional(),
  maxCandidates: z.number().int().min(1).max(10000).optional(),
  timeBudgetMs: z.number().int().min(1).max(60000).optional(),
});

const codeImpactOptionsInput = codePathOptionsInput.extend({
  direction: z.enum(["outgoing", "incoming", "both"]).optional(),
  includeTests: z.boolean().optional(),
  includeCatalogBridges: z.boolean().optional(),
  includeRulesDecisions: z.boolean().optional(),
  includeRuntimeObservations: z.boolean().optional(),
});

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "architecture-knowledge-platform",
    version: "0.2.0",
  });

  server.registerResource(
    "akp-agent-instructions",
    AGENT_INSTRUCTION_RESOURCE_URI,
    {
      title: "AKP Agent Instruction Bundle",
      description:
        "Versioned, integrity-addressed instructions for using AKP context, evidence, task memory, impact analysis, and governed promotion.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(AGENT_INSTRUCTION_BUNDLE),
        },
      ],
    }),
  );

  server.registerTool(
    "akp_context",
    {
      description:
        "Low-entropy AKP context façade. Delegates bootstrap, retrieval, impact, code, temporal, verification, capture, task lifecycle, and status actions to the existing governed AKP APIs without replacing expert tools.",
      inputSchema: AkpContextInput.shape,
    },
    async (input) =>
      compactTextResult(
        await dispatchAkpContext(input, {
          api,
          writeApi,
        }),
      ),
  );

  server.registerTool(
    "akp_status",
    { description: "Check platform and corpus capabilities.", inputSchema: {} },
    async () => textResult(await api("/v1/status")),
  );

  server.registerTool(
    "akp_get_current_identity",
    {
      description:
        "Read the effective authenticated principal identity, parent/session binding, allowed actions, and policy revision without exposing credential secrets.",
      inputSchema: {},
    },
    async () => textResult(await api("/v1/auth/session")),
  );

  server.registerTool(
    "akp_list_vaults",
    {
      description:
        "List VaultRegistry entries visible to the authenticated actor.",
      inputSchema: {},
    },
    async () => textResult(await api("/v1/vaults")),
  );

  server.registerTool(
    "akp_start_session",
    {
      description: "Start a bounded agent session in an authorized space.",
      inputSchema: {
        purpose: z.string().min(1),
        contextBudget: z.number().int().min(256).max(32000).default(6000),
        spaceId: z.string().uuid(),
        vaultId: z.string().uuid(),
        projectId: z.string().uuid().optional(),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({ idempotencyKey, ...input }) =>
      textResult(await writeApi("/v1/sessions", idempotencyKey, input)),
  );

  server.registerTool(
    "akp_list_sessions",
    {
      description:
        "List durable workspace sessions visible to the authenticated participant.",
      inputSchema: {},
    },
    async () => textResult(await api("/v1/sessions")),
  );

  server.registerTool(
    "akp_get_session_state",
    {
      description:
        "Read durable structured workspace state so an authorized participant can resume without prior chat history.",
      inputSchema: { sessionId: z.string().uuid() },
    },
    async ({ sessionId }) =>
      textResult(
        await api(`/v1/sessions/${encodeURIComponent(sessionId)}/state`),
      ),
  );

  server.registerTool(
    "akp_bootstrap_session_context",
    {
      description:
        "Bootstrap a workspace session with its pinned revision, durable work context, knowledge profile, and authorized context packet.",
      inputSchema: {
        sessionId: z.string().uuid(),
        query: z.string().max(4096).optional(),
        intent: QueryIntent.default("WORKFLOW_EXECUTION"),
        packetMode: z
          .enum(["COMPACT_AGENT_PACKET", "FULL_CONTEXT_PACKET"])
          .default("COMPACT_AGENT_PACKET"),
      },
    },
    async ({ sessionId, ...body }) =>
      textResult(
        await api(`/v1/sessions/${encodeURIComponent(sessionId)}/bootstrap`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      ),
  );

  server.registerTool(
    "akp_update_work_context",
    {
      description:
        "Update durable WorkContext lifecycle state, outcome, follow-ups, and touched resources without turning coordination memory into canonical knowledge.",
      inputSchema: {
        sessionId: z.string().uuid(),
        status: z.enum(["OPEN", "BLOCKED", "COMPLETED", "ABANDONED"]),
        outcome: z.string().min(1).max(12000).nullable().optional(),
        followUps: z.array(z.string().min(1).max(2000)).max(50).optional(),
        touchedResources: z
          .array(z.string().min(1).max(1000))
          .max(100)
          .optional(),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({ sessionId, idempotencyKey, ...body }) =>
      textResult(
        await writeApi(
          `/v1/sessions/${encodeURIComponent(sessionId)}/work-context`,
          idempotencyKey,
          body,
        ),
      ),
  );

  server.registerTool(
    "akp_claim_workspace_work",
    {
      description:
        "Acquire a bounded exact or recursive workspace claim with a lease and fencing token.",
      inputSchema: {
        sessionId: z.string().uuid(),
        workKey: z.string().min(1).max(200),
        leaseSeconds: z.number().int().min(15).max(900).default(120),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({ sessionId, idempotencyKey, ...body }) =>
      textResult(
        await writeApi(
          `/v1/sessions/${encodeURIComponent(sessionId)}/claims`,
          idempotencyKey,
          body,
        ),
      ),
  );

  server.registerTool(
    "akp_heartbeat_workspace_claim",
    {
      description:
        "Renew an owned workspace claim only when its current fencing token matches.",
      inputSchema: {
        sessionId: z.string().uuid(),
        workKey: z.string().min(1).max(200),
        fencingToken: z.number().int().min(1),
        leaseSeconds: z.number().int().min(15).max(900).default(120),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({ sessionId, idempotencyKey, ...body }) =>
      textResult(
        await writeApi(
          `/v1/sessions/${encodeURIComponent(sessionId)}/claims/heartbeat`,
          idempotencyKey,
          body,
        ),
      ),
  );

  server.registerTool(
    "akp_release_workspace_claim",
    {
      description:
        "Release an owned live workspace claim and advance its fencing token so stale writers cannot continue.",
      inputSchema: {
        sessionId: z.string().uuid(),
        workKey: z.string().min(1).max(200),
        fencingToken: z.number().int().min(1),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({ sessionId, idempotencyKey, ...body }) =>
      textResult(
        await writeApi(
          `/v1/sessions/${encodeURIComponent(sessionId)}/claims/release`,
          idempotencyKey,
          body,
        ),
      ),
  );

  server.registerTool(
    "akp_handoff_workspace_claim",
    {
      description:
        "Transfer an owned fenced workspace claim to another authorized participant or exact agent principal with bounded machine-readable handoff state.",
      inputSchema: {
        sessionId: z.string().uuid(),
        workKey: z.string().min(1).max(200),
        toUserId: z.string().uuid(),
        toPrincipalId: z.string().uuid().optional(),
        fencingToken: z.number().int().min(1),
        leaseSeconds: z.number().int().min(15).max(900).default(120),
        summary: z.string().min(1).max(4096).optional(),
        completed: z.array(z.string().min(1).max(2000)).max(50).optional(),
        remaining: z.array(z.string().min(1).max(2000)).max(50).optional(),
        blockers: z.array(z.string().min(1).max(2000)).max(50).optional(),
        changedResourceRefs: z
          .array(z.string().min(1).max(1000))
          .max(100)
          .optional(),
        evidenceRefs: z.array(z.string().min(1).max(1000)).max(100).optional(),
        questions: z.array(z.string().min(1).max(2000)).max(50).optional(),
        note: z.string().max(2048).optional(),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({ sessionId, idempotencyKey, ...body }) =>
      textResult(
        await writeApi(
          `/v1/sessions/${encodeURIComponent(sessionId)}/claims/handoff`,
          idempotencyKey,
          body,
        ),
      ),
  );

  server.registerTool(
    "akp_append_workspace_event",
    {
      description:
        "Append a bounded finding, blocker, question, artifact, decision candidate, or note to the durable workspace blackboard.",
      inputSchema: {
        sessionId: z.string().uuid(),
        eventType: z.enum([
          "FINDING",
          "BLOCKER",
          "QUESTION",
          "ARTIFACT",
          "DECISION_CANDIDATE",
          "NOTE",
        ]),
        claimId: z.string().uuid().optional(),
        fencingToken: z.number().int().min(1).optional(),
        payload: z.record(z.unknown()).default({}),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({ sessionId, idempotencyKey, ...body }) =>
      textResult(
        await writeApi(
          `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
          idempotencyKey,
          body,
        ),
      ),
  );

  server.registerTool(
    "akp_request_workspace_promotion",
    {
      description:
        "Request governed promotion of durable workspace evidence into Git-backed review; this never bypasses human review policy.",
      inputSchema: {
        sessionId: z.string().uuid(),
        evidenceEventIds: z
          .array(z.string().regex(/^[1-9][0-9]*$/))
          .min(1)
          .max(100),
        summary: z.string().min(1).max(2000).optional(),
        changes: z
          .array(
            z.object({
              path: z.string().min(1),
              content: z.string().min(1),
              reason: z.string().min(1).optional(),
            }),
          )
          .min(1)
          .max(100),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({ sessionId, idempotencyKey, ...body }) =>
      textResult(
        await writeApi(
          `/v1/sessions/${encodeURIComponent(sessionId)}/promotions`,
          idempotencyKey,
          body,
        ),
      ),
  );

  server.registerTool(
    "akp_search",
    {
      description:
        "Search approved knowledge using exact, lexical and graph channels.",
      inputSchema: SearchRequest.shape,
    },
    async (input) =>
      textResult(
        await api("/v1/search", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      ),
  );

  server.registerTool(
    "akp_build_context",
    {
      description:
        "Build a token-budgeted, revisioned context packet with citations and gaps.",
      inputSchema: McpContextRequest.shape,
    },
    async (input) =>
      compactTextResult(
        await api("/v1/context", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      ),
  );

  server.registerTool(
    "akp_get_document",
    {
      description: "Read one knowledge document and its typed relationships.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) =>
      textResult(await api(`/v1/documents/${encodeURIComponent(id)}`)),
  );

  server.registerTool(
    "akp_get_source_evidence",
    {
      description: "Read explicit source and evidence trails for a document.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) =>
      textResult(await api(`/v1/documents/${encodeURIComponent(id)}/evidence`)),
  );

  server.registerTool(
    "akp_get_context_pack",
    {
      description:
        "Read one curated context pack by stable ID, alias or title.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) =>
      textResult(await api(`/v1/context-packs/${encodeURIComponent(id)}`)),
  );

  server.registerTool(
    "akp_get_generated_context_packet",
    {
      description:
        "Read a generated full ContextPacket by packet ID with current authorization and revision checks.",
      inputSchema: { packetId: z.string().uuid() },
    },
    async ({ packetId }) =>
      textResult(
        await api(
          `/v1/generated-context-packets/${encodeURIComponent(packetId)}`,
        ),
      ),
  );

  server.registerTool(
    "akp_get_context_continuation",
    {
      description:
        "Fetch the omitted sections behind a generated ContextPacket continuation handle.",
      inputSchema: {
        packetId: z.string().uuid(),
        handle: z.string().regex(/^[a-f0-9]{64}$/),
      },
    },
    async ({ packetId, handle }) =>
      textResult(
        await api(
          `/v1/generated-context-packets/${encodeURIComponent(packetId)}/continuations/${encodeURIComponent(handle)}`,
        ),
      ),
  );

  server.registerTool(
    "akp_analyze_impact",
    {
      description:
        "Traverse downstream knowledge impact through indexed relations.",
      inputSchema: {
        id: z.string().min(1),
        depth: z.number().int().min(1).max(5).default(2),
      },
    },
    async ({ id, depth }) =>
      textResult(
        await api(`/v1/impact/${encodeURIComponent(id)}?depth=${depth}`),
      ),
  );

  server.registerTool(
    "akp_find_code_symbol",
    {
      description:
        "Resolve code symbols in the authorized revisioned Code Graph.",
      inputSchema: {
        ...codeScopeInput,
        selector: codeSymbolSelectorInput,
      },
    },
    async (input) =>
      textResult(
        await api("/v1/code/symbol", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      ),
  );

  server.registerTool(
    "akp_find_code_callers",
    {
      description:
        "Find authorized direct callers of one uniquely resolved code symbol.",
      inputSchema: {
        ...codeScopeInput,
        selector: codeSymbolSelectorInput,
      },
    },
    async (input) =>
      textResult(
        await api("/v1/code/callers", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      ),
  );

  server.registerTool(
    "akp_find_code_callees",
    {
      description:
        "Find authorized direct callees of one uniquely resolved code symbol.",
      inputSchema: {
        ...codeScopeInput,
        selector: codeSymbolSelectorInput,
      },
    },
    async (input) =>
      textResult(
        await api("/v1/code/callees", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      ),
  );

  server.registerTool(
    "akp_find_code_path",
    {
      description:
        "Find bounded authorized dependency paths between two code symbols.",
      inputSchema: {
        ...codeScopeInput,
        source: codeSymbolSelectorInput,
        target: codeSymbolSelectorInput,
        options: codePathOptionsInput.optional(),
      },
    },
    async (input) =>
      textResult(
        await api("/v1/code/path", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      ),
  );

  server.registerTool(
    "akp_analyze_code_impact",
    {
      description:
        "Traverse bounded code impact with optional catalog, rule/decision, test, and runtime bridges.",
      inputSchema: {
        ...codeScopeInput,
        selector: codeSymbolSelectorInput,
        options: codeImpactOptionsInput.optional(),
      },
    },
    async (input) =>
      textResult(
        await api("/v1/code/impact", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      ),
  );

  server.registerTool(
    "akp_analyze_code_change_impact",
    {
      description:
        "Analyze bounded impact for changed repository paths at an immutable commit.",
      inputSchema: {
        ...codeScopeInput,
        repository: z.string().trim().min(1).max(2048),
        commitSha: z.string().regex(/^[a-f0-9]{40}$/i),
        changedPaths: z
          .array(z.string().trim().min(1).max(4096))
          .min(1)
          .max(500),
        options: codeImpactOptionsInput.optional(),
      },
    },
    async (input) =>
      textResult(
        await api("/v1/code/change-impact", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      ),
  );

  server.registerTool(
    "akp_find_code_tests",
    {
      description:
        "Find tests linked to one uniquely resolved code symbol in the authorized graph.",
      inputSchema: {
        ...codeScopeInput,
        selector: codeSymbolSelectorInput,
      },
    },
    async (input) =>
      textResult(
        await api("/v1/code/tests", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      ),
  );

  server.registerTool(
    "akp_explain_code_path",
    {
      description:
        "Explain bounded authorized dependency paths between two code symbols with edge provenance.",
      inputSchema: {
        ...codeScopeInput,
        source: codeSymbolSelectorInput,
        target: codeSymbolSelectorInput,
        options: codePathOptionsInput.optional(),
      },
    },
    async (input) =>
      textResult(
        await api("/v1/code/explain", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      ),
  );

  server.registerTool(
    "akp_submit_source",
    {
      description:
        "Submit a local captured source for durable, immutable ingestion.",
      inputSchema: {
        spaceId: z.string().uuid(),
        vaultId: z.string().uuid(),
        sourceUri: z.string().min(1),
        mediaType: z.string().optional(),
        title: z.string().optional(),
        expectedSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async (input) =>
      textResult(
        await writeApi("/v1/ingest", input.idempotencyKey, {
          ...input,
          policy: "REVIEW_REQUIRED",
        }),
      ),
  );

  server.registerTool(
    "akp_ingest_status",
    {
      description: "Read durable ingest state and transition history.",
      inputSchema: { jobId: z.string().uuid() },
    },
    async ({ jobId }) => textResult(await api(`/v1/ingest/${jobId}`)),
  );

  server.registerTool(
    "akp_propose_knowledge_change",
    {
      description:
        "Create a Git-backed review proposal. This never bypasses validation or review.",
      inputSchema: {
        spaceId: z.string().uuid(),
        vaultId: z.string().uuid(),
        summary: z.string().min(1),
        path: z.string().min(1),
        content: z.string().min(1),
        reason: z.string().min(1),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({
      spaceId,
      vaultId,
      summary,
      path,
      content,
      reason,
      idempotencyKey,
    }) =>
      textResult(
        await writeApi("/v1/proposals", idempotencyKey, {
          spaceId,
          vaultId,
          summary,
          changes: [{ path, content, reason }],
        }),
      ),
  );

  server.registerTool(
    "akp_validate_draft",
    {
      description:
        "Read the deterministic validation report and diff for a draft review.",
      inputSchema: { reviewId: z.string().uuid() },
    },
    async ({ reviewId }) => textResult(await api(`/v1/reviews/${reviewId}`)),
  );

  server.registerTool(
    "akp_submit_review",
    {
      description: "Submit or resubmit a validated draft to the review queue.",
      inputSchema: {
        reviewId: z.string().uuid(),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({ reviewId, idempotencyKey }) =>
      textResult(
        await writeApi(`/v1/reviews/${reviewId}/submit`, idempotencyKey, {}),
      ),
  );

  server.registerTool(
    "akp_revise_review",
    {
      description:
        "Create a new validated Git draft revision after a reviewer requested changes.",
      inputSchema: {
        reviewId: z.string().uuid(),
        summary: z.string().min(1),
        path: z.string().min(1),
        content: z.string().min(1),
        reason: z.string().min(1),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({ reviewId, summary, path, content, reason, idempotencyKey }) =>
      textResult(
        await writeApi(`/v1/reviews/${reviewId}/revise`, idempotencyKey, {
          summary,
          changes: [{ path, content, reason }],
        }),
      ),
  );

  server.registerTool(
    "akp_approve_review",
    {
      description:
        "Approve a pending review and merge its Git branch. Requires reviewer permission.",
      inputSchema: {
        reviewId: z.string().uuid(),
        reason: z.string().min(1),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({ reviewId, reason, idempotencyKey }) =>
      textResult(
        await writeApi(`/v1/reviews/${reviewId}/decision`, idempotencyKey, {
          decision: "APPROVE",
          reason,
        }),
      ),
  );

  server.registerTool(
    "akp_reject_review",
    {
      description: "Reject a pending review with a mandatory reason.",
      inputSchema: {
        reviewId: z.string().uuid(),
        reason: z.string().min(1),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({ reviewId, reason, idempotencyKey }) =>
      textResult(
        await writeApi(`/v1/reviews/${reviewId}/decision`, idempotencyKey, {
          decision: "REJECT",
          reason,
        }),
      ),
  );

  server.registerTool(
    "akp_run_eval",
    {
      description: "Run the checked-in critical retrieval evaluation suite.",
      inputSchema: {
        spaceId: z.string().uuid(),
        vaultId: z.string().uuid(),
        evalPack: z.string().default("generic"),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({ idempotencyKey, ...target }) =>
      textResult(await writeApi("/v1/evals/run", idempotencyKey, target)),
  );

  server.registerTool(
    "akp_reindex",
    {
      description:
        "Rebuild one explicitly selected authorized vault from the canonical corpus. Requires admin permission with pathPrefix null. Use REBUILD_DERIVED_PROJECTIONS for projections only or REIMPORT_AND_REBUILD to import that vault first.",
      inputSchema: {
        spaceId: z.string().uuid(),
        vaultId: z.string().uuid(),
        confirm: z.enum([
          "REBUILD_DERIVED_PROJECTIONS",
          "REIMPORT_AND_REBUILD",
        ]),
        reimportVault: z.boolean().default(false),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({ spaceId, vaultId, confirm, reimportVault, idempotencyKey }) => {
      const expectedConfirmation = reimportVault
        ? "REIMPORT_AND_REBUILD"
        : "REBUILD_DERIVED_PROJECTIONS";
      if (confirm !== expectedConfirmation) {
        throw new Error(
          `confirm must be ${expectedConfirmation} when reimportVault=${String(reimportVault)}`,
        );
      }
      return textResult(
        await writeApi("/v1/reindex", idempotencyKey, {
          spaceId,
          vaultId,
          confirm,
          reimportVault,
        }),
      );
    },
  );

  server.registerTool(
    "akp_benchmark_retrieval",
    {
      description: "Execute the retrieval configuration comparison matrix.",
      inputSchema: {
        spaceId: z.string().uuid(),
        vaultId: z.string().uuid(),
        evalPack: z.string().default("generic"),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({ idempotencyKey, ...target }) =>
      textResult(await writeApi("/v1/evals/benchmark", idempotencyKey, target)),
  );

  server.registerTool(
    "akp_export_audit_bundle",
    {
      description:
        "Inspect bounded audit-bundle revision/count/hash metadata. ZIP data and private record content never enter MCP context; use the authenticated HTTP/CLI export for delivery.",
      inputSchema: {
        vaultId: z.string().uuid(),
        confirm: z.literal("EXPORT_SANITIZED_AUDIT_BUNDLE"),
      },
    },
    async ({ vaultId, confirm }) =>
      textResult(
        await api(
          `/v1/audit/export/${encodeURIComponent(vaultId)}/metadata?confirm=${encodeURIComponent(confirm)}`,
        ),
      ),
  );

  return server;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  process.once("SIGTERM", () => void shutdownOpenTelemetry());
  process.once("SIGINT", () => void shutdownOpenTelemetry());
  await server.connect(transport);
}
