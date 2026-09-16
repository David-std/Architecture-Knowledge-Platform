import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Postgres, grantVaultMembership } from "@akp/postgres";

const spaceId = "00000000-0000-0000-0000-000000000003";
const actorAId = randomUUID();
const actorBId = randomUUID();
const outsiderId = randomUUID();
const vaultId = randomUUID();
const actorAToken = `workspace-a-${randomUUID()}`;
const actorBToken = `workspace-b-${randomUUID()}`;
const outsiderToken = `workspace-outsider-${randomUUID()}`;
const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const actorAHeaders = { authorization: `Bearer ${actorAToken}` };
const actorBHeaders = { authorization: `Bearer ${actorBToken}` };
const outsiderHeaders = { authorization: `Bearer ${outsiderToken}` };

let app: FastifyInstance;
let db: Postgres;
let sessionId = "";

async function insertToken(
  userId: string,
  token: string,
  label: string,
): Promise<void> {
  await db.pool.query(
    `insert into api_tokens(user_id,token_hash,label,scopes)
     values($1,$2,$3,$4::jsonb)`,
    [
      userId,
      tokenHash(token),
      label,
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
     ) values($1,$2,$3,$4,true,'workspace:initial',$5,$3,'PRIVATE',true)`,
    [
      vaultId,
      spaceId,
      `/tmp/workspace-${vaultId}`,
      "Workspace coordination integration vault",
      `workspace-${vaultId.slice(0, 8)}`,
    ],
  );
  await db.pool.query(
    `insert into users(id,email,display_name) values
      ($1,$2,'Workspace Actor A'),
      ($3,$4,'Workspace Actor B'),
      ($5,$6,'Workspace Outsider')`,
    [
      actorAId,
      `${actorAId}@example.test`,
      actorBId,
      `${actorBId}@example.test`,
      outsiderId,
      `${outsiderId}@example.test`,
    ],
  );
  await db.pool.query(
    `insert into memberships(user_id,space_id,role,path_prefix) values
      ($1,$4,'VIEWER',null),
      ($2,$4,'VIEWER',null),
      ($3,$4,'VIEWER',null)`,
    [actorAId, actorBId, outsiderId, spaceId],
  );
  for (const userId of [actorAId, actorBId]) {
    await grantVaultMembership(db, {
      userId,
      vaultId,
      role: "VIEWER",
      pathPrefix: null,
      permissions: ["knowledge:read", "source:read"],
    });
  }
  await insertToken(actorAId, actorAToken, "workspace actor a");
  await insertToken(actorBId, actorBToken, "workspace actor b");
  await insertToken(outsiderId, outsiderToken, "workspace outsider");
  const module = await import("../src/server.js");
  app = module.buildServer();
});

afterAll(async () => {
  if (app) await app.close();
  if (db) {
    if (sessionId) {
      await db.pool.query(
        "delete from audit_events where resource_type='agent_session' and resource_id=$1",
        [sessionId],
      );
      await db.pool.query("delete from agent_sessions where id=$1", [
        sessionId,
      ]);
    }
    await db.pool.query(
      "delete from api_tokens where token_hash=any($1::text[])",
      [
        [
          tokenHash(actorAToken),
          tokenHash(actorBToken),
          tokenHash(outsiderToken),
        ],
      ],
    );
    await db.pool.query(
      "delete from memberships where user_id=any($1::uuid[]) and space_id=$2",
      [[actorAId, actorBId, outsiderId], spaceId],
    );
    await db.pool.query("delete from users where id=any($1::uuid[])", [
      [actorAId, actorBId, outsiderId],
    ]);
    await db.pool.query("delete from vaults where id=$1", [vaultId]);
    await db.close();
  }
});

describe("workspace coordination integration", () => {
  it("coordinates two authorized actors with durable fencing and handoff without publishing knowledge", async () => {
    const canonicalBefore = await db.pool.query<{
      documents: number;
      reviews: number;
    }>(
      `select
         (select count(*)::int from knowledge_documents where vault_id=$1) documents,
         (select count(*)::int from reviews where vault_id=$1) reviews`,
      [vaultId],
    );

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: actorAHeaders,
      payload: {
        spaceId,
        vaultId,
        purpose: "Coordinate an isolated two-actor implementation task",
        contextBudget: 4096,
      },
    });
    expect(created.statusCode).toBe(201);
    sessionId = (created.json() as { id: string }).id;

    const joined = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/participants`,
      headers: actorAHeaders,
      payload: { userId: actorBId },
    });
    expect(joined.statusCode).toBe(201);

    const visibleToB = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: actorBHeaders,
    });
    expect(visibleToB.statusCode).toBe(200);
    expect(
      (visibleToB.json() as { sessions: Array<{ id: string }> }).sessions.some(
        (session) => session.id === sessionId,
      ),
    ).toBe(true);

    const hiddenFromOutsider = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/state`,
      headers: outsiderHeaders,
    });
    expect(hiddenFromOutsider.statusCode).toBe(404);
    expect(hiddenFromOutsider.json()).toMatchObject({
      code: "SESSION_NOT_FOUND",
    });

    const claimedByA = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims`,
      headers: actorAHeaders,
      payload: { workKey: "profile:compiler-boundary", leaseSeconds: 120 },
    });
    expect(claimedByA.statusCode).toBe(201);
    expect(claimedByA.json()).toMatchObject({
      ownerId: actorAId,
      workKey: "profile:compiler-boundary",
      fencingToken: 1,
      status: "ACTIVE",
    });

    const blockedB = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims`,
      headers: actorBHeaders,
      payload: { workKey: "profile:compiler-boundary", leaseSeconds: 120 },
    });
    expect(blockedB.statusCode).toBe(409);
    expect(blockedB.json()).toMatchObject({ code: "WORK_CLAIM_HELD" });

    const finding = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/events`,
      headers: actorAHeaders,
      payload: {
        eventType: "FINDING",
        payload: {
          summary:
            "The compiler boundary is isolated from canonical publication.",
          evidence: "integration-fixture",
        },
      },
    });
    expect(finding.statusCode).toBe(201);
    expect(finding.json()).toMatchObject({ event_type: "FINDING" });

    const handedOff = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims/handoff`,
      headers: actorAHeaders,
      payload: {
        workKey: "profile:compiler-boundary",
        toUserId: actorBId,
        fencingToken: 1,
        leaseSeconds: 120,
        note: "Continue from the durable workspace state.",
      },
    });
    expect(handedOff.statusCode).toBe(200);
    expect(handedOff.json()).toMatchObject({
      ownerId: actorBId,
      workKey: "profile:compiler-boundary",
      fencingToken: 2,
      status: "ACTIVE",
    });

    const staleOwner = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims/handoff`,
      headers: actorAHeaders,
      payload: {
        workKey: "profile:compiler-boundary",
        toUserId: actorBId,
        fencingToken: 1,
        leaseSeconds: 120,
      },
    });
    expect(staleOwner.statusCode).toBe(409);
    expect(staleOwner.json()).toMatchObject({
      code: "WORK_CLAIM_FENCE_STALE",
    });

    const resumedByB = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/state`,
      headers: actorBHeaders,
    });
    expect(resumedByB.statusCode).toBe(200);
    const snapshot = resumedByB.json() as {
      session: { id: string; role: string };
      participants: Array<{ user_id: string }>;
      claims: Array<{
        workKey: string;
        ownerId: string;
        fencingToken: number;
      }>;
      events: Array<{ event_type: string; payload: Record<string, unknown> }>;
    };
    expect(snapshot.session).toMatchObject({
      id: sessionId,
      role: "PARTICIPANT",
    });
    expect(snapshot.participants.map((item) => item.user_id)).toEqual(
      expect.arrayContaining([actorAId, actorBId]),
    );
    expect(snapshot.claims).toContainEqual(
      expect.objectContaining({
        workKey: "profile:compiler-boundary",
        ownerId: actorBId,
        fencingToken: 2,
      }),
    );
    expect(snapshot.events.map((event) => event.event_type)).toEqual(
      expect.arrayContaining([
        "SESSION_CREATED",
        "PARTICIPANT_JOINED",
        "CLAIM_ACQUIRED",
        "FINDING",
        "CLAIM_HANDOFF",
      ]),
    );

    const canonicalAfter = await db.pool.query<{
      documents: number;
      reviews: number;
    }>(
      `select
         (select count(*)::int from knowledge_documents where vault_id=$1) documents,
         (select count(*)::int from reviews where vault_id=$1) reviews`,
      [vaultId],
    );
    expect(canonicalAfter.rows[0]).toEqual(canonicalBefore.rows[0]);
  });
});
