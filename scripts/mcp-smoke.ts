import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "akp-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "apps/mcp/src/server.ts"],
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
  stderr: "pipe",
});

function structuredToolResult(result: {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  if (result.isError) {
    throw new Error(
      `MCP tool returned an error: ${result.content
        .map((item) => item.text ?? item.type)
        .join(" ")}`,
    );
  }
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP tool returned no structured text content.");
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("MCP tool result is not an object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `MCP tool returned non-JSON content: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const required = [
    "akp_status",
    "akp_list_vaults",
    "akp_start_session",
    "akp_search",
    "akp_build_context",
    "akp_get_document",
    "akp_get_source_evidence",
    "akp_get_context_pack",
    "akp_analyze_impact",
    "akp_submit_source",
    "akp_ingest_status",
    "akp_propose_knowledge_change",
    "akp_validate_draft",
    "akp_submit_review",
    "akp_approve_review",
    "akp_reject_review",
    "akp_run_eval",
    "akp_reindex",
    "akp_benchmark_retrieval",
    "akp_export_audit_bundle",
  ];
  const names = new Set(tools.tools.map((tool) => tool.name));
  const missing = required.filter((name) => !names.has(name));
  if (missing.length)
    throw new Error(`Missing MCP tools: ${missing.join(", ")}`);
  const status = await client.callTool({ name: "akp_status", arguments: {} });
  const statusPayload = structuredToolResult(status);
  if (statusPayload.status !== "UP") {
    throw new Error(
      `Unexpected platform status: ${JSON.stringify(statusPayload)}`,
    );
  }
  const listed = await client.callTool({
    name: "akp_list_vaults",
    arguments: {},
  });
  const listedPayload = structuredToolResult(listed);
  const vaults = Array.isArray(listedPayload.vaults)
    ? listedPayload.vaults
    : [];
  const firstVault = vaults.find(
    (candidate): candidate is Record<string, unknown> =>
      Boolean(candidate) && typeof candidate === "object",
  );
  const vaultId = firstVault?.id;
  const spaceId = firstVault?.space_id ?? firstVault?.spaceId;
  if (typeof vaultId !== "string" || typeof spaceId !== "string") {
    throw new Error(
      `MCP smoke requires one authorized VaultRegistry entry: ${JSON.stringify(listedPayload)}`,
    );
  }
  const search = await client.callTool({
    name: "akp_search",
    arguments: {
      query: "dependency inversion architecture",
      spaceId,
      vaultIds: [vaultId],
      federated: false,
      limit: 3,
    },
  });
  const searchPayload = structuredToolResult(search);
  if (!Array.isArray(searchPayload.hits)) {
    throw new Error(
      `Unexpected MCP search payload: ${JSON.stringify(searchPayload)}`,
    );
  }
  console.log(
    JSON.stringify(
      {
        result: "PASSED",
        toolCount: tools.tools.length,
        requiredTools: required.length,
        platformStatus: statusPayload.status,
        visibleVaultCount: vaults.length,
        scopedVaultId: vaultId,
        searchHitCount: searchPayload.hits.length,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
