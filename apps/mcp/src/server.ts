import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const apiBase = process.env.AKP_API_URL ?? "http://127.0.0.1:8080";

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`AKP API ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

const server = new McpServer({
  name: "architecture-knowledge-platform",
  version: "0.1.0",
});

server.registerTool(
  "akp_status",
  {
    description: "Check platform health and active capabilities.",
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(await api("/health/readiness"), null, 2),
      },
    ],
  }),
);

server.registerTool(
  "akp_search",
  {
    description: "Search approved architecture knowledge with provenance-aware filters.",
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(50).default(10),
      mode: z
        .enum(["COMPILED_ONLY", "SOURCE_BACKED", "RAW_ONLY", "PROJECT_CODE"])
        .default("SOURCE_BACKED"),
    },
  },
  async ({ query, limit, mode }) => {
    const result = await api("/v1/search", {
      method: "POST",
      body: JSON.stringify({ query, limit, mode }),
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.registerTool(
  "akp_submit_source",
  {
    description: "Submit a source for durable ingestion; returns a job ID.",
    inputSchema: {
      spaceId: z.string().uuid(),
      sourceUri: z.string().min(1),
      mediaType: z.string().optional(),
      title: z.string().optional(),
    },
  },
  async (input) => {
    const result = await api("/v1/ingest", {
      method: "POST",
      body: JSON.stringify({
        ...input,
        policy: "REVIEW_REQUIRED",
      }),
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
