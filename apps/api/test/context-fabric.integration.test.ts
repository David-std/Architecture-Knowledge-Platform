import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Postgres, grantVaultMembership } from "@akp/postgres";

const spaceId = "00000000-0000-0000-0000-000000000003";
const actorId = randomUUID();
const vaultId = randomUUID();
const token = `context-fabric-${randomUUID()}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const headers = { authorization: `Bearer ${token}` };

let app: FastifyInstance;
let db: Postgres;
let sessionId = "";

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
     ) values($1,$2,$3,$4,true,'fabric:r1',$5,$3,'PRIVATE',true)`,
    [
      vaultId,
      spaceId,
      `/tmp/context-fabric-${vaultId}`,
      "Context fabric integration vault",
      `context-fabric-${vaultId.slice(0, 8)}`,
    ],
  );
  await db.pool.query(
    "insert into users(id,email,display_name) values($1,$2,'Context Fabric Actor')",
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
     values($1,$2,'context fabric actor',$3::jsonb)`,
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
    if (sessionId) {
      await db.pool.query(
        "delete from audit_events where resource_id=$1 or metadata->>'sessionId'=$1",
        [sessionId],
      );
      await db.pool.query("delete from agent_sessions where id=$1", [sessionId]);
    }
    await db.pool.query("delete from api_tokens where token_hash=$1", [tokenHash]);
    await db.pool.query(
      "delete from memberships where user_id=$1 and space_id=$2",
      [actorId, spaceId],
    );
    await db.pool.query("delete from users where id=$1", [actorId]);
    await db.pool.query("delete from vaults where id=$1", [vaultId]);
    await db.close();
  }
});

describe("team context fabric integration", () => {
  it("keeps external refs operational and reconciles offline drafts without last-write-wins", async () => {
    const capabilities = await app.inject({
      method: "GET",
      url: "/v1/context-fabric/capabilities",
      headers,
    });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toMatchObject({
      capabilities: {
        externalObjectRefs: true,
        queuedOfflineDrafts: true,
        staleReconnectDisclosure: true,
        lastWriteWinsApprovedKnowledge: false,
        writableDatabaseFileSync: false,
      },
    });

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        spaceId,
        vaultId,
        purpose: "Offline context fabric fixture",
        contextBudget: 2048,
      },
    });
    expect(created.statusCode).toBe(201);
    const createdSession = created.json() as {
      id: string;
      contextRevisionSetHash: string;
    };
    sessionId = createdSession.id;
    expect(createdSession.contextRevisionSetHash).toMatch(/^[a-f0-9]{64}$/);

    const externalRef = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/external-refs`,
      headers,
      payload: {
        provider: "github",
        objectType: "issue",
        externalId: "GH-42",
        canonicalUrl: "https://example.test/issues/42",
        sourceRevision: "etag-42",
        title: "External system of record item",
        authority: "SYSTEM_OF_RECORD",
        metadata: { state: "OPEN" },
      },
    });
    expect(externalRef.statusCode).toBe(201);
    expect(externalRef.json()).toMatchObject({
      provider: "github",
      objectType: "issue",
      externalId: "GH-42",
      authority: "SYSTEM_OF_RECORD",
    });

    const listedRefs = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/external-refs`,
      headers,
    });
    expect(listedRefs.statusCode).toBe(200);
    expect(
      (listedRefs.json() as { refs: Array<{ externalId: string }> }).refs,
    ).toContainEqual(expect.objectContaining({ externalId: "GH-42" }));

    const beforeDocuments = await db.pool.query<{ count: number }>(
      "select count(*)::int count from knowledge_documents where vault_id=$1",
      [vaultId],
    );

    const queued = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/offline-drafts`,
      headers,
      payload: {
        clientDraftId: "offline-1",
        baseRevisionSetHash: createdSession.contextRevisionSetHash,
        eventType: "FINDING",
        payload: {
          summary: "Offline finding that remains coordination state",
          evidence: "local-observation",
        },
      },
    });
    expect(queued.statusCode).toBe(201);
    const queuedDraft = queued.json() as { id: string; status: string };
    expect(queuedDraft.status).toBe("QUEUED");

    const duplicate = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/offline-drafts`,
      headers,
      payload: {
        clientDraftId: "offline-1",
        baseRevisionSetHash: createdSession.contextRevisionSetHash,
        eventType: "FINDING",
        payload: {
          summary: "Offline finding that remains coordination state",
          evidence: "local-observation",
        },
      },
    });
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.json()).toMatchObject({ id: queuedDraft.id, status: "QUEUED" });

    const applied = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/offline-drafts/${queuedDraft.id}/apply`,
      headers,
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ status: "APPLIED" });

    const appliedAgain = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/offline-drafts/${queuedDraft.id}/apply`,
      headers,
    });
    expect(appliedAgain.statusCode).toBe(200);
    expect(appliedAgain.json()).toMatchObject({ status: "APPLIED" });

    const appliedEvents = await db.pool.query<{ count: number }>(
      `select count(*)::int count from workspace_events
        where session_id=$1 and event_type='FINDING'
          and payload->>'summary'='Offline finding that remains coordination state'`,
      [sessionId],
    );
    expect(appliedEvents.rows[0]?.count).toBe(1);

    await db.pool.query(
      "update vaults set current_revision='fabric:r2' where id=$1",
      [vaultId],
    );
    const staleQueue = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/offline-drafts`,
      headers,
      payload: {
        clientDraftId: "offline-stale",
        baseRevisionSetHash: createdSession.contextRevisionSetHash,
        eventType: "NOTE",
        payload: { note: "must not last-write-wins across revision drift" },
      },
    });
    expect(staleQueue.statusCode).toBe(409);
    const staleDraft = staleQueue.json() as { id: string; status: string };
    expect(staleDraft.status).toBe("RECONCILE_REQUIRED");

    const staleApply = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/offline-drafts/${staleDraft.id}/apply`,
      headers,
    });
    expect(staleApply.statusCode).toBe(409);
    expect(staleApply.json()).toMatchObject({ status: "RECONCILE_REQUIRED" });

    const staleNote = await db.pool.query<{ count: number }>(
      `select count(*)::int count from workspace_events
        where session_id=$1 and payload->>'note'='must not last-write-wins across revision drift'`,
      [sessionId],
    );
    expect(staleNote.rows[0]?.count).toBe(0);

    const afterDocuments = await db.pool.query<{ count: number }>(
      "select count(*)::int count from knowledge_documents where vault_id=$1",
      [vaultId],
    );
    expect(afterDocuments.rows[0]?.count).toBe(beforeDocuments.rows[0]?.count);
  });
});
