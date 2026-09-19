import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { CodeGraphArtifact } from "@akp/contracts";
import {
  Postgres,
  PostgresFederatedGraphStore,
  grantVaultMembership,
} from "@akp/postgres";
import {
  planCodeGraphProjection,
  projectCodeGraphIdentity,
} from "@akp/project-adapter";

const spaceId = "00000000-0000-0000-0000-000000000003";
const vaultId = randomUUID();
const actorId = randomUUID();
const projectId = randomUUID();
const documentId = randomUUID();
const reviewId = randomUUID();
const token = `code-link-${randomUUID()}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const headers = {
  authorization: `Bearer ${token}`,
  "idempotency-key": "code-link-approval-1",
};
const slug = "payments-link";
const commitSha = "7".repeat(40);
const documentPath = "20-decisions/payments-rule.md";
let app: FastifyInstance;
let db: Postgres;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  process.env.NODE_ENV = "test";
  db = new Postgres(process.env.DATABASE_URL);

  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,vault_key,
       local_path,visibility,enabled
     ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)`,
    [
      vaultId,
      spaceId,
      `/tmp/code-link-${vaultId}`,
      "Code link test vault",
      commitSha,
      `code-link-${vaultId.slice(0, 8)}`,
    ],
  );
  await db.pool.query(
    "insert into users(id,email,display_name) values($1,$2,'Code Link Reviewer')",
    [actorId, `${actorId}@example.test`],
  );
  await db.pool.query(
    "insert into memberships(user_id,space_id,role,path_prefix) values($1,$2,'ARCHITECT',null)",
    [actorId, spaceId],
  );
  await grantVaultMembership(db, {
    userId: actorId,
    vaultId,
    role: "ARCHITECT",
    pathPrefix: null,
    permissions: ["knowledge:read", "knowledge:review"],
  });
  await db.pool.query(
    "insert into api_tokens(user_id,token_hash,label,scopes) values($1,$2,'code link reviewer',$3::jsonb)",
    [
      actorId,
      tokenHash,
      JSON.stringify({
        spaces: [
          {
            spaceId,
            pathPrefix: null,
            permissions: ["knowledge:read", "knowledge:review"],
          },
        ],
      }),
    ],
  );

  const identity = projectCodeGraphIdentity(vaultId, slug);
  await db.pool.query(
    `insert into projects(id,space_id,vault_id,slug,root_path,metadata)
     values($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      projectId,
      spaceId,
      vaultId,
      slug,
      `/tmp/code-link-project-${projectId}`,
      JSON.stringify({
        commit: commitSha,
        codeGraph: {
          ...identity,
          sourceRevision: commitSha,
          status: "ACTIVE",
        },
      }),
    ],
  );
  await db.pool.query(
    `insert into knowledge_documents(
       id,space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,
       current_revision,body_cache,frontmatter,aliases,layer,content_hash,
       token_estimate,raw_links
     ) values(
       $1,$2,$3,$4,$5,$6,'decision','ACTIVE','HUMAN_REVIEWED',
       $7,$8,'{}'::jsonb,'{}','decision',$9,32,'[]'::jsonb
     )`,
    [
      documentId,
      spaceId,
      vaultId,
      documentPath,
      `DEC-${documentId.slice(0, 8)}`,
      "Payments retry decision",
      commitSha,
      "Payments retries must use the reviewed helper.",
      createHash("sha256").update("payments decision").digest("hex"),
    ],
  );
  await db.pool.query(
    `insert into reviews(
       id,space_id,vault_id,branch_name,base_commit,head_commit,status,author_id,
       impact_manifest,validation_report,merged_commit
     ) values($1,$2,$3,$4,$5,$5,'APPROVED',$6,$7::jsonb,'{}'::jsonb,$5)`,
    [
      reviewId,
      spaceId,
      vaultId,
      `review/${reviewId}`,
      commitSha,
      actorId,
      JSON.stringify({
        proposedChanges: [{ path: documentPath, operation: "UPDATE" }],
      }),
    ],
  );

  const artifact: CodeGraphArtifact = {
    schemaVersion: 1,
    repository: identity.repository,
    commitSha,
    provider: "integration-fixture",
    providerVersion: "1",
    configurationHash: "8".repeat(64),
    generatedAt: "2026-09-18T00:00:00.000Z",
    languages: ["TypeScript"],
    nodes: [
      {
        id: "function:retryPayment",
        kind: "FUNCTION",
        name: "retryPayment",
        qualifiedName: "retryPayment",
        path: "src/payments.ts",
        lineStart: 4,
        lineEnd: 8,
      },
    ],
    edges: [],
    warnings: [],
  };
  await new PostgresFederatedGraphStore(db).build(
    planCodeGraphProjection({
      artifact,
      spaceId,
      vaultId,
      scopeId: identity.scopeId,
      authorizationPathPrefix: identity.authorizationPathPrefix,
    }).projection,
  );

  const module = await import("../src/server.js");
  app = module.buildServer();
});

afterAll(async () => {
  if (app) await app.close();
  if (db) {
    await db.pool.query("delete from api_tokens where token_hash=$1", [
      tokenHash,
    ]);
    await db.pool.query(
      "delete from memberships where user_id=$1 and space_id=$2",
      [actorId, spaceId],
    );
    await db.pool.query("update vaults set enabled=false where id=$1", [
      vaultId,
    ]);
    await db.close();
  }
});

describe("reviewed knowledge-to-code mapping", () => {
  it("persists one human-approved mapping and durable projection request", async () => {
    const identity = projectCodeGraphIdentity(vaultId, slug);
    const payload = {
      projectId,
      documentId,
      reviewId,
      relationType: "rationale_ref",
      selector: {
        path: "src/payments.ts",
        qualifiedName: "retryPayment",
      },
    };
    const first = await app.inject({
      method: "POST",
      url: "/v1/code/knowledge-links",
      headers,
      payload,
    });
    expect(first.statusCode, first.body).toBe(202);
    expect(first.json()).toMatchObject({
      projectionStatus: "REQUESTED",
      link: {
        project_id: projectId,
        document_id: documentId,
        review_id: reviewId,
        relation_type: "rationale_ref",
        code_repository: identity.repository,
        code_commit_sha: commitSha,
      },
    });

    const replay = await app.inject({
      method: "POST",
      url: "/v1/code/knowledge-links",
      headers,
      payload,
    });
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.json()).toEqual(first.json());

    const events = await db.pool.query(
      `select event_type,resource_id,payload
         from event_outbox
        where event_type='CodeKnowledgeLinkApproved'
          and vault_id=$1 and resource_id=$2`,
      [vaultId, String((first.json() as { link: { id: string } }).link.id)],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({
      event_type: "CodeKnowledgeLinkApproved",
      payload: {
        projectId,
        documentId,
        reviewId,
        relationType: "rationale_ref",
      },
    });
  });
});
