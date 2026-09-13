import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Postgres,
  grantVaultMembership,
  registerVault,
} from "@akp/postgres";

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

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests.");
  }
  process.env.NODE_ENV = "test";
  db = new Postgres(process.env.DATABASE_URL);

  await db.pool.query(
    `insert into users(id,email,display_name)
     values($1,$2,'P6 operator viewer')
     on conflict(id) do nothing`,
    [viewerId, `p6-${viewerId}@localhost`],
  );
  await db.pool.query(
    `insert into memberships(user_id,space_id,role,path_prefix)
     values($1,$2,'VIEWER',null)
     on conflict do nothing`,
    [viewerId, spaceId],
  );
  await db.pool.query(
    `insert into api_tokens(user_id,token_hash,label,scopes)
     values($1,$2,'P6 operator integration',$3::jsonb)`,
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
      vaultKey: `p6-allowed-${randomUUID().slice(0, 8)}`,
      name: "P6 allowed vault",
      spaceId,
      visibility: "PRIVATE",
      gitRepository: null,
      defaultBranch: "main",
      localPath: path.join(tmpdir(), `p6-allowed-${randomUUID()}`),
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
      vaultKey: `p6-denied-${randomUUID().slice(0, 8)}`,
      name: "P6 denied vault",
      spaceId,
      visibility: "PRIVATE",
      gitRepository: null,
      defaultBranch: "main",
      localPath: path.join(tmpdir(), `p6-denied-${randomUUID()}`),
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
      JSON.stringify({ sourceUri: "/tmp/p6/private/job.pdf", password: "payload-secret" }),
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
       ($1,$4,$5,'p6/a.md','P6-A','Allowed A','concept','ACTIVE','HUMAN_REVIEWED','p6-r1','A','{}','{}','compiled','[]'),
       ($2,$4,$5,'p6/b.md','P6-B','Allowed B','decision','ACTIVE','MACHINE_SUPPORTED','p6-r1','B','{}','{}','compiled','[]'),
       ($3,$4,$6,'p6/denied.md','P6-DENIED','Denied node','concept','ACTIVE','ATTESTED','p6-r1','D','{}','{}','compiled','[]')`,
    [allowedNodeA, allowedNodeB, deniedNode, spaceId, allowedVaultId, deniedVaultId],
  );
  await db.pool.query(
    `insert into knowledge_relations(
       space_id,from_document_id,to_document_id,relation_type,weight,provenance
     ) values
       ($1,$2,$3,'supports',1,'p6-test'),
       ($1,$2,$4,'related_to',1,'p6-cross-vault-test')`,
    [spaceId, allowedNodeA, allowedNodeB, deniedNode],
  );

  const module = await import("../src/server.js");
  app = module.buildServer();
});

afterAll(async () => {
  if (app) await app.close();
  if (!db) return;
  await db.pool.query(
    "delete from knowledge_relations where provenance in ('p6-test','p6-cross-vault-test')",
  );
  await db.pool.query("delete from knowledge_documents where id=any($1::uuid[])", [
    [allowedNodeA, allowedNodeB, deniedNode],
  ]);
  await db.pool.query("delete from ingest_job_events where job_id=any($1::uuid[])", [
    [allowedJobId, deniedJobId],
  ]);
  await db.pool.query("delete from ingest_jobs where id=any($1::uuid[])", [
    [allowedJobId, deniedJobId],
  ]);
  await db.pool.query("delete from sources where id=any($1::uuid[])", [
    [allowedSourceId, deniedSourceId],
  ]);
  await db.pool.query("delete from api_tokens where token_hash=$1", [tokenHash]);
  await db.pool.query("delete from vault_memberships where user_id=$1", [viewerId]);
  await db.pool.query("delete from vault_memberships where vault_id=any($1::uuid[])", [
    [allowedVaultId, deniedVaultId],
  ]);
  await db.pool.query("delete from vaults where id=any($1::uuid[])", [
    [allowedVaultId, deniedVaultId],
  ]);
  await db.pool.query("delete from memberships where user_id=$1", [viewerId]);
  await db.pool.query("delete from users where id=$1", [viewerId]);
  await db.close();
});

describe("P6 operator projections", () => {
  it("keeps graph nodes and edges inside the authorized vault", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/operator/graph?vaultId=${allowedVaultId}`,
      headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      nodes: Array<{ id: string; vault_id: string }>;
      edges: Array<{ from: string; to: string }>;
    };
    const ids = new Set(body.nodes.map((node) => node.id));
    expect(ids.has(allowedNodeA)).toBe(true);
    expect(ids.has(allowedNodeB)).toBe(true);
    expect(ids.has(deniedNode)).toBe(false);
    expect(body.nodes.every((node) => node.vault_id === allowedVaultId)).toBe(true);
    expect(body.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: allowedNodeA, to: allowedNodeB }),
      ]),
    );
    expect(body.edges.some((edge) => edge.to === deniedNode)).toBe(false);
  });

  it("makes an unauthorized private vault indistinguishable from missing", async () => {
    const [source, job, graph] = await Promise.all([
      app.inject({ method: "GET", url: `/v1/operator/sources/${deniedSourceId}`, headers }),
      app.inject({ method: "GET", url: `/v1/operator/jobs/${deniedJobId}`, headers }),
      app.inject({ method: "GET", url: `/v1/operator/graph?vaultId=${deniedVaultId}`, headers }),
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
