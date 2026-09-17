import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Postgres, grantVaultMembership } from "@akp/postgres";

const spaceId = "00000000-0000-0000-0000-000000000003";
const actorId = randomUUID();
const vaultId = randomUUID();
const token = `context-fabric-isolation-${randomUUID()}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const headers = { authorization: `Bearer ${token}` };

let app: FastifyInstance;
let db: Postgres;
const sessionIds: string[] = [];

async function createSession(purpose: string): Promise<{
  id: string;
  contextRevisionSetHash: string;
}> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers,
    payload: { spaceId, vaultId, purpose, contextBudget: 2048 },
  });
  expect(response.statusCode).toBe(201);
  const session = response.json() as {
    id: string;
    contextRevisionSetHash: string;
  };
  sessionIds.push(session.id);
  return session;
}

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
     ) values($1,$2,$3,$4,true,'fabric-isolation:r1',$5,$3,'PRIVATE',true)`,
    [
      vaultId,
      spaceId,
      `/tmp/context-fabric-isolation-${vaultId}`,
      "Context fabric session isolation vault",
      `fabric-isolation-${vaultId.slice(0, 8)}`,
    ],
  );
  await db.pool.query(
    "insert into users(id,email,display_name) values($1,$2,'Context Fabric Isolation Actor')",
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
     values($1,$2,'context fabric isolation actor',$3::jsonb)`,
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
    await db.pool.query("delete from event_outbox where vault_id=$1", [
      vaultId,
    ]);
    for (const sessionId of sessionIds) {
      await db.pool.query(
        "delete from audit_events where resource_id=$1 or metadata->>'sessionId'=$1",
        [sessionId],
      );
      await db.pool.query("delete from agent_sessions where id=$1", [
        sessionId,
      ]);
    }
    await db.pool.query("delete from api_tokens where token_hash=$1", [
      tokenHash,
    ]);
    await db.pool.query(
      "delete from memberships where user_id=$1 and space_id=$2",
      [actorId, spaceId],
    );
    await db.pool.query("delete from users where id=$1", [actorId]);
    await db.pool.query("delete from vaults where id=$1", [vaultId]);
    await db.close();
  }
});

describe("context fabric session isolation", () => {
  it("does not read or apply one session's offline state through another session and preserves typed conflicts", async () => {
    const sessionA = await createSession("Own offline draft state A");
    const sessionB = await createSession("Own offline draft state B");

    const externalRef = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionA.id}/external-refs`,
      headers,
      payload: {
        provider: "github",
        objectType: "issue",
        externalId: `isolation-${vaultId.slice(0, 8)}`,
        authority: "REFERENCE",
        metadata: { ownerSession: "A" },
      },
    });
    expect(externalRef.statusCode).toBe(201);

    const refsFromB = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionB.id}/external-refs`,
      headers,
    });
    expect(refsFromB.statusCode).toBe(200);
    expect((refsFromB.json() as { refs: unknown[] }).refs).toEqual([]);

    const queued = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionA.id}/offline-drafts`,
      headers,
      payload: {
        clientDraftId: "session-a-draft",
        baseRevisionSetHash: sessionA.contextRevisionSetHash,
        eventType: "FINDING",
        payload: {
          summary: "Session A only finding",
          evidence: "session-isolation-regression",
        },
      },
    });
    expect(queued.statusCode).toBe(201);
    const draft = queued.json() as { id: string; status: string };
    expect(draft.status).toBe("QUEUED");

    const draftsFromB = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionB.id}/offline-drafts`,
      headers,
    });
    expect(draftsFromB.statusCode).toBe(200);
    expect((draftsFromB.json() as { drafts: unknown[] }).drafts).toEqual([]);

    const crossSessionApply = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionB.id}/offline-drafts/${draft.id}/apply`,
      headers,
    });
    expect(crossSessionApply.statusCode).toBe(404);
    expect(crossSessionApply.json()).toMatchObject({
      code: "OFFLINE_DRAFT_NOT_FOUND",
    });

    const afterDeniedApply = await db.pool.query<{
      status: string;
      applied_event_id: number | null;
    }>(
      "select status,applied_event_id from workspace_offline_drafts where id=$1",
      [draft.id],
    );
    expect(afterDeniedApply.rows[0]).toMatchObject({
      status: "QUEUED",
      applied_event_id: null,
    });
    const leakedEvent = await db.pool.query<{ count: number }>(
      `select count(*)::int count from workspace_events
        where session_id=$1 and event_type='FINDING'
          and payload->>'summary'='Session A only finding'`,
      [sessionA.id],
    );
    expect(leakedEvent.rows[0]?.count).toBe(0);

    const correctApply = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionA.id}/offline-drafts/${draft.id}/apply`,
      headers,
    });
    expect(correctApply.statusCode).toBe(200);
    expect(correctApply.json()).toMatchObject({ status: "APPLIED" });

    const firstConflictWrite = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionA.id}/offline-drafts`,
      headers,
      payload: {
        clientDraftId: "idempotency-conflict",
        baseRevisionSetHash: sessionA.contextRevisionSetHash,
        eventType: "NOTE",
        payload: { note: "first payload" },
      },
    });
    expect(firstConflictWrite.statusCode).toBe(201);

    const conflictingReplay = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionA.id}/offline-drafts`,
      headers,
      payload: {
        clientDraftId: "idempotency-conflict",
        baseRevisionSetHash: sessionA.contextRevisionSetHash,
        eventType: "NOTE",
        payload: { note: "different payload" },
      },
    });
    expect(conflictingReplay.statusCode).toBe(409);
    expect(conflictingReplay.json()).toEqual({
      code: "OFFLINE_DRAFT_IDEMPOTENCY_CONFLICT",
    });
  });
});
