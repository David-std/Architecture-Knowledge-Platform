import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

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

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "architecture-knowledge-platform",
    version: "0.2.0",
  });

  server.registerTool(
    "akp_status",
    { description: "Check platform and corpus capabilities.", inputSchema: {} },
    async () => textResult(await api("/v1/status")),
  );

  server.registerTool(
    "akp_start_session",
    {
      description: "Start a bounded agent session in an authorized space.",
      inputSchema: {
        purpose: z.string().min(1),
        contextBudget: z.number().int().min(256).max(32000).default(6000),
        spaceId: z.string().uuid().optional(),
        projectId: z.string().uuid().optional(),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({ idempotencyKey, ...input }) =>
      textResult(await writeApi("/v1/sessions", idempotencyKey, input)),
  );

  server.registerTool(
    "akp_search",
    {
      description:
        "Search approved knowledge using exact, lexical and graph channels.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(10),
        minimumTrust: z
          .enum([
            "UNVERIFIED",
            "MACHINE_SUPPORTED",
            "HUMAN_REVIEWED",
            "ATTESTED",
          ])
          .default("MACHINE_SUPPORTED"),
        mode: z
          .enum(["COMPILED_ONLY", "SOURCE_BACKED", "RAW_ONLY", "PROJECT_CODE"])
          .default("SOURCE_BACKED"),
      },
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
      inputSchema: {
        query: z.string().min(1),
        intent: z.string().default("architecture guidance"),
        maxTokens: z.number().int().min(256).max(32000).default(6000),
        limit: z.number().int().min(1).max(50).default(20),
        mode: z
          .enum(["COMPILED_ONLY", "SOURCE_BACKED", "RAW_ONLY", "PROJECT_CODE"])
          .default("SOURCE_BACKED"),
      },
    },
    async (input) =>
      textResult(
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
    "akp_submit_source",
    {
      description:
        "Submit a local captured source for durable, immutable ingestion.",
      inputSchema: {
        spaceId: z
          .string()
          .uuid()
          .default("00000000-0000-0000-0000-000000000003"),
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
        summary: z.string().min(1),
        path: z.string().min(1),
        content: z.string().min(1),
        reason: z.string().min(1),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({ summary, path, content, reason, idempotencyKey }) =>
      textResult(
        await writeApi("/v1/proposals", idempotencyKey, {
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
      inputSchema: { idempotencyKey: z.string().min(8).max(200) },
    },
    async ({ idempotencyKey }) =>
      textResult(await writeApi("/v1/evals/run", idempotencyKey, {})),
  );

  server.registerTool(
    "akp_reindex",
    {
      description:
        "Rebuild one whole authorized space from the canonical corpus. Requires admin permission with pathPrefix null. Use REBUILD_DERIVED_PROJECTIONS for projections only or REIMPORT_AND_REBUILD to import the vault first.",
      inputSchema: {
        spaceId: z.string().uuid(),
        confirm: z.enum([
          "REBUILD_DERIVED_PROJECTIONS",
          "REIMPORT_AND_REBUILD",
        ]),
        reimportVault: z.boolean().default(false),
        idempotencyKey: z.string().min(8).max(200),
      },
    },
    async ({ spaceId, confirm, reimportVault, idempotencyKey }) => {
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
      inputSchema: { idempotencyKey: z.string().min(8).max(200) },
    },
    async ({ idempotencyKey }) =>
      textResult(await writeApi("/v1/evals/benchmark", idempotencyKey, {})),
  );

  return server;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
