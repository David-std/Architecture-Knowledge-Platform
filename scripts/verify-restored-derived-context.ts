import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GraphifyCodeGraphAdapter,
  createCodeSnapshot,
  defaultCodeGraphOptions,
  planCodeGraphProjection,
} from "../packages/project-adapter/src/index.js";
import {
  Postgres,
  PostgresFederatedGraphStore,
  grantVaultMembership,
} from "../packages/postgres/src/index.js";
import type { GraphProjectionArtifact } from "@akp/contracts";

const values = new Map(
  process.argv.slice(2).map((value) => {
    const [key, ...rest] = value.split("=");
    return [key, rest.join("=")] as const;
  }),
);
const repositoryPath = values.get("--repo");
const commit = values.get("--commit");
const spaceId = values.get("--space-id");
const vaultId = values.get("--vault-id");
if (!repositoryPath || !commit || !spaceId || !vaultId) {
  throw new Error("--repo, --commit, --space-id and --vault-id are required.");
}
const databaseUrl = process.env.DATABASE_URL;
const graphifyExecutable = process.env.AKP_GRAPHIFY_EXECUTABLE;
if (!databaseUrl || !graphifyExecutable) {
  throw new Error("DATABASE_URL and AKP_GRAPHIFY_EXECUTABLE are required.");
}
const outputPath = path.resolve(
  process.env.AKP_RESTORED_DERIVED_REPORT ??
    "reports/ci/restored-derived-context.json",
);
const adminUserId = "00000000-0000-0000-0000-000000000002";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const db = new Postgres(databaseUrl);
try {
  const documents = await db.pool.query<{
    id: string;
    external_id: string | null;
    title: string;
    type: string;
    path: string;
    current_revision: string;
  }>(
    `select id,external_id,title,type,path,current_revision
       from knowledge_documents
      where vault_id=$1 and lifecycle='ACTIVE'
      order by path,id`,
    [vaultId],
  );
  if (documents.rows.length === 0) {
    throw new Error("RESTORED_GRAPH_SOURCE_DOCUMENTS_MISSING");
  }

  const epistemicScope = `recovery:epistemic:${vaultId}`;
  const epistemicRevision = `${commit}:epistemic-rebuild-v1`;
  const epistemic: GraphProjectionArtifact = {
    graphDomain: "EPISTEMIC",
    spaceId,
    vaultId,
    scopeId: epistemicScope,
    revision: epistemicRevision,
    sourceRevision: commit,
    sourceHash: sha256(JSON.stringify(documents.rows)),
    provider: "akp-restored-knowledge-projection",
    providerVersion: "1",
    configurationVersion: "recovery-v1",
    nodes: documents.rows.map((document) => ({
      identity: {
        graphDomain: "EPISTEMIC",
        scopeId: epistemicScope,
        kind: "DOCUMENT",
        canonicalKey: document.id,
        revision: epistemicRevision,
      },
      vaultId,
      authorizationPath: document.path,
      payload: {
        documentId: document.id,
        externalId: document.external_id,
        title: document.title,
        type: document.type,
        revision: document.current_revision,
        path: document.path,
      },
    })),
    edges: [],
  };
  const graphStore = new PostgresFederatedGraphStore(db);
  const epistemicActive = await graphStore.build(epistemic);
  if (
    epistemicActive.lifecycle !== "ACTIVE" ||
    epistemicActive.freshness !== "FRESH"
  ) {
    throw new Error("RESTORED_EPISTEMIC_GRAPH_NOT_ACTIVE");
  }

  const snapshot = await createCodeSnapshot({ repositoryPath, commit });
  const adapter = new GraphifyCodeGraphAdapter({
    executable: graphifyExecutable,
    incremental: false,
  });
  const artifact = await adapter.analyze(snapshot, {
    ...defaultCodeGraphOptions(),
    timeoutMs: 180000,
  });
  if (
    artifact.provider !== "graphify" ||
    artifact.providerVersion !== "0.9.63" ||
    artifact.nodes.length === 0 ||
    artifact.edges.length === 0
  ) {
    throw new Error("RESTORED_CODE_GRAPH_ARTIFACT_INCOMPLETE");
  }
  const codeScope = `recovery:code:${vaultId}`;
  const codePlan = planCodeGraphProjection({
    artifact,
    spaceId,
    vaultId,
    scopeId: codeScope,
  });
  const codeActive = await graphStore.build(codePlan.projection);
  if (codeActive.lifecycle !== "ACTIVE" || codeActive.freshness !== "FRESH") {
    throw new Error("RESTORED_CODE_GRAPH_NOT_ACTIVE");
  }

  const graphCounts = await db.pool.query<{
    graph_domain: string;
    nodes: number;
    edges: number;
  }>(
    `select r.graph_domain,
            count(distinct pn.node_id)::int nodes,
            count(distinct pe.edge_id)::int edges
       from federated_graph_projection_revisions r
       left join federated_graph_projection_nodes pn
         on pn.projection_revision_id=r.id
       left join federated_graph_projection_edges pe
         on pe.projection_revision_id=r.id
      where r.space_id=$1 and r.vault_id=$2
        and r.lifecycle='ACTIVE'
        and r.scope_id=any($3::text[])
      group by r.graph_domain`,
    [spaceId, vaultId, [epistemicScope, codeScope]],
  );
  const byDomain = new Map(
    graphCounts.rows.map((row) => [row.graph_domain, row]),
  );
  if ((byDomain.get("EPISTEMIC")?.nodes ?? 0) < 1) {
    throw new Error("RESTORED_EPISTEMIC_GRAPH_HAS_NO_NODES");
  }
  if (
    (byDomain.get("CODE")?.nodes ?? 0) < 1 ||
    (byDomain.get("CODE")?.edges ?? 0) < 1
  ) {
    throw new Error("RESTORED_CODE_GRAPH_HAS_NO_STRUCTURE");
  }

  await grantVaultMembership(db, {
    userId: adminUserId,
    vaultId,
    role: "VIEWER",
    pathPrefix: null,
    permissions: ["knowledge:read", "source:read"],
  });
  const token = `recovery-agent-context-${randomUUID()}`;
  await db.pool.query(
    `insert into api_tokens(user_id,token_hash,label,scopes)
     values($1,$2,'recovery agent context proof',$3::jsonb)`,
    [
      adminUserId,
      sha256(token),
      JSON.stringify({
        spaces: [
          {
            spaceId,
            pathPrefix: null,
            permissions: ["knowledge:read", "source:read"],
          },
        ],
      }),
    ],
  );

  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = databaseUrl;
  const { buildServer } = await import("../apps/api/src/server.js");
  const app = buildServer();
  let contextStatus = 0;
  let contextSections = 0;
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/context",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        query: "restore probe searchable recovery",
        intent: "EXACT_LOOKUP",
        spaceId,
        vaultId,
        vaultIds: [vaultId],
        federated: false,
        mode: "SOURCE_BACKED",
        maxTokens: 2048,
        packetMode: "COMPACT_AGENT_PACKET",
      },
    });
    contextStatus = response.statusCode;
    if (response.statusCode !== 200) {
      throw new Error(
        `RESTORED_AGENT_CONTEXT_FAILED:${response.statusCode}:${response.body.slice(0, 500)}`,
      );
    }
    const body = response.json() as Record<string, unknown>;
    const sections = Array.isArray(body.content)
      ? body.content
      : Array.isArray(body.sections)
        ? body.sections
        : [];
    contextSections = sections.length;
    if (contextSections < 1) {
      throw new Error("RESTORED_AGENT_CONTEXT_EMPTY");
    }
    const serialized = JSON.stringify(sections).toLowerCase();
    if (!serialized.includes("restore")) {
      throw new Error("RESTORED_AGENT_CONTEXT_MISSING_PROBE");
    }
  } finally {
    await app.close();
  }

  const report = {
    schemaVersion: 1,
    evidenceLevel: "RESTORED_DERIVED_PROJECTIONS_AND_AGENT_CONTEXT",
    status: "PROVEN",
    source: {
      repositoryPath,
      commit,
      spaceId,
      vaultId,
      restoredDocuments: documents.rows.length,
    },
    epistemicGraph: {
      status: "PROVEN",
      lifecycle: epistemicActive.lifecycle,
      freshness: epistemicActive.freshness,
      nodes: byDomain.get("EPISTEMIC")?.nodes ?? 0,
      edges: byDomain.get("EPISTEMIC")?.edges ?? 0,
    },
    codeGraph: {
      status: "PROVEN",
      provider: artifact.provider,
      providerVersion: artifact.providerVersion,
      lifecycle: codeActive.lifecycle,
      freshness: codeActive.freshness,
      nodes: byDomain.get("CODE")?.nodes ?? 0,
      edges: byDomain.get("CODE")?.edges ?? 0,
      skippedCandidateEdges: codePlan.skippedCandidateEdgeIds.length,
    },
    agentContext: {
      status: "PROVEN",
      externalProviderRequired: false,
      httpStatus: contextStatus,
      sections: contextSections,
    },
    limitations: [
      "Recovery uses a bounded CI repository fixture; it proves rebuild mechanics and authority separation, not production recovery-time SLOs.",
    ],
    generatedAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await db.close();
}
