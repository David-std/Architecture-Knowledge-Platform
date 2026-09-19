import "dotenv/config";
import { strict as assert } from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CodeGraphArtifact } from "../packages/contracts/src/index.js";
import {
  Postgres,
  PostgresFederatedGraphStore,
} from "../packages/postgres/src/index.js";
import { planCodeGraphProjection } from "../packages/project-adapter/src/index.js";

const client = new Client({ name: "akp-smoke", version: "0.1.0" });
let agentContextDb: Postgres | null = null;
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

function normalizedSearchProvenance(value: unknown): Array<{
  documentId: string;
  citations: string[];
}> {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const hits = Array.isArray(record.hits) ? record.hits : [];
  return hits
    .flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const hit = item as Record<string, unknown>;
      if (typeof hit.documentId !== "string") return [];
      return [
        {
          documentId: hit.documentId,
          citations: Array.isArray(hit.citations)
            ? hit.citations
                .filter(
                  (citation): citation is string =>
                    typeof citation === "string",
                )
                .sort()
            : [],
        },
      ];
    })
    .sort((left, right) => left.documentId.localeCompare(right.documentId));
}

function normalizedCodeProvenance(value: unknown): Array<{
  repository: string;
  commitSha: string;
  qualifiedName: string;
  revision: string | null;
  freshness: string | null;
}> {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const symbols = Array.isArray(record.symbols) ? record.symbols : [];
  return symbols.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const symbol = item as Record<string, unknown>;
    const payload =
      symbol.payload &&
      typeof symbol.payload === "object" &&
      !Array.isArray(symbol.payload)
        ? (symbol.payload as Record<string, unknown>)
        : {};
    const projection =
      symbol.projection &&
      typeof symbol.projection === "object" &&
      !Array.isArray(symbol.projection)
        ? (symbol.projection as Record<string, unknown>)
        : {};
    if (
      typeof payload.repository !== "string" ||
      typeof payload.commitSha !== "string" ||
      typeof payload.qualifiedName !== "string"
    ) {
      return [];
    }
    return [
      {
        repository: payload.repository,
        commitSha: payload.commitSha,
        qualifiedName: payload.qualifiedName,
        revision:
          typeof projection.revision === "string" ? projection.revision : null,
        freshness:
          typeof projection.freshness === "string"
            ? projection.freshness
            : null,
      },
    ];
  });
}

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
    "akp_context",
    "akp_status",
    "akp_get_current_identity",
    "akp_list_vaults",
    "akp_start_session",
    "akp_list_sessions",
    "akp_get_session_state",
    "akp_update_work_context",
    "akp_bootstrap_session_context",
    "akp_claim_workspace_work",
    "akp_heartbeat_workspace_claim",
    "akp_release_workspace_claim",
    "akp_handoff_workspace_claim",
    "akp_append_workspace_event",
    "akp_request_workspace_promotion",
    "akp_search",
    "akp_build_context",
    "akp_get_document",
    "akp_get_source_evidence",
    "akp_get_context_pack",
    "akp_analyze_impact",
    "akp_find_code_symbol",
    "akp_find_code_callers",
    "akp_find_code_callees",
    "akp_find_code_path",
    "akp_analyze_code_impact",
    "akp_analyze_code_change_impact",
    "akp_find_code_tests",
    "akp_explain_code_path",
    "akp_submit_source",
    "akp_ingest_status",
    "akp_propose_knowledge_change",
    "akp_validate_draft",
    "akp_submit_review",
    "akp_revise_review",
    "akp_approve_review",
    "akp_reject_review",
    "akp_run_eval",
    "akp_reindex",
    "akp_benchmark_retrieval",
    "akp_export_audit_bundle",
  ];
  const resources = await client.listResources();
  const instructionResource = resources.resources.find((resource) =>
    /^akp:\/\/instructions\/agent\/v1\/[a-f0-9]{64}$/.test(resource.uri),
  );
  if (!instructionResource) {
    throw new Error(
      `Missing integrity-addressed AKP instruction resource: ${JSON.stringify(resources.resources)}`,
    );
  }
  const instructionRead = await client.readResource({
    uri: instructionResource.uri,
  });
  const instructionText = instructionRead.contents.find(
    (content) => "text" in content && typeof content.text === "string",
  );
  if (!instructionText || !("text" in instructionText)) {
    throw new Error("AKP instruction resource returned no JSON text.");
  }
  const instructionBundle = JSON.parse(String(instructionText.text)) as {
    manifest?: { sha256?: string };
    rules?: unknown[];
  };
  const resourceDigest = instructionResource.uri.split("/").at(-1);
  if (
    instructionBundle.manifest?.sha256 !== resourceDigest ||
    !Array.isArray(instructionBundle.rules) ||
    instructionBundle.rules.length < 7
  ) {
    throw new Error(
      `Invalid AKP instruction resource: ${JSON.stringify(instructionBundle)}`,
    );
  }

  const names = new Set(tools.tools.map((tool) => tool.name));
  const missing = required.filter((name) => !names.has(name));
  if (missing.length)
    throw new Error(`Missing MCP tools: ${missing.join(", ")}`);
  const facadeStatus = await client.callTool({
    name: "akp_context",
    arguments: { action: "STATUS" },
  });
  const facadeStatusPayload = structuredToolResult(facadeStatus);
  if (
    facadeStatusPayload.action !== "STATUS" ||
    facadeStatusPayload.status !== "OK" ||
    facadeStatusPayload.delegatedTo !== "akp_status"
  ) {
    throw new Error(
      `Unexpected akp_context STATUS payload: ${JSON.stringify(facadeStatusPayload)}`,
    );
  }

  const status = await client.callTool({ name: "akp_status", arguments: {} });
  const statusPayload = structuredToolResult(status);
  if (statusPayload.status !== "UP") {
    throw new Error(
      `Unexpected platform status: ${JSON.stringify(statusPayload)}`,
    );
  }
  // Resolve identity live so revocation or expiry cannot be hidden by cached MCP state.
  const identity = await client.callTool({
    name: "akp_get_current_identity",
    arguments: {},
  });
  const identityPayload = structuredToolResult(identity);
  const identityActor = identityPayload.actor;
  if (!identityActor || typeof identityActor !== "object") {
    throw new Error(
      `Unexpected MCP identity payload: ${JSON.stringify(identityPayload)}`,
    );
  }
  const identityRecord = identityActor as Record<string, unknown>;
  const identityJson = JSON.stringify(identityPayload);
  if (
    identityPayload.authenticated !== true ||
    typeof identityRecord.principalId !== "string" ||
    typeof identityRecord.principalKind !== "string" ||
    typeof identityRecord.authenticationKind !== "string" ||
    !Array.isArray(identityRecord.principalAllowedActions) ||
    typeof identityRecord.principalPolicyRevision !== "number" ||
    /"(?:token|tokenHash|credentialHash|csrfHash)"\s*:/.test(identityJson)
  ) {
    throw new Error(`Unexpected MCP identity payload: ${identityJson}`);
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

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(\n      "DATABASE_URL is required for MCP agent context exit evidence.",\n    );
  }
  const codeRepository = `mcp-agent-context-fixture-${vaultId.slice(0, 8)}`;
  const codeCommit = "7".repeat(40);
  const codeScopeId = `repo:${codeRepository}`;
  const codeArtifact: CodeGraphArtifact = {
    schemaVersion: 1,
    repository: codeRepository,
    commitSha: codeCommit,
    provider: "mcp-agent-context-exit-fixture",
    providerVersion: "1",
    configurationHash: "8".repeat(64),
    generatedAt: "2026-09-19T00:00:00.000Z",
    languages: ["typescript"],
    nodes: [
      {
        id: "function:facadeEntry",
        kind: "FUNCTION",
        name: "facadeEntry",
        qualifiedName: "facadeEntry",
        path: "src/facade-entry.ts",
        lineStart: 1,
        lineEnd: 4,
      },
      {
        id: "function:facadeHelper",
        kind: "FUNCTION",
        name: "facadeHelper",
        qualifiedName: "facadeHelper",
        path: "src/facade-helper.ts",
        lineStart: 1,
        lineEnd: 3,
      },
    ],
    edges: [
      {
        id: "edge:facade-entry-helper",
        sourceId: "function:facadeEntry",
        targetId: "function:facadeHelper",
        relation: "CALLS",
        derivation: "STATICALLY_RESOLVED",
      },
    ],
    warnings: [],
  };
  agentContextDb = new Postgres(databaseUrl);
  const agentContextGraph = new PostgresFederatedGraphStore(agentContextDb);
  const projection = planCodeGraphProjection({
    artifact: codeArtifact,
    spaceId,
    vaultId,
    scopeId: codeScopeId,
  });
  if (projection.skippedCandidateEdgeIds.length !== 0) {
    throw new Error(\n      "MCP agent context Code Graph fixture unexpectedly skipped edges.",\n    );
  }
  await agentContextGraph.build(projection.projection);
  const facadeSearch = await client.callTool({
    name: "akp_context",
    arguments: {
      action: "SEARCH",
      query: "dependency inversion architecture",
      spaceId,
      vaultId,
      federated: false,
      limit: 3,
    },
  });
  const facadeSearchPayload = structuredToolResult(facadeSearch);
  const facadeSearchResult = facadeSearchPayload.result as
    Record<string, unknown> | undefined;
  if (
    facadeSearchPayload.action !== "SEARCH" ||
    facadeSearchPayload.status !== "OK" ||
    facadeSearchPayload.delegatedTo !== "akp_search" ||
    !facadeSearchResult ||
    !Array.isArray(facadeSearchResult.hits)
  ) {
    throw new Error(
      `Unexpected akp_context SEARCH payload: ${JSON.stringify(facadeSearchPayload)}`,
    );
  }

  const search = await client.callTool({
    name: "akp_search",
    arguments: {
      query: "dependency inversion architecture",
      intent: "CONCEPTUAL",
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
  assert.deepEqual(
    normalizedSearchProvenance(facadeSearchResult),
    normalizedSearchProvenance(searchPayload),
    "akp_context SEARCH must preserve the expert search provenance set",
  );

  const codeArguments = {
    spaceId,
    vaultId,
    vaultIds: [],
    federated: false,
    freshnessPolicy: "FRESH_ONLY",
    selector: {
      repository: codeRepository,
      commitSha: codeCommit,
      qualifiedName: "facadeEntry",
    },
  };
  const expertCode = await client.callTool({
    name: "akp_find_code_symbol",
    arguments: codeArguments,
  });
  const expertCodePayload = structuredToolResult(expertCode);
  const facadeCode = await client.callTool({
    name: "akp_context",
    arguments: {
      action: "CODE",
      codeOperation: "SYMBOL",
      spaceId,
      vaultId,
      selector: codeArguments.selector,
    },
  });
  const facadeCodePayload = structuredToolResult(facadeCode);
  const facadeCodeResult = facadeCodePayload.result as
    Record<string, unknown> | undefined;
  if (
    facadeCodePayload.action !== "CODE" ||
    facadeCodePayload.status !== "OK" ||
    facadeCodePayload.delegatedTo !== "akp_find_code_symbol" ||
    !facadeCodeResult
  ) {
    throw new Error(
      `Unexpected akp_context CODE payload: ${JSON.stringify(facadeCodePayload)}`,
    );
  }
  const expertCodeProvenance = normalizedCodeProvenance(expertCodePayload);
  const facadeCodeProvenance = normalizedCodeProvenance(facadeCodeResult);
  if (expertCodeProvenance.length === 0) {
    throw new Error("Expert Code Graph task returned no provenance.");
  }
  assert.deepEqual(
    facadeCodeProvenance,
    expertCodeProvenance,
    "akp_context CODE must preserve expert Code Graph provenance",
  );
  const context = await client.callTool({
    name: "akp_build_context",
    arguments: {
      query: "dependency inversion architecture",
      spaceId,
      vaultIds: [vaultId],
      federated: false,
      limit: 3,
    },
  });
  const contextPayload = structuredToolResult(context);
  const contextBudget = contextPayload.budget as
    Record<string, unknown> | undefined;
  if (
    contextPayload.packetMode !== "COMPACT_AGENT_PACKET" ||
    !contextPayload.identity ||
    typeof contextPayload.identity !== "object" ||
    !contextBudget ||
    typeof contextBudget.maxTokens !== "number" ||
    typeof contextBudget.serializedTokens !== "number" ||
    contextBudget.serializedTokens > contextBudget.maxTokens
  ) {
    throw new Error(
      `Unexpected MCP compact context payload: ${JSON.stringify(contextPayload)}`,
    );
  }
  console.log(
    JSON.stringify(
      {
        result: "PASSED",
        toolCount: tools.tools.length,
        requiredTools: required.length,
        instructionResource: instructionResource.uri,
        instructionDigest: instructionBundle.manifest?.sha256,
        platformStatus: statusPayload.status,
        principalKind: identityRecord.principalKind,
        authenticationKind: identityRecord.authenticationKind,
        visibleVaultCount: vaults.length,
        scopedVaultId: vaultId,
        searchHitCount: searchPayload.hits.length,
        facadeSearchHitCount: facadeSearchResult.hits.length,
        agentContextExitEvidence: {
          knowledgeTask: {
            status: "PROVEN",
            facadeAction: "SEARCH",
            delegatedTo: "akp_search",
            provenanceEquivalent: true,
            provenanceItems: normalizedSearchProvenance(searchPayload).length,
          },
          codingTask: {
            status: "PROVEN",
            facadeAction: "CODE",
            delegatedTo: "akp_find_code_symbol",
            provenanceEquivalent: true,
            provenanceItems: expertCodeProvenance.length,
            repository: codeRepository,
            commitSha: codeCommit,
          },
        },
        contextPacketMode: contextPayload.packetMode,
        contextSerializedTokens: contextBudget.serializedTokens,
        contextMaxTokens: contextBudget.maxTokens,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
  await agentContextDb?.close();
}
