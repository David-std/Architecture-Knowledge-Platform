import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Postgres, grantVaultMembership, registerVault } from "@akp/postgres";

const spaceId = "00000000-0000-0000-0000-000000000003";
const adminId = "00000000-0000-0000-0000-000000000002";
const viewerId = randomUUID();
const token = `operator-${randomUUID()}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const headers = { authorization: `Bearer ${token}` };

let app: FastifyInstance;
let db: Postgres;
let allowedVaultId: string;
let deniedVaultId: string;
let allowedSourceId: string;
let deniedSourceId: string;
let allowedJobId: string;
let deniedJobId: string;
let allowedNodeA: string;
let allowedNodeB: string;
let deniedNode: string;
let allowedProjectionId: string;
let deniedProjectionId: string;
let allowedFederatedA: string;
let allowedFederatedB: string;
let deniedFederatedNode: string;
let allowedFederatedEdge: string;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests.");
  }
  process.env.NODE_ENV = "test";
  db = new Postgres(process.env.DATABASE_URL);

  await db.pool.query(
    `insert into users(id,email,display_name)
     values($1,$2,'operator viewer')
     on conflict(id) do nothing`,
    [viewerId, `operator-${viewerId}@localhost`],
  );
  await db.pool.query(
    `insert into memberships(user_id,space_id,role,path_prefix)
     values($1,$2,'VIEWER',null)
     on conflict do nothing`,
    [viewerId, spaceId],
  );
  await db.pool.query(
    `insert into api_tokens(user_id,token_hash,label,scopes)
     values($1,$2,'operator integration',$3::jsonb)`,
    [
      viewerId,
      tokenHash,
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

  const allowedVault = await registerVault(
    db,
    {
      vaultKey: `operator-allowed-${randomUUID().slice(0, 8)}`,
      name: "allowed operator vault",
      spaceId,
      visibility: "PRIVATE",
      gitRepository: null,
      defaultBranch: "main",
      localPath: path.join(tmpdir(), `operator-allowed-${randomUUID()}`),
      contentRoots: ["."],
      sourceRoots: [],
      schemaProfile: {},
      evalPack: {
        name: "generic",
        version: "1",
        enabled: true,
        criticalCases: [],
      },
      retrievalConfig: {},
      permissions: {},
      enabled: true,
    },
    { ownerUserId: adminId },
  );
  allowedVaultId = allowedVault.id;
  const deniedVault = await registerVault(
    db,
    {
      vaultKey: `operator-denied-${randomUUID().slice(0, 8)}`,
      name: "denied operator vault",
      spaceId,
      visibility: "PRIVATE",
      gitRepository: null,
      defaultBranch: "main",
      localPath: path.join(tmpdir(), `operator-denied-${randomUUID()}`),
      contentRoots: ["."],
      sourceRoots: [],
      schemaProfile: {},
      evalPack: {
        name: "generic",
        version: "1",
        enabled: true,
        criticalCases: [],
      },
      retrievalConfig: {},
      permissions: {},
      enabled: true,
    },
    { ownerUserId: adminId },
  );
  deniedVaultId = deniedVault.id;

  await grantVaultMembership(db, {
    userId: viewerId,
    vaultId: allowedVaultId,
    role: "VIEWER",
    permissions: ["knowledge:read", "source:read"],
  });

  const allowedSource = await db.pool.query<{ id: string }>(
    `insert into sources(
       space_id,vault_id,title,source_uri,media_type,sha256,byte_size,object_key,metadata,created_by
     ) values($1,$2,'Visible source','/tmp/p6/private/source.pdf','application/pdf',$3,1234,
              'raw/private/object', $4::jsonb,$5)
     returning id`,
    [
      spaceId,
      allowedVaultId,
      createHash("sha256").update(`allowed-${viewerId}`).digest("hex"),
      JSON.stringify({
        note: "operator copied from /tmp/p6/private/source.pdf",
        password: "never-return-this-password",
        nested: { api_key: "never-return-this-key", safe: "visible" },
      }),
      adminId,
    ],
  );
  allowedSourceId = allowedSource.rows[0]!.id;
  const deniedSource = await db.pool.query<{ id: string }>(
    `insert into sources(
       space_id,vault_id,title,source_uri,media_type,sha256,byte_size,object_key,metadata,created_by
     ) values($1,$2,'Invisible source','/tmp/p6/denied/source.pdf','application/pdf',$3,10,
              'raw/denied/object','{}'::jsonb,$4)
     returning id`,
    [
      spaceId,
      deniedVaultId,
      createHash("sha256").update(`denied-${viewerId}`).digest("hex"),
      adminId,
    ],
  );
  deniedSourceId = deniedSource.rows[0]!.id;

  const job = await db.pool.query<{ id: string }>(
    `insert into ingest_jobs(
       space_id,vault_id,source_uri,state,payload,stage_outputs,created_by
     ) values($1,$2,'/tmp/p6/private/job.pdf','NORMALIZING',$3::jsonb,$4::jsonb,$5)
     returning id`,
    [
      spaceId,
      allowedVaultId,
      JSON.stringify({
        sourceUri: "/tmp/p6/private/job.pdf",
        password: "payload-secret",
      }),
      JSON.stringify({
        providerTasks: {
          chunkr: {
            taskId: "task-visible-123",
            status: "Processing",
            mode: "oss",
          },
        },
      }),
      adminId,
    ],
  );
  allowedJobId = job.rows[0]!.id;
  const deniedJob = await db.pool.query<{ id: string }>(
    `insert into ingest_jobs(
       space_id,vault_id,source_uri,state,payload,stage_outputs,created_by
     ) values($1,$2,'/tmp/p6/denied/job.pdf','NORMALIZING','{}'::jsonb,'{}'::jsonb,$3)
     returning id`,
    [spaceId, deniedVaultId, adminId],
  );
  deniedJobId = deniedJob.rows[0]!.id;
  await db.pool.query(
    `insert into ingest_job_events(job_id,state,event_type,payload)
     values($1,'NORMALIZING','PROVIDER_TASK_STATE',$2::jsonb)`,
    [
      allowedJobId,
      JSON.stringify({
        provider: "chunkr",
        taskId: "task-visible-123",
        status: "Processing",
        endpoint: "https://provider.invalid/private",
        token: "event-secret-token",
      }),
    ],
  );

  allowedNodeA = randomUUID();
  allowedNodeB = randomUUID();
  deniedNode = randomUUID();
  await db.pool.query(
    `insert into knowledge_documents(
       id,space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,current_revision,
       body_cache,frontmatter,aliases,layer,raw_links
     ) values
       ($1,$4,$5,'operator/a.md','OP-A','Allowed A','concept','ACTIVE','HUMAN_REVIEWED','operator-r1','A','{}','{}','compiled','[]'),
       ($2,$4,$5,'operator/b.md','OP-B','Allowed B','decision','ACTIVE','MACHINE_SUPPORTED','operator-r1','B','{}','{}','compiled','[]'),
       ($3,$4,$6,'operator/denied.md','OP-DENIED','Denied node','concept','ACTIVE','ATTESTED','operator-r1','D','{}','{}','compiled','[]')`,
    [
      allowedNodeA,
      allowedNodeB,
      deniedNode,
      spaceId,
      allowedVaultId,
      deniedVaultId,
    ],
  );
  await db.pool.query(
    `insert into knowledge_relations(
       space_id,from_document_id,to_document_id,relation_type,weight,provenance
     ) values
       ($1,$2,$3,'supports',1,'operator-test'),
       ($1,$2,$4,'related_to',1,'operator-cross-vault-test')`,
    [spaceId, allowedNodeA, allowedNodeB, deniedNode],
  );

  allowedProjectionId = randomUUID();
  deniedProjectionId = randomUUID();
  allowedFederatedA = randomUUID();
  allowedFederatedB = randomUUID();
  deniedFederatedNode = randomUUID();
  allowedFederatedEdge = randomUUID();
  const codeRevision = "code-context-r1";
  const sourceRevision = "a".repeat(40);

  await db.pool.query(
    `insert into federated_graph_projection_revisions(
       id,space_id,vault_id,graph_domain,scope_id,revision,source_revision,
       provider,configuration_version,lifecycle,freshness,built_at,activated_at,
       last_successful_update
     ) values
       ($1,$3,$4,'CODE','repo:allowed',$6,$7,'fixture','code-context-test',
        'ACTIVE','FRESH',now(),now(),now()),
       ($2,$3,$5,'CODE','repo:denied',$6,$7,'fixture','code-context-test',
        'ACTIVE','FRESH',now(),now(),now())`,
    [
      allowedProjectionId,
      deniedProjectionId,
      spaceId,
      allowedVaultId,
      deniedVaultId,
      codeRevision,
      sourceRevision,
    ],
  );

  await db.pool.query(
    `insert into federated_graph_nodes(
       id,space_id,vault_id,graph_domain,scope_id,kind,canonical_key,revision,
       authorization_path,payload,payload_hash
     ) values
       ($1,$4,$5,'CODE','repo:allowed','FUNCTION','src/a.ts::a',$7,
        'projects/allowed/src/a.ts',$8::jsonb,$9),
       ($2,$4,$5,'CODE','repo:allowed','FUNCTION','src/b.ts::b',$7,
        'projects/allowed/src/b.ts',$10::jsonb,$11),
       ($3,$4,$6,'CODE','repo:denied','FUNCTION','secret.ts::hidden',$7,
        'projects/denied/secret.ts',$12::jsonb,$13)`,
    [
      allowedFederatedA,
      allowedFederatedB,
      deniedFederatedNode,
      spaceId,
      allowedVaultId,
      deniedVaultId,
      codeRevision,
      JSON.stringify({ title: "Function A", path: "src/a.ts", lineStart: 10 }),
      createHash("sha256").update("federation-a").digest("hex"),
      JSON.stringify({ title: "Function B", path: "src/b.ts", lineStart: 20 }),
      createHash("sha256").update("federation-b").digest("hex"),
      JSON.stringify({ title: "Hidden", path: "secret.ts", lineStart: 1 }),
      createHash("sha256").update("federation-hidden").digest("hex"),
    ],
  );

  await db.pool.query(
    `insert into federated_graph_projection_nodes(
       projection_revision_id,node_id
     ) values($1,$2),($1,$3),($4,$5)`,
    [
      allowedProjectionId,
      allowedFederatedA,
      allowedFederatedB,
      deniedProjectionId,
      deniedFederatedNode,
    ],
  );

  await db.pool.query(
    `insert into federated_graph_edges(
       id,space_id,owner_graph_domain,from_node_id,to_node_id,relation_type,
       derivation,source_ids,evidence_ids,locator_refs,provenance_revision,
       confidence,valid_from,valid_to,recorded_at,provenance_hash
     ) values(
       $1,$2,'CODE',$3,$4,'CALLS','STATICALLY_RESOLVED',
       '[]'::jsonb,'[]'::jsonb,$5::jsonb,$6,0.95,
       '2026-01-01T00:00:00Z','2030-01-01T00:00:00Z',now(),$7
     )`,
    [
      allowedFederatedEdge,
      spaceId,
      allowedFederatedA,
      allowedFederatedB,
      JSON.stringify([{ path: "src/a.ts", startLine: 10, endLine: 10 }]),
      codeRevision,
      createHash("sha256").update("federation-edge").digest("hex"),
    ],
  );
  await db.pool.query(
    `insert into federated_graph_projection_edges(
       projection_revision_id,edge_id
     ) values($1,$2)`,
    [allowedProjectionId, allowedFederatedEdge],
  );

  const module = await import("../src/server.js");
  app = module.buildServer();
});

afterAll(async () => {
  if (app) await app.close();
  if (!db) return;
  await db.pool.query(
    "delete from federated_graph_projection_revisions where id=any($1::uuid[])",
    [[allowedProjectionId, deniedProjectionId]],
  );
  await db.pool.query("delete from federated_graph_edges where id=$1", [
    allowedFederatedEdge,
  ]);
  await db.pool.query(
    "delete from federated_graph_nodes where id=any($1::uuid[])",
    [[allowedFederatedA, allowedFederatedB, deniedFederatedNode]],
  );
  await db.pool.query(
    "delete from knowledge_relations where provenance in ('operator-test','operator-cross-vault-test')",
  );
  await db.pool.query(
    "delete from knowledge_documents where id=any($1::uuid[])",
    [[allowedNodeA, allowedNodeB, deniedNode]],
  );
  await db.pool.query(
    "delete from ingest_job_events where job_id=any($1::uuid[])",
    [[allowedJobId, deniedJobId]],
  );
  await db.pool.query("delete from ingest_jobs where id=any($1::uuid[])", [
    [allowedJobId, deniedJobId],
  ]);
  await db.pool.query("delete from sources where id=any($1::uuid[])", [
    [allowedSourceId, deniedSourceId],
  ]);
  await db.pool.query("delete from api_tokens where token_hash=$1", [
    tokenHash,
  ]);
  await db.pool.query("delete from vault_memberships where user_id=$1", [
    viewerId,
  ]);
  await db.pool.query(
    "delete from vault_memberships where vault_id=any($1::uuid[])",
    [[allowedVaultId, deniedVaultId]],
  );
  await db.pool.query("delete from vaults where id=any($1::uuid[])", [
    [allowedVaultId, deniedVaultId],
  ]);
  await db.pool.query("delete from memberships where user_id=$1", [viewerId]);
  await db.pool.query("delete from users where id=$1", [viewerId]);
  await db.close();
});

describe("operator projections", () => {
  it("keeps multi-layer graph data inside the authorized vault and honors as_of", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/operator/graph?vaultId=${allowedVaultId}`,
      headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      asOf: string | null;
      nodes: Array<{
        id: string;
        entityId: string;
        vault_id: string;
        graph_domain: string;
      }>;
      edges: Array<{
        id: string;
        from: string;
        to: string;
        type: string;
        derivation?: string | null;
        confidence?: number | null;
      }>;
      byLayer: Array<{ graph_domain: string; nodes: number }>;
    };
    const ids = new Set(body.nodes.map((node) => node.id));
    expect(ids.has(`knowledge:${allowedNodeA}`)).toBe(true);
    expect(ids.has(`knowledge:${allowedNodeB}`)).toBe(true);
    expect(ids.has(`knowledge:${deniedNode}`)).toBe(false);
    expect(ids.has(`federated:${allowedFederatedA}`)).toBe(true);
    expect(ids.has(`federated:${allowedFederatedB}`)).toBe(true);
    expect(ids.has(`federated:${deniedFederatedNode}`)).toBe(false);
    expect(body.nodes.every((node) => node.vault_id === allowedVaultId)).toBe(
      true,
    );
    expect(body.byLayer).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ graph_domain: "EPISTEMIC" }),
        expect.objectContaining({ graph_domain: "CODE" }),
      ]),
    );
    expect(body.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: `knowledge:${allowedNodeA}`,
          to: `knowledge:${allowedNodeB}`,
          type: "supports",
        }),
        expect.objectContaining({
          from: `federated:${allowedFederatedA}`,
          to: `federated:${allowedFederatedB}`,
          type: "CALLS",
          derivation: "STATICALLY_RESOLVED",
          confidence: 0.95,
        }),
      ]),
    );
    expect(
      body.edges.some((edge) => edge.to === `knowledge:${deniedNode}`),
    ).toBe(false);

    const historical = await app.inject({
      method: "GET",
      url:
        `/v1/operator/graph?vaultId=${allowedVaultId}` +
        "&asOf=2025-01-01T00%3A00%3A00.000Z",
      headers,
    });
    expect(historical.statusCode, historical.body).toBe(200);
    const historicalBody = historical.json() as {
      edges: Array<{ id: string }>;
    };
    expect(
      historicalBody.edges.some(
        (edge) => edge.id === `federated-edge:${allowedFederatedEdge}`,
      ),
    ).toBe(false);
  });

  it("makes an unauthorized private vault indistinguishable from missing", async () => {
    const [source, job, graph] = await Promise.all([
      app.inject({
        method: "GET",
        url: `/v1/operator/sources/${deniedSourceId}`,
        headers,
      }),
      app.inject({
        method: "GET",
        url: `/v1/operator/jobs/${deniedJobId}`,
        headers,
      }),
      app.inject({
        method: "GET",
        url: `/v1/operator/graph?vaultId=${deniedVaultId}`,
        headers,
      }),
    ]);
    expect(source.statusCode).toBe(404);
    expect(job.statusCode).toBe(404);
    expect(graph.statusCode).toBe(404);
  });

  it("redacts operational paths and sensitive source metadata", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/operator/sources/${allowedSourceId}`,
      headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    const serialized = JSON.stringify(response.json());
    expect(serialized).not.toContain("never-return-this-password");
    expect(serialized).not.toContain("never-return-this-key");
    expect(serialized).not.toContain("/tmp/p6/private/source.pdf");
    expect(serialized).toContain("[REDACTED_PATH]");
    expect(serialized).toContain("visible");
  });

  it("shows durable provider task state but redacts event credentials and endpoints", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/operator/jobs/${allowedJobId}`,
      headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      providerTasks: Record<string, { taskId?: string; status?: string }>;
      events: Array<{ payload?: Record<string, unknown> }>;
    };
    expect(body.providerTasks.chunkr).toMatchObject({
      taskId: "task-visible-123",
      status: "Processing",
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("event-secret-token");
    expect(serialized).not.toContain("provider.invalid");
    expect(serialized).not.toContain("/tmp/p6/private/job.pdf");
  });
});
