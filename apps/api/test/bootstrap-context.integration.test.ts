import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Postgres, grantVaultMembership } from "@akp/postgres";

const spaceId = "00000000-0000-0000-0000-000000000003";
const actorId = randomUUID();
const vaultId = randomUUID();
const token = `bootstrap-context-${randomUUID()}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const headers = { authorization: `Bearer ${token}` };

let app: FastifyInstance;
let db: Postgres;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests.");
  }
  process.env.NODE_ENV = "test";
  db = new Postgres(process.env.DATABASE_URL);
  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,vault_key,
       local_path,visibility,enabled
     ) values($1,$2,$3,$4,true,'bootstrap:r1',$5,$3,'PRIVATE',true)`,
    [
      vaultId,
      spaceId,
      `/tmp/bootstrap-context-${vaultId}`,
      "Bootstrap context integration vault",
      `bootstrap-${vaultId.slice(0, 8)}`,
    ],
  );
  await db.pool.query(
    "insert into users(id,email,display_name) values($1,$2,'Bootstrap Context Actor')",
    [actorId, `${actorId}@example.test`],
  );
  await db.pool.query(
    "insert into memberships(user_id,space_id,role,path_prefix) values($1,$2,'VIEWER',null)",
    [actorId, spaceId],
  );
  await grantVaultMembership(db, {
    userId: actorId,
    vaultId,
    role: "VIEWER",
    pathPrefix: null,
    permissions: ["knowledge:read", "source:read"],
  });
  await db.pool.query(
    `insert into api_tokens(user_id,token_hash,label,scopes)
     values($1,$2,'bootstrap context integration',$3::jsonb)`,
    [
      actorId,
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
  const module = await import("../src/server.js");
  app = module.buildServer();
});

afterAll(async () => {
  if (app) await app.close();
  if (db) {
    await db.pool.query(
      "delete from audit_events where space_id=$1 and vault_id=$2",
      [spaceId, vaultId],
    );
    await db.pool.query("delete from agent_sessions where vault_id=$1", [
      vaultId,
    ]);
    await db.pool.query("delete from context_packets where actor_id=$1", [
      actorId,
    ]);
    await db.pool.query("delete from idempotency_records where actor_id=$1", [
      actorId,
    ]);
    await db.pool.query("delete from api_tokens where token_hash=$1", [
      tokenHash,
    ]);
    await db.pool.query(
      "delete from memberships where user_id=$1 and space_id=$2",
      [actorId, spaceId],
    );
    await db.pool.query("delete from users where id=$1", [actorId]);
    await db.pool.query("update vaults set enabled=false where id=$1", [
      vaultId,
    ]);
    await db.close();
  }
});

describe("workspace bootstrap conflict mapping", () => {
  it("returns a principal-aware authorization revision and detects policy drift without changing the shared context pin", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        spaceId,
        vaultId,
        purpose: "Bootstrap with one principal-aware authorization revision",
        contextBudget: 2048,
      },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json() as {
      id: string;
      contextRevisionSetHash: string;
    };

    const workObject = await app.inject({
      method: "POST",
      url: `/v1/sessions/${createdBody.id}/external-refs`,
      headers,
      payload: {
        provider: "github",
        objectType: "issue",
        externalId: "BOOTSTRAP-42",
        title: "Bootstrap packet work item",
        authority: "SYSTEM_OF_RECORD",
        workObjectClass: "WORK_ITEM",
      },
    });
    expect(workObject.statusCode, workObject.body).toBe(201);
    const workObjectId = (workObject.json() as { id: string }).id;

    const relatedDecision = await app.inject({
      method: "POST",
      url: `/v1/sessions/${createdBody.id}/events`,
      headers: {
        ...headers,
        "idempotency-key": "bootstrap-related-decision",
      },
      payload: {
        eventType: "DECISION_CANDIDATE",
        payload: {
          title: "Bootstrap related decision",
          status: "DRAFT",
        },
      },
    });
    expect(relatedDecision.statusCode).toBe(201);

    const first = await app.inject({
      method: "POST",
      url: `/v1/sessions/${createdBody.id}/bootstrap`,
      headers,
      payload: {
        query: "authorization revision",
        intent: "WORKFLOW_EXECUTION",
        objectRefId: workObjectId,
      },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as {
      revisionSetHash: string;
      sharedRevisionSetHash: string;
      effectiveRevisionSetHash: string;
      authorization: {
        principalId: string;
        principalPolicyRevision: number;
        policyRevision: string;
      };
      decisions: Array<{
        event_type: string;
        payload: { title?: string; status?: string };
      }>;
      agentInstructionDigest: {
        revisionSetHash: string;
        principalId: string;
        principalKind: string;
        allowedActions: string[];
        promotionReviewRequired: boolean;
        directives: string[];
      };
      contextRevisionSet: {
        authorization: {
          principalId: string;
          principalPolicyRevision: number;
          revision: string;
        };
      };
    };
    expect(firstBody.revisionSetHash).toBe(createdBody.contextRevisionSetHash);
    expect(firstBody.sharedRevisionSetHash).toBe(
      createdBody.contextRevisionSetHash,
    );
    expect(firstBody.effectiveRevisionSetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(firstBody.effectiveRevisionSetHash).not.toBe(
      createdBody.contextRevisionSetHash,
    );
    expect(firstBody.authorization.policyRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(firstBody.decisions).toContainEqual(
      expect.objectContaining({
        event_type: "DECISION_CANDIDATE",
        payload: expect.objectContaining({
          title: "Bootstrap related decision",
          status: "DRAFT",
        }),
      }),
    );
    expect(firstBody.agentInstructionDigest).toMatchObject({
      revisionSetHash: createdBody.contextRevisionSetHash,
      principalId: firstBody.authorization.principalId,
      principalKind: "HUMAN",
      allowedActions: expect.any(Array),
      promotionReviewRequired: expect.any(Boolean),
      directives: expect.arrayContaining([
        "USE_PINNED_CONTEXT_REVISION",
        "DO_NOT_TREAT_WORKSPACE_COORDINATION_AS_CANONICAL_KNOWLEDGE",
      ]),
    });
    expect(firstBody.contextRevisionSet.authorization).toMatchObject({
      principalId: firstBody.authorization.principalId,
      principalPolicyRevision: firstBody.authorization.principalPolicyRevision,
      revision: firstBody.authorization.policyRevision,
    });

    const stateAfterBootstrap = await app.inject({
      method: "GET",
      url: `/v1/sessions/${createdBody.id}/state`,
      headers,
    });
    expect(stateAfterBootstrap.statusCode).toBe(200);
    expect(
      (
        stateAfterBootstrap.json() as {
          contextPackets: Array<{
            id: string;
            objectRefId: string | null;
            packetHash: string;
          }>;
        }
      ).contextPackets,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.any(String),
          objectRefId: workObjectId,
          packetHash: expect.any(String),
        }),
      ]),
    );

    const persistedPacket = await db.pool.query<{
      session_id: string;
      object_ref_id: string | null;
    }>(
      `select session_id,object_ref_id
         from context_packets
        where session_id=$1 and object_ref_id=$2
        order by created_at desc
        limit 1`,
      [createdBody.id, workObjectId],
    );
    expect(persistedPacket.rows[0]).toEqual({
      session_id: createdBody.id,
      object_ref_id: workObjectId,
    });

    await db.pool.query(
      `update principals
          set policy_revision=policy_revision+1
        where kind='HUMAN' and user_id=$1 and state='ACTIVE'`,
      [actorId],
    );

    const second = await app.inject({
      method: "POST",
      url: `/v1/sessions/${createdBody.id}/bootstrap`,
      headers,
      payload: {
        query: "authorization revision",
        intent: "WORKFLOW_EXECUTION",
        objectRefId: workObjectId,
      },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as {
      revisionSetHash: string;
      effectiveRevisionSetHash: string;
      authorization: {
        principalPolicyRevision: number;
        policyRevision: string;
      };
    };
    expect(secondBody.revisionSetHash).toBe(createdBody.contextRevisionSetHash);
    expect(secondBody.authorization.principalPolicyRevision).toBe(
      firstBody.authorization.principalPolicyRevision + 1,
    );
    expect(secondBody.authorization.policyRevision).not.toBe(
      firstBody.authorization.policyRevision,
    );
    expect(secondBody.effectiveRevisionSetHash).not.toBe(
      firstBody.effectiveRevisionSetHash,
    );
  });

  it("rejects an object-scoped context request without a workspace session", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/context",
      headers,
      payload: {
        query: "orphaned object scope",
        intent: "WORKFLOW_EXECUTION",
        spaceId,
        vaultId,
        vaultIds: [],
        federated: false,
        mode: "SOURCE_BACKED",
        objectRefId: randomUUID(),
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "CONTEXT_OBJECT_SESSION_REQUIRED",
    });
  });

  it("returns a typed conflict when the pinned context revision has drifted", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        spaceId,
        vaultId,
        purpose: "Bootstrap against one coherent context revision",
        contextBudget: 2048,
      },
    });
    expect(created.statusCode).toBe(201);
    const sessionId = (created.json() as { id: string }).id;

    await db.pool.query(
      "update vaults set current_revision='bootstrap:r2' where id=$1",
      [vaultId],
    );

    const bootstrap = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/bootstrap`,
      headers,
      payload: {
        query: "compiler boundary",
        intent: "WORKFLOW_EXECUTION",
      },
    });

    expect(bootstrap.statusCode).toBe(409);
    expect(bootstrap.json()).toMatchObject({
      code: "CONTEXT_REVISION_CHANGED",
    });
  });

  it("returns a typed conflict for a legacy session without a pinned revision", async () => {
    const inserted = await db.pool.query<{ id: string }>(
      `insert into agent_sessions(
         space_id,vault_id,actor_id,purpose,context_budget,state
       ) values($1,$2,$3,$4,2048,$5::jsonb)
       returning id`,
      [
        spaceId,
        vaultId,
        actorId,
        "Legacy bootstrap session without a context pin",
        JSON.stringify({ status: "ACTIVE", createdBy: "integration-test" }),
      ],
    );
    const sessionId = inserted.rows[0]?.id;
    expect(sessionId).toBeTruthy();
    await db.pool.query(
      `insert into workspace_session_participants(session_id,user_id,role)
       values($1,$2,'OWNER')`,
      [sessionId, actorId],
    );

    const bootstrap = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/bootstrap`,
      headers,
      payload: {
        query: "legacy context",
        intent: "WORKFLOW_EXECUTION",
      },
    });

    expect(bootstrap.statusCode).toBe(409);
    expect(bootstrap.json()).toMatchObject({
      code: "CONTEXT_REVISION_PIN_REQUIRED",
    });
  });
});
