import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  Postgres,
  claimWorkspaceWork,
  grantVaultMembership,
} from "@akp/postgres";

const spaceId = "00000000-0000-0000-0000-000000000003";
const actorAId = randomUUID();
const actorBId = randomUUID();
const outsiderId = randomUUID();
const vaultId = randomUUID();
const actorAToken = `workspace-a-${randomUUID()}`;
const actorBToken = `workspace-b-${randomUUID()}`;
const actorBNarrowToken = `workspace-b-narrow-${randomUUID()}`;
const outsiderToken = `workspace-outsider-${randomUUID()}`;
const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const actorAHeaders = { authorization: `Bearer ${actorAToken}` };
const actorBHeaders = { authorization: `Bearer ${actorBToken}` };
const actorBNarrowHeaders = { authorization: `Bearer ${actorBNarrowToken}` };
const outsiderHeaders = { authorization: `Bearer ${outsiderToken}` };

let app: FastifyInstance;
let db: Postgres;
let sessionId = "";

async function insertToken(
  userId: string,
  token: string,
  label: string,
  pathPrefix: string | null = null,
  permissions: string[] = [
    "knowledge:read",
    "knowledge:propose",
    "source:read",
  ],
): Promise<void> {
  await db.pool.query(
    `insert into api_tokens(user_id,token_hash,label,scopes)
     values($1,$2,$3,$4::jsonb)`,
    [
      userId,
      tokenHash(token),
      label,
      JSON.stringify({
        spaces: [{ spaceId, pathPrefix, permissions }],
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
      ($1,$4,'CONTRIBUTOR',null),
      ($2,$4,'CONTRIBUTOR',null),
      ($3,$4,'VIEWER',null)`,
    [actorAId, actorBId, outsiderId, spaceId],
  );
  for (const userId of [actorAId, actorBId]) {
    await grantVaultMembership(db, {
      userId,
      vaultId,
      role: "CONTRIBUTOR",
      pathPrefix: null,
      permissions: ["knowledge:read", "knowledge:propose", "source:read"],
    });
  }
  await insertToken(actorAId, actorAToken, "workspace actor a");
  await insertToken(actorBId, actorBToken, "workspace actor b");
  await insertToken(
    actorBId,
    actorBNarrowToken,
    "workspace actor b narrow",
    "docs",
  );
  await insertToken(
    outsiderId,
    outsiderToken,
    "workspace outsider",
    null,
    ["knowledge:read", "source:read"],
  );
  const module = await import("../src/server.js");
  app = module.buildServer();
});

afterAll(async () => {
  if (app) await app.close();
  if (db) await db.close();
});

describe("workspace coordination integration", () => {
  it("coordinates authorized actors with durable leases, fencing, handoff, bounded history, and governed promotion", async () => {
    const canonicalBefore = await db.pool.query<{ documents: number }>(
      `select count(*)::int documents
         from knowledge_documents
        where vault_id=$1`,
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

    const ownerReadd = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/participants`,
      headers: actorAHeaders,
      payload: { userId: actorAId },
    });
    expect(ownerReadd.statusCode).toBe(200);
    expect(ownerReadd.json()).toMatchObject({ joined: false, role: "OWNER" });

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

    const hiddenFromNarrowCredential = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/state`,
      headers: actorBNarrowHeaders,
    });
    expect(hiddenFromNarrowCredential.statusCode).toBe(404);
    expect(hiddenFromNarrowCredential.json()).toMatchObject({
      code: "SESSION_NOT_FOUND",
    });

    const narrowList = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: actorBNarrowHeaders,
    });
    expect(narrowList.statusCode).toBe(403);
    expect(narrowList.json()).toMatchObject({ code: "PATH_SCOPE_DENIED" });

    const hiddenFromOutsider = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/state`,
      headers: outsiderHeaders,
    });
    expect(hiddenFromOutsider.statusCode).toBe(404);
    expect(hiddenFromOutsider.json()).toMatchObject({ code: "SESSION_NOT_FOUND" });

    const compilerScope = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims`,
      headers: actorAHeaders,
      payload: { workKey: "packages/compiler/**", leaseSeconds: 120 },
    });
    expect(compilerScope.statusCode).toBe(201);
    expect(compilerScope.json()).toMatchObject({
      ownerId: actorAId,
      workKey: "packages/compiler/**",
      fencingToken: 1,
    });

    const webScope = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims`,
      headers: actorBHeaders,
      payload: { workKey: "apps/web/**", leaseSeconds: 120 },
    });
    expect(webScope.statusCode).toBe(201);

    for (const conflictingWorkKey of [
      "packages/compiler/src/parser.ts",
      "packages/compiler/src/**",
    ]) {
      const overlap = await app.inject({
        method: "POST",
        url: `/v1/sessions/${sessionId}/claims`,
        headers: actorBHeaders,
        payload: { workKey: conflictingWorkKey, leaseSeconds: 120 },
      });
      expect(overlap.statusCode).toBe(409);
      expect(overlap.json()).toMatchObject({ code: "WORK_CLAIM_OVERLAP" });
    }

    const invalidRecursiveScope = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims`,
      headers: actorBHeaders,
      payload: { workKey: "packages/**/compiler", leaseSeconds: 120 },
    });
    expect(invalidRecursiveScope.statusCode).toBe(400);
    expect(invalidRecursiveScope.json()).toMatchObject({ code: "INVALID_WORK_KEY" });

    const race = await Promise.all([
      app.inject({
        method: "POST",
        url: `/v1/sessions/${sessionId}/claims`,
        headers: actorAHeaders,
        payload: { workKey: "services/payments/**", leaseSeconds: 120 },
      }),
      app.inject({
        method: "POST",
        url: `/v1/sessions/${sessionId}/claims`,
        headers: actorBHeaders,
        payload: { workKey: "services/payments/api/**", leaseSeconds: 120 },
      }),
    ]);
    expect(race.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(
      race.find((response) => response.statusCode === 409)?.json(),
    ).toMatchObject({ code: "WORK_CLAIM_OVERLAP" });

    const claimedByA = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims`,
      headers: actorAHeaders,
      payload: { workKey: "profile:compiler-boundary", leaseSeconds: 120 },
    });
    expect(claimedByA.statusCode).toBe(201);
    expect(claimedByA.json()).toMatchObject({
      ownerId: actorAId,
      fencingToken: 1,
      status: "ACTIVE",
    });

    await expect(
      claimWorkspaceWork(db, {
        sessionId,
        actorId: actorAId,
        workKey: "invalid:lease",
        leaseSeconds: 0,
      }),
    ).rejects.toThrow("INVALID_CLAIM_LEASE");

    const duplicateClaim = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims`,
      headers: actorAHeaders,
      payload: { workKey: "profile:compiler-boundary", leaseSeconds: 120 },
    });
    expect(duplicateClaim.statusCode).toBe(409);
    expect(duplicateClaim.json()).toMatchObject({ code: "WORK_CLAIM_HELD" });

    const heartbeatA = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims/heartbeat`,
      headers: actorAHeaders,
      payload: {
        workKey: "profile:compiler-boundary",
        fencingToken: 1,
        leaseSeconds: 120,
      },
    });
    expect(heartbeatA.statusCode).toBe(200);
    expect(heartbeatA.json()).toMatchObject({
      ownerId: actorAId,
      fencingToken: 1,
      version: 2,
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
          summary: "The compiler boundary is isolated from canonical publication.",
          evidence: "integration-fixture",
        },
      },
    });
    expect(finding.statusCode).toBe(200);
    const findingId = String((finding.json() as { id: string }).id);

    await db.pool.query(
      `update vault_memberships
          set enabled=false
        where user_id=$1 and vault_id=$2`,
      [actorBId, vaultId],
    );
    const revokedState = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/state`,
      headers: actorBHeaders,
    });
    expect(revokedState.statusCode).toBe(404);

    const revokedHandoff = await app.inject({
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
    expect(revokedHandoff.statusCode).toBe(422);
    expect(revokedHandoff.json()).toMatchObject({
      code: "PARTICIPANT_NOT_AUTHORIZED",
    });

    await db.pool.query(
      `update vault_memberships set enabled=true
        where user_id=$1 and vault_id=$2`,
      [actorBId, vaultId],
    );

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
      fencingToken: 2,
      status: "ACTIVE",
    });

    for (const route of ["handoff", "heartbeat"] as const) {
      const stale = await app.inject({
        method: "POST",
        url:
          route === "handoff"
            ? `/v1/sessions/${sessionId}/claims/handoff`
            : `/v1/sessions/${sessionId}/claims/heartbeat`,
        headers: actorAHeaders,
        payload:
          route === "handoff"
            ? {
                workKey: "profile:compiler-boundary",
                toUserId: actorBId,
                fencingToken: 1,
                leaseSeconds: 120,
              }
            : {
                workKey: "profile:compiler-boundary",
                fencingToken: 1,
                leaseSeconds: 120,
              },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: "WORK_CLAIM_FENCE_STALE" });
    }

    const resumedByB = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/state`,
      headers: actorBHeaders,
    });
    expect(resumedByB.statusCode).toBe(200);
    const snapshot = resumedByB.json() as {
      session: { id: string; role: string; coordinationVersion: number };
      participants: Array<{ user_id: string }>;
      claims: Array<{ workKey: string; ownerId: string; fencingToken: number }>;
      events: Array<{
        id: string;
        event_type: string;
        session_version: number;
        payload: Record<string, unknown>;
      }>;
      snapshotVersion: number;
      eventWindow: {
        total: number;
        returned: number;
        truncated: boolean;
        oldestVersion: number | null;
        latestVersion: number | null;
      };
    };
    expect(snapshot.session).toMatchObject({ id: sessionId, role: "PARTICIPANT" });
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
        "CLAIM_HEARTBEAT",
        "FINDING",
        "CLAIM_HANDOFF",
      ]),
    );
    expect(snapshot.snapshotVersion).toBe(snapshot.session.coordinationVersion);
    expect(snapshot.eventWindow.latestVersion).toBe(snapshot.snapshotVersion);

    const stressClient = await db.pool.connect();
    try {
      await stressClient.query("begin");
      const current = await stressClient.query<{ coordination_version: number }>(
        "select coordination_version from agent_sessions where id=$1 for update",
        [sessionId],
      );
      const baseVersion = Number(current.rows[0]?.coordination_version ?? 0);
      await stressClient.query(
        `insert into workspace_events(
           session_id,space_id,vault_id,actor_id,event_type,payload,session_version
         )
         select $1,$2,$3,$4,'NOTE',jsonb_build_object('sequence',g),$5+g
           from generate_series(1,505) g`,
        [sessionId, spaceId, vaultId, actorBId, baseVersion],
      );
      await stressClient.query(
        `update agent_sessions
            set coordination_version=$2,updated_at=now()
          where id=$1`,
        [sessionId, baseVersion + 505],
      );
      await stressClient.query("commit");
    } catch (error) {
      await stressClient.query("rollback");
      throw error;
    } finally {
      stressClient.release();
    }

    const tailed = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/state`,
      headers: actorBHeaders,
    });
    expect(tailed.statusCode).toBe(200);
    const tailSnapshot = tailed.json() as {
      snapshotVersion: number;
      events: Array<{ event_type: string; payload: { sequence?: number } }>;
      eventWindow: {
        total: number;
        returned: number;
        truncated: boolean;
        oldestVersion: number | null;
        latestVersion: number | null;
      };
    };
    expect(tailSnapshot.eventWindow.returned).toBe(500);
    expect(tailSnapshot.eventWindow.truncated).toBe(true);
    expect(tailSnapshot.eventWindow.total).toBeGreaterThan(500);
    expect(tailSnapshot.eventWindow.latestVersion).toBe(tailSnapshot.snapshotVersion);
    expect(tailSnapshot.events[0]).toMatchObject({
      event_type: "NOTE",
      payload: { sequence: 6 },
    });
    expect(tailSnapshot.events.at(-1)).toMatchObject({
      event_type: "NOTE",
      payload: { sequence: 505 },
    });

    const duplicateEvidencePromotion = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/promotions`,
      headers: actorAHeaders,
      payload: {
        evidenceEventIds: [findingId, findingId],
        changes: [
          {
            path: "knowledge/duplicate-evidence.md",
            content:
              "---\ntype: claim\nstatus: proposed\nknowledge_layer: project\n---\n# Duplicate evidence\n\nDuplicate evidence identifiers are rejected so promotion provenance remains deterministic and cannot inflate independent support.\n",
          },
        ],
      },
    });
    expect(duplicateEvidencePromotion.statusCode).toBe(400);
    expect(duplicateEvidencePromotion.json()).toMatchObject({
      code: "PROMOTION_EVIDENCE_DUPLICATE",
    });

    const invalidPromotionEvidence = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/promotions`,
      headers: actorAHeaders,
      payload: {
        evidenceEventIds: ["not-a-uuid"],
        changes: [
          {
            path: "knowledge/invalid.md",
            content:
              "---\ntype: claim\nstatus: proposed\nknowledge_layer: project\n---\n# Invalid evidence\n\nMalformed workspace identifiers must never establish durable promotion provenance for approved knowledge candidates.\n",
          },
        ],
      },
    });
    expect(invalidPromotionEvidence.statusCode).toBe(400);
    expect(invalidPromotionEvidence.json()).toMatchObject({
      code: "PROMOTION_EVIDENCE_INVALID",
    });

    const blocker = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/events`,
      headers: actorAHeaders,
      payload: {
        eventType: "BLOCKER",
        payload: { reason: "coordination-only blocker" },
      },
    });
    expect(blocker.statusCode).toBe(200);
    const nonPromotable = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/promotions`,
      headers: actorAHeaders,
      payload: {
        evidenceEventIds: [String((blocker.json() as { id: string }).id)],
        changes: [
          {
            path: "knowledge/blocker.md",
            content:
              "---\ntype: claim\nstatus: proposed\nknowledge_layer: project\n---\n# Blocker\n\nA blocker alone is coordination state and cannot be promoted as canonical evidence without a promotable finding, artifact, or decision candidate.\n",
          },
        ],
      },
    });
    expect(nonPromotable.statusCode).toBe(404);
    expect(nonPromotable.json()).toMatchObject({
      code: "PROMOTION_EVIDENCE_NOT_FOUND",
    });

    const promotion = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/promotions`,
      headers: actorAHeaders,
      payload: {
        evidenceEventIds: [findingId],
        summary: "Promote compiler boundary finding",
        changes: [
          {
            path: `knowledge/compiler-boundary-${vaultId.slice(0, 8)}.md`,
            content:
              "---\ntype: claim\nstatus: proposed\nknowledge_layer: project\n---\n# Compiler boundary\n\nCanonical publication requires governed review. This candidate preserves provenance to durable workspace evidence and remains pending until the existing review lifecycle reaches authorized human approval.\n",
            reason: "Promote durable workspace evidence",
          },
        ],
      },
    });
    expect(promotion.statusCode).toBe(201);
    const promotionBody = promotion.json() as {
      reviewId: string;
      promotionEventId: string;
      evidenceEventIds: string[];
      revisionSetHash: string;
    };
    expect(promotionBody.evidenceEventIds).toEqual([findingId]);
    expect(promotionBody.revisionSetHash).toMatch(/^[a-f0-9]{64}$/);

    const promotedReview = await db.pool.query<{
      status: string;
      impact_manifest: {
        promotionRequest?: {
          sessionId?: string;
          promotionEventId?: string;
          evidenceEventIds?: string[];
          revisionSetHash?: string;
        };
      };
    }>("select status,impact_manifest from reviews where id=$1", [
      promotionBody.reviewId,
    ]);
    expect(promotedReview.rows[0]).toMatchObject({
      status: "PENDING",
      impact_manifest: {
        promotionRequest: {
          sessionId,
          promotionEventId: promotionBody.promotionEventId,
          evidenceEventIds: [findingId],
          revisionSetHash: promotionBody.revisionSetHash,
        },
      },
    });

    const canonicalAfter = await db.pool.query<{ documents: number }>(
      "select count(*)::int documents from knowledge_documents where vault_id=$1",
      [vaultId],
    );
    expect(canonicalAfter.rows[0]?.documents).toBe(
      canonicalBefore.rows[0]?.documents,
    );
  });
});
