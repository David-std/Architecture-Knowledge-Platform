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
const crossSpaceId = randomUUID();
const crossSpaceUserId = randomUUID();
const vaultId = randomUUID();
const actorAToken = `workspace-a-${randomUUID()}`;
const actorBToken = `workspace-b-${randomUUID()}`;
const actorBNarrowToken = `workspace-b-narrow-${randomUUID()}`;
const outsiderToken = `workspace-outsider-${randomUUID()}`;
const crossSpaceToken = `workspace-cross-space-${randomUUID()}`;
const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const actorAHeaders = { authorization: `Bearer ${actorAToken}` };
const actorBHeaders = { authorization: `Bearer ${actorBToken}` };
const actorBNarrowHeaders = { authorization: `Bearer ${actorBNarrowToken}` };
const outsiderHeaders = { authorization: `Bearer ${outsiderToken}` };
const crossSpaceHeaders = {
  authorization: `Bearer ${crossSpaceToken}`,
};

let app: FastifyInstance;
let db: Postgres;
let sessionId = "";
let releaseSessionId = "";

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
  scopeSpaceId: string = spaceId,
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
            spaceId: scopeSpaceId,
            pathPrefix,
            permissions,
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
  const organization = await db.pool.query<{ organization_id: string }>(
    "select organization_id from spaces where id=$1",
    [spaceId],
  );
  const organizationId = organization.rows[0]?.organization_id;
  if (!organizationId) throw new Error("WORKSPACE_TEST_ORGANIZATION_MISSING");
  await db.pool.query(
    `insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values($1,$2,$3,$4,'PRIVATE',$5)`,
    [
      crossSpaceId,
      organizationId,
      `workspace-cross-${crossSpaceId.slice(0, 8)}`,
      "Workspace cross-space adversarial scope",
      `/tmp/workspace-cross-${crossSpaceId}`,
    ],
  );
  await db.pool.query(
    `insert into users(id,email,display_name) values
      ($1,$2,'Workspace Actor A'),
      ($3,$4,'Workspace Actor B'),
      ($5,$6,'Workspace Outsider'),
      ($7,$8,'Workspace Cross Space Actor')`,
    [
      actorAId,
      `${actorAId}@example.test`,
      actorBId,
      `${actorBId}@example.test`,
      outsiderId,
      `${outsiderId}@example.test`,
      crossSpaceUserId,
      `${crossSpaceUserId}@example.test`,
    ],
  );
  await db.pool.query(
    `insert into memberships(user_id,space_id,role,path_prefix) values
      ($1,$4,'CONTRIBUTOR',null),
      ($2,$4,'CONTRIBUTOR',null),
      ($3,$4,'VIEWER',null)`,
    [actorAId, actorBId, outsiderId, spaceId],
  );
  await db.pool.query(
    `insert into memberships(user_id,space_id,role,path_prefix)
     values($1,$2,'VIEWER',null)`,
    [crossSpaceUserId, crossSpaceId],
  );
  for (const userId of [actorAId, actorBId]) {
    await grantVaultMembership(db, {
      userId,
      vaultId,
      role: "VIEWER",
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
  await insertToken(outsiderId, outsiderToken, "workspace outsider");
  await insertToken(
    crossSpaceUserId,
    crossSpaceToken,
    "workspace cross-space actor",
    null,
    ["knowledge:read", "source:read"],
    crossSpaceId,
  );
  const module = await import("../src/server.js");
  app = module.buildServer();
});

afterAll(async () => {
  if (app) await app.close();
  if (db) {
    for (const id of [sessionId, releaseSessionId].filter(Boolean)) {
      await db.pool.query(
        "delete from audit_events where resource_type='agent_session' and resource_id=$1",
        [id],
      );
      await db.pool.query("delete from agent_sessions where id=$1", [id]);
    }
    await db.pool.query(
      "delete from api_tokens where token_hash=any($1::text[])",
      [
        [
          tokenHash(actorAToken),
          tokenHash(actorBToken),
          tokenHash(actorBNarrowToken),
          tokenHash(outsiderToken),
          tokenHash(crossSpaceToken),
        ],
      ],
    );
    await db.pool.query(
      "delete from memberships where user_id=any($1::uuid[]) and space_id=$2",
      [[actorAId, actorBId, outsiderId], spaceId],
    );
    await db.pool.query(
      "delete from memberships where user_id=$1 and space_id=$2",
      [crossSpaceUserId, crossSpaceId],
    );
    await db.pool.query("delete from spaces where id=$1", [crossSpaceId]);
    await db.pool.query("update vaults set enabled=false where id=$1", [
      vaultId,
    ]);
    await db.close();
  }
});

describe("workspace coordination integration", () => {
  it("coordinates two authorized actors with durable fencing and handoff without publishing knowledge", async () => {
    const canonicalBefore = await db.pool.query<{
      documents: number;
    }>(
      `select
         (select count(*)::int from knowledge_documents where vault_id=$1) documents`,
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
    const createdSession = created.json() as {
      id: string;
      contextRevisionSetHash: string;
    };
    sessionId = createdSession.id;
    const sessionOutbox = await db.pool.query<{ count: number }>(
      `select count(*)::int count from event_outbox
        where event_type='WorkspaceSessionCreated'
          and vault_id=$1
          and payload->>'sessionId'=$2`,
      [vaultId, sessionId],
    );
    expect(sessionOutbox.rows[0]?.count).toBe(1);

    const workContextUpdate = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/work-context`,
      headers: {
        ...actorAHeaders,
        "idempotency-key": "workspace-context-outbox-proof",
      },
      payload: {
        status: "OPEN",
        followUps: ["continue bounded coordination"],
        touchedResources: ["packages/compiler/**"],
      },
    });
    expect(workContextUpdate.statusCode).toBe(200);
    expect(workContextUpdate.json()).toMatchObject({
      workStatus: "OPEN",
      followUps: ["continue bounded coordination"],
      touchedResources: ["packages/compiler/**"],
    });
    const workContextOutbox = await db.pool.query<{ count: number }>(
      `select count(*)::int count from event_outbox
        where event_type='WorkspaceSessionUpdated'
          and vault_id=$1
          and correlation_id=$2
          and payload->>'workspaceEventType'='WORK_CONTEXT_UPDATED'`,
      [vaultId, sessionId],
    );
    expect(workContextOutbox.rows[0]?.count).toBe(1);

    const ownerReadd = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/participants`,
      headers: actorAHeaders,
      payload: { userId: actorAId },
    });
    expect(ownerReadd.statusCode).toBe(200);
    expect(ownerReadd.json()).toMatchObject({
      joined: false,
      role: "OWNER",
    });
    const ownerState = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/state`,
      headers: actorAHeaders,
    });
    expect(ownerState.statusCode).toBe(200);
    expect(ownerState.json()).toMatchObject({
      session: { id: sessionId, role: "OWNER" },
    });

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
    expect(hiddenFromOutsider.json()).toMatchObject({
      code: "SESSION_NOT_FOUND",
    });

    const hiddenAcrossSpace = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/state`,
      headers: crossSpaceHeaders,
    });
    expect(hiddenAcrossSpace.statusCode).toBe(404);
    expect(hiddenAcrossSpace.json()).toMatchObject({
      code: "SESSION_NOT_FOUND",
    });

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

    const overlap = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims`,
      headers: actorBHeaders,
      payload: {
        workKey: "packages/compiler/src/parser.ts",
        leaseSeconds: 120,
      },
    });
    expect(overlap.statusCode).toBe(409);
    expect(overlap.json()).toMatchObject({ code: "WORK_CLAIM_OVERLAP" });

    const overlapPrefix = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims`,
      headers: actorBHeaders,
      payload: { workKey: "packages/compiler/src/**", leaseSeconds: 120 },
    });
    expect(overlapPrefix.statusCode).toBe(409);
    expect(overlapPrefix.json()).toMatchObject({ code: "WORK_CLAIM_OVERLAP" });

    const invalidRecursiveScope = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims`,
      headers: actorBHeaders,
      payload: { workKey: "packages/**/compiler", leaseSeconds: 120 },
    });
    expect(invalidRecursiveScope.statusCode).toBe(400);
    expect(invalidRecursiveScope.json()).toMatchObject({
      code: "INVALID_WORK_KEY",
    });

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
    expect(race.map((response) => response.statusCode).sort()).toEqual([
      201, 409,
    ]);
    expect(
      race.find((response) => response.statusCode === 409)?.json(),
    ).toMatchObject({
      code: "WORK_CLAIM_OVERLAP",
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
          summary:
            "The compiler boundary is isolated from canonical publication.",
          evidence: "integration-fixture",
        },
      },
    });
    expect(finding.statusCode).toBe(201);
    expect(finding.json()).toMatchObject({ event_type: "FINDING" });

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
    expect(revokedState.json()).toMatchObject({ code: "SESSION_NOT_FOUND" });

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
      `update vault_memberships
          set enabled=true
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
        summary:
          "Compiler boundary finding is captured; continue validation and promotion from the shared workspace.",
        completed: [
          "Claimed and isolated the compiler boundary.",
          "Captured the compiler-boundary finding with durable evidence.",
        ],
        remaining: [
          "Validate the finding against the current governed context.",
          "Promote the durable candidate through human review.",
        ],
        blockers: [],
        changedResourceRefs: ["packages/compiler/**"],
        evidenceRefs: ["workspace:finding:compiler-boundary"],
        questions: [
          "Does the promoted claim remain valid under the current pinned revision?",
        ],
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
    const durableCoordinationEvents = await db.pool.query<{
      event_type: string;
    }>(
      `select event_type from event_outbox
        where vault_id=$1 and payload->>'sessionId'=$2
        order by occurred_at,event_id`,
      [vaultId, sessionId],
    );
    expect(durableCoordinationEvents.rows.map((row) => row.event_type)).toEqual(
      expect.arrayContaining([
        "WorkspaceSessionCreated",
        "WorkspaceClaimUpdated",
        "WorkspaceHandoffCreated",
      ]),
    );

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

    const staleHeartbeat = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims/heartbeat`,
      headers: actorAHeaders,
      payload: {
        workKey: "profile:compiler-boundary",
        fencingToken: 1,
        leaseSeconds: 120,
      },
    });
    expect(staleHeartbeat.statusCode).toBe(409);
    expect(staleHeartbeat.json()).toMatchObject({
      code: "WORK_CLAIM_FENCE_STALE",
    });

    const resumedByB = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/state`,
      headers: actorBHeaders,
    });
    expect(resumedByB.statusCode).toBe(200);
    const snapshot = resumedByB.json() as {
      session: { id: string; role: string; coordinationVersion: number };
      participants: Array<{ user_id: string }>;
      claims: Array<{
        workKey: string;
        ownerId: string;
        fencingToken: number;
      }>;
      events: Array<{
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
    expect(
      snapshot.events.filter(
        (event) => event.event_type === "PARTICIPANT_JOINED",
      ),
    ).toHaveLength(1);
    expect(snapshot.events.map((event) => event.event_type)).toContain(
      "CLAIM_HEARTBEAT",
    );
    const handoffEvent = snapshot.events.find(
      (event) => event.event_type === "CLAIM_HANDOFF",
    );
    expect(handoffEvent?.payload).toMatchObject({
      workContextId: sessionId,
      fromPrincipalId: expect.any(String),
      toPrincipalId: expect.any(String),
      summary:
        "Compiler boundary finding is captured; continue validation and promotion from the shared workspace.",
      completed: [
        "Claimed and isolated the compiler boundary.",
        "Captured the compiler-boundary finding with durable evidence.",
      ],
      remaining: [
        "Validate the finding against the current governed context.",
        "Promote the durable candidate through human review.",
      ],
      blockers: [],
      changedResourceRefs: ["packages/compiler/**"],
      evidenceRefs: ["workspace:finding:compiler-boundary"],
      questions: [
        "Does the promoted claim remain valid under the current pinned revision?",
      ],
      contextRevisionSetHash: createdSession.contextRevisionSetHash,
      contextRevision: expect.objectContaining({
        spaceId,
        vaultId,
      }),
    });
    expect(snapshot.snapshotVersion).toBe(snapshot.session.coordinationVersion);
    expect(snapshot.eventWindow.latestVersion).toBe(snapshot.snapshotVersion);

    const stressClient = await db.pool.connect();
    try {
      await stressClient.query("begin");
      const current = await stressClient.query<{
        coordination_version: number;
      }>(
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
    expect(tailSnapshot.eventWindow.latestVersion).toBe(
      tailSnapshot.snapshotVersion,
    );
    expect(tailSnapshot.events[0]).toMatchObject({
      event_type: "NOTE",
      payload: { sequence: 6 },
    });
    expect(tailSnapshot.events.at(-1)).toMatchObject({
      event_type: "NOTE",
      payload: { sequence: 505 },
    });

    const findingEvent = snapshot.events.find(
      (event) => event.event_type === "FINDING",
    );
    expect(findingEvent).toBeDefined();
    const duplicateEvidencePromotion = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/promotions`,
      headers: actorAHeaders,
      payload: {
        evidenceEventIds: [
          String((findingEvent as { id: string }).id),
          String((findingEvent as { id: string }).id),
        ],
        changes: [
          {
            path: "knowledge/duplicate-evidence.md",
            content:
              "---\ntype: claim\nstatus: proposed\nknowledge_layer: project\n---\n# Duplicate evidence\n\nDuplicate evidence identifiers are rejected so provenance remains a deterministic set rather than an ambiguous multiset.\n",
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
              "---\ntype: claim\nstatus: proposed\nknowledge_layer: project\n---\n# Invalid evidence\n\nThis proposal must never be created because its workspace evidence identifier is malformed and cannot establish durable provenance.\n",
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
    expect(blocker.statusCode).toBe(201);
    const nonPromotableEvent = blocker.json() as { id: string };
    const nonPromotable = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/promotions`,
      headers: actorAHeaders,
      payload: {
        evidenceEventIds: [String(nonPromotableEvent.id)],
        changes: [
          {
            path: "knowledge/blocker.md",
            content:
              "---\ntype: claim\nstatus: proposed\nknowledge_layer: project\n---\n# Blocker\n\nA blocker alone is coordination state and must not be accepted as canonical promotion evidence without a promotable finding, artifact, or decision candidate.\n",
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
        evidenceEventIds: [String((findingEvent as { id: string }).id)],
        summary: "Promote compiler boundary finding",
        changes: [
          {
            path: "knowledge/compiler-boundary.md",
            content:
              "---\ntype: claim\nstatus: proposed\nknowledge_layer: project\n---\n# Compiler boundary\n\nCanonical publication requires governed review. This promoted claim preserves provenance to the durable workspace finding and remains pending until an authorized human reviewer completes the existing review lifecycle.\n",
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
    expect(promotionBody.evidenceEventIds).toEqual([
      String((findingEvent as { id: string }).id),
    ]);
    expect(promotionBody.revisionSetHash).toBeTruthy();
    const promotedReview = await db.pool.query<{
      status: string;
      impact_manifest: {
        promotionRequest?: {
          sessionId?: string;
          promotionEventId?: string;
          evidenceEventIds?: string[];
          revisionSetHash?: string;
          sourceScope?: Record<string, unknown>;
          targetScope?: Record<string, unknown>;
          knowledgeCandidates?: Array<Record<string, unknown>>;
          conflicts?: Record<string, unknown>;
          implications?: Record<string, unknown>;
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
          evidenceEventIds: [String((findingEvent as { id: string }).id)],
          revisionSetHash: promotionBody.revisionSetHash,
          sourceScope: {
            sessionId,
            spaceId,
            vaultId,
            revisionSetHash: promotionBody.revisionSetHash,
          },
          targetScope: {
            spaceId,
            vaultId,
            knowledgeLayers: ["project"],
          },
          knowledgeCandidates: [
            {
              path: "knowledge/compiler-boundary.md",
              kind: "claim",
              knowledgeLayer: "project",
              lifecycle: "proposed",
              trustTier: null,
            },
          ],
          conflicts: {
            status: "NOT_EVALUATED",
            items: [],
          },
          implications: {
            lifecycle: [
              {
                path: "knowledge/compiler-boundary.md",
                requestedStatus: "proposed",
                publicationRequired: true,
              },
            ],
            trust: [
              {
                path: "knowledge/compiler-boundary.md",
                requestedTier: null,
                selfAttestationAllowed: false,
                authority: "GOVERNED_REVIEW",
              },
            ],
          },
        },
      },
    });
    const promotionEventScope = await db.pool.query<{
      space_id: string;
      vault_id: string;
    }>("select space_id,vault_id from workspace_events where id=$1::bigint", [
      promotionBody.promotionEventId,
    ]);
    expect(promotionEventScope.rows[0]).toMatchObject({
      space_id: spaceId,
      vault_id: vaultId,
    });
    const promotionOutbox = await db.pool.query<{ count: number }>(
      `select count(*)::int count from event_outbox
        where event_type='WorkspacePromotionRequested'
          and vault_id=$1
          and payload->>'sessionId'=$2
          and payload->>'workspaceEventId'=$3`,
      [vaultId, sessionId, promotionBody.promotionEventId],
    );
    expect(promotionOutbox.rows[0]?.count).toBe(1);

    const canonicalAfter = await db.pool.query<{ documents: number }>(
      `select
         (select count(*)::int from knowledge_documents where vault_id=$1) documents`,
      [vaultId],
    );
    expect(canonicalAfter.rows[0].documents).toBe(
      canonicalBefore.rows[0].documents,
    );
    expect(
      Number(
        (
          await db.pool.query(
            "select count(*)::int count from reviews where vault_id=$1",
            [vaultId],
          )
        ).rows[0]?.count ?? 0,
      ),
    ).toBeGreaterThan(0);
  });

  it("releases an owned claim with an advancing fence that locks out stale writers and frees the scope", async () => {
    const canonicalBefore = await db.pool.query<{ documents: number }>(
      `select
         (select count(*)::int from knowledge_documents where vault_id=$1) documents`,
      [vaultId],
    );

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: actorAHeaders,
      payload: {
        spaceId,
        vaultId,
        purpose: "Prove explicit claim release advances the durable fence",
        contextBudget: 4096,
      },
    });
    expect(created.statusCode).toBe(201);
    releaseSessionId = (created.json() as { id: string }).id;
    const joined = await app.inject({
      method: "POST",
      url: `/v1/sessions/${releaseSessionId}/participants`,
      headers: actorAHeaders,
      payload: { userId: actorBId },
    });
    expect(joined.statusCode).toBe(201);

    const workKey = "release:fenced-scope";
    const acquired = await app.inject({
      method: "POST",
      url: `/v1/sessions/${releaseSessionId}/claims`,
      headers: actorAHeaders,
      payload: { workKey, leaseSeconds: 120 },
    });
    expect(acquired.statusCode).toBe(201);
    expect(acquired.json()).toMatchObject({
      ownerId: actorAId,
      workKey,
      status: "ACTIVE",
      fencingToken: 1,
    });

    // A malformed scope is rejected at the boundary, before the claim is touched.
    const malformedScope = await app.inject({
      method: "POST",
      url: `/v1/sessions/${releaseSessionId}/claims/release`,
      headers: actorAHeaders,
      payload: { workKey: "packages/**/compiler", fencingToken: 1 },
    });
    expect(malformedScope.statusCode).toBe(400);
    expect(malformedScope.json()).toMatchObject({ code: "INVALID_WORK_KEY" });

    const malformedFence = await app.inject({
      method: "POST",
      url: `/v1/sessions/${releaseSessionId}/claims/release`,
      headers: actorAHeaders,
      payload: { workKey, fencingToken: 0 },
    });
    expect(malformedFence.statusCode).toBe(400);
    expect(malformedFence.json()).toMatchObject({
      code: "INVALID_FENCING_TOKEN",
    });

    // A participant who does not own the claim cannot release it out from under
    // the owner, even with the correct current fence.
    const nonOwnerRelease = await app.inject({
      method: "POST",
      url: `/v1/sessions/${releaseSessionId}/claims/release`,
      headers: actorBHeaders,
      payload: { workKey, fencingToken: 1 },
    });
    expect(nonOwnerRelease.statusCode).toBe(409);
    expect(nonOwnerRelease.json()).toMatchObject({
      code: "WORK_CLAIM_FENCE_STALE",
    });

    // A non-participant cannot even learn that the session exists.
    const outsiderRelease = await app.inject({
      method: "POST",
      url: `/v1/sessions/${releaseSessionId}/claims/release`,
      headers: outsiderHeaders,
      payload: { workKey, fencingToken: 1 },
    });
    expect(outsiderRelease.statusCode).toBe(404);
    expect(outsiderRelease.json()).toMatchObject({ code: "SESSION_NOT_FOUND" });

    const wrongFence = await app.inject({
      method: "POST",
      url: `/v1/sessions/${releaseSessionId}/claims/release`,
      headers: actorAHeaders,
      payload: { workKey, fencingToken: 99 },
    });
    expect(wrongFence.statusCode).toBe(409);
    expect(wrongFence.json()).toMatchObject({
      code: "WORK_CLAIM_FENCE_STALE",
    });

    // None of the rejected attempts disturbed the live claim.
    const stillOwnedByA = await app.inject({
      method: "POST",
      url: `/v1/sessions/${releaseSessionId}/claims/heartbeat`,
      headers: actorAHeaders,
      payload: { workKey, fencingToken: 1, leaseSeconds: 120 },
    });
    expect(stillOwnedByA.statusCode).toBe(200);
    expect(stillOwnedByA.json()).toMatchObject({
      ownerId: actorAId,
      status: "ACTIVE",
      fencingToken: 1,
    });

    const released = await app.inject({
      method: "POST",
      url: `/v1/sessions/${releaseSessionId}/claims/release`,
      headers: actorAHeaders,
      payload: { workKey, fencingToken: 1 },
    });
    expect(released.statusCode).toBe(200);
    const releasedClaim = released.json() as {
      id: string;
      status: string;
      fencingToken: number;
      leaseExpiresAt: string;
    };
    expect(releasedClaim).toMatchObject({
      ownerId: actorAId,
      workKey,
      status: "RELEASED",
      fencingToken: 2,
    });
    expect(
      new Date(releasedClaim.leaseExpiresAt).getTime(),
    ).toBeLessThanOrEqual(Date.now() + 1000);

    // Every writer still holding the pre-release fence is locked out, whichever
    // coordination operation it attempts.
    for (const stale of [
      {
        url: `/v1/sessions/${releaseSessionId}/claims/heartbeat`,
        payload: { workKey, fencingToken: 1, leaseSeconds: 120 },
      },
      {
        url: `/v1/sessions/${releaseSessionId}/claims/handoff`,
        payload: {
          workKey,
          toUserId: actorBId,
          fencingToken: 1,
          leaseSeconds: 120,
        },
      },
      {
        url: `/v1/sessions/${releaseSessionId}/claims/release`,
        payload: { workKey, fencingToken: 1 },
      },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: stale.url,
        headers: actorAHeaders,
        payload: stale.payload,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: "WORK_CLAIM_FENCE_STALE",
      });
    }

    // Release is terminal for this generation: not even the advanced fence can
    // resurrect the claim, because it is no longer ACTIVE.
    const releaseAgainWithNewFence = await app.inject({
      method: "POST",
      url: `/v1/sessions/${releaseSessionId}/claims/release`,
      headers: actorAHeaders,
      payload: { workKey, fencingToken: 2 },
    });
    expect(releaseAgainWithNewFence.statusCode).toBe(409);
    expect(releaseAgainWithNewFence.json()).toMatchObject({
      code: "WORK_CLAIM_FENCE_STALE",
    });

    const heartbeatWithNewFence = await app.inject({
      method: "POST",
      url: `/v1/sessions/${releaseSessionId}/claims/heartbeat`,
      headers: actorAHeaders,
      payload: { workKey, fencingToken: 2, leaseSeconds: 120 },
    });
    expect(heartbeatWithNewFence.statusCode).toBe(409);
    expect(heartbeatWithNewFence.json()).toMatchObject({
      code: "WORK_CLAIM_FENCE_STALE",
    });

    // The scope is genuinely free: another actor takes it without waiting for the
    // original lease to expire, and receives a strictly higher generation.
    const reacquired = await app.inject({
      method: "POST",
      url: `/v1/sessions/${releaseSessionId}/claims`,
      headers: actorBHeaders,
      payload: { workKey, leaseSeconds: 120 },
    });
    expect(reacquired.statusCode).toBe(201);
    const reacquiredClaim = reacquired.json() as {
      id: string;
      fencingToken: number;
    };
    expect(reacquiredClaim).toMatchObject({
      ownerId: actorBId,
      workKey,
      status: "ACTIVE",
    });
    expect(reacquiredClaim.fencingToken).toBeGreaterThan(
      releasedClaim.fencingToken,
    );
    expect(reacquiredClaim.id).toBe(releasedClaim.id);

    const staleAfterReacquire = await app.inject({
      method: "POST",
      url: `/v1/sessions/${releaseSessionId}/claims/heartbeat`,
      headers: actorAHeaders,
      payload: { workKey, fencingToken: 1, leaseSeconds: 120 },
    });
    expect(staleAfterReacquire.statusCode).toBe(409);
    expect(staleAfterReacquire.json()).toMatchObject({
      code: "WORK_CLAIM_FENCE_STALE",
    });

    const state = await app.inject({
      method: "GET",
      url: `/v1/sessions/${releaseSessionId}/state`,
      headers: actorAHeaders,
    });
    expect(state.statusCode).toBe(200);
    const snapshot = state.json() as {
      claims: Array<{
        workKey: string;
        ownerId: string;
        status: string;
        fencingToken: number;
      }>;
      events: Array<{
        event_type: string;
        actor_id: string | null;
        claim_id: string | null;
        payload: Record<string, unknown>;
      }>;
    };
    expect(snapshot.claims).toContainEqual(
      expect.objectContaining({
        workKey,
        ownerId: actorBId,
        status: "ACTIVE",
        fencingToken: reacquiredClaim.fencingToken,
      }),
    );
    const releaseEvents = snapshot.events.filter(
      (event) => event.event_type === "CLAIM_RELEASED",
    );
    expect(releaseEvents).toHaveLength(1);
    expect(releaseEvents[0]).toMatchObject({
      actor_id: actorAId,
      claim_id: releasedClaim.id,
      payload: {
        workKey,
        previousFencingToken: 1,
        fencingToken: 2,
        releasedBy: actorAId,
      },
    });
    // The append-only log keeps the whole generation history, not only the last state.
    expect(snapshot.events.map((event) => event.event_type)).toEqual(
      expect.arrayContaining([
        "CLAIM_ACQUIRED",
        "CLAIM_HEARTBEAT",
        "CLAIM_RELEASED",
      ]),
    );

    const releaseOutbox = await db.pool.query<{
      event_type: string;
      payload: {
        workspaceEventType?: string;
        actorId?: string;
        data?: Record<string, unknown>;
      };
    }>(
      `select event_type,payload from event_outbox
        where vault_id=$1
          and payload->>'sessionId'=$2
          and payload->>'workspaceEventType'='CLAIM_RELEASED'`,
      [vaultId, releaseSessionId],
    );
    expect(releaseOutbox.rowCount).toBe(1);
    expect(releaseOutbox.rows[0]).toMatchObject({
      event_type: "WorkspaceClaimUpdated",
      payload: {
        actorId: actorAId,
        data: { workKey, previousFencingToken: 1, fencingToken: 2 },
      },
    });

    const releaseAudit = await db.pool.query<{ count: number }>(
      `select count(*)::int count from audit_events
        where action='workspace.claim.release'
          and resource_type='agent_session'
          and resource_id=$1`,
      [releaseSessionId],
    );
    expect(releaseAudit.rows[0]?.count).toBe(1);

    // Coordination churn is not knowledge: releasing and reacquiring a scope
    // must never publish anything canonical.
    const canonicalAfter = await db.pool.query<{ documents: number }>(
      `select
         (select count(*)::int from knowledge_documents where vault_id=$1) documents`,
      [vaultId],
    );
    expect(canonicalAfter.rows[0].documents).toBe(
      canonicalBefore.rows[0].documents,
    );

    // Expiry is a fencing transition too. Simulate the clock crossing the lease
    // boundary without sleeping the suite, then prove the old owner cannot write
    // and a new owner receives a strictly newer generation.
    await db.pool.query(
      `update workspace_claims
          set lease_expires_at=now()-interval '1 second'
        where id=$1`,
      [reacquiredClaim.id],
    );
    const expiredOwnerHeartbeat = await app.inject({
      method: "POST",
      url: `/v1/sessions/${releaseSessionId}/claims/heartbeat`,
      headers: actorBHeaders,
      payload: {
        workKey,
        fencingToken: reacquiredClaim.fencingToken,
        leaseSeconds: 120,
      },
    });
    expect(expiredOwnerHeartbeat.statusCode).toBe(409);
    expect(expiredOwnerHeartbeat.json()).toMatchObject({
      code: "WORK_CLAIM_FENCE_STALE",
    });

    const expiredOwnerEvent = await app.inject({
      method: "POST",
      url: `/v1/sessions/${releaseSessionId}/events`,
      headers: actorBHeaders,
      payload: {
        eventType: "NOTE",
        claimId: reacquiredClaim.id,
        fencingToken: reacquiredClaim.fencingToken,
        payload: {
          summary:
            "An expired claim must not authorize new claim-owned coordination state.",
        },
      },
    });
    expect(expiredOwnerEvent.statusCode).toBe(409);
    expect(expiredOwnerEvent.json()).toMatchObject({
      code: "WORK_CLAIM_FENCE_STALE",
    });

    const afterExpiry = await app.inject({
      method: "POST",
      url: `/v1/sessions/${releaseSessionId}/claims`,
      headers: actorAHeaders,
      payload: { workKey, leaseSeconds: 120 },
    });
    expect(afterExpiry.statusCode).toBe(201);
    expect(afterExpiry.json()).toMatchObject({
      ownerId: actorAId,
      workKey,
      status: "ACTIVE",
    });
    expect(
      Number((afterExpiry.json() as { fencingToken: number }).fencingToken),
    ).toBeGreaterThan(reacquiredClaim.fencingToken);
  });

  it("rolls back a work claim if acquisition crashes before its coordination event commits", async () => {
    const workKey = `p11:claim-crash:${randomUUID()}`;
    await db.pool.query(`
      create or replace function akp_test_claim_acquisition_crash()
      returns trigger language plpgsql as $$
      begin
        if new.event_type='CLAIM_ACQUIRED' then
          raise exception 'WORK_CLAIM_ACQUISITION_TEST_CRASH';
        end if;
        return new;
      end;
      $$
    `);
    await db.pool.query(`
      create trigger akp_test_claim_acquisition_crash
      before insert on workspace_events
      for each row execute function akp_test_claim_acquisition_crash()
    `);
    try {
      await expect(
        claimWorkspaceWork(db, {
          sessionId,
          actorId: actorAId,
          workKey,
          leaseSeconds: 120,
        }),
      ).rejects.toThrow("WORK_CLAIM_ACQUISITION_TEST_CRASH");

      const claim = await db.pool.query<{ count: number }>(
        `select count(*)::int count from workspace_claims
          where session_id=$1 and work_key=$2`,
        [sessionId, workKey],
      );
      expect(claim.rows[0]?.count).toBe(0);
      const event = await db.pool.query<{ count: number }>(
        `select count(*)::int count from workspace_events
          where session_id=$1 and event_type='CLAIM_ACQUIRED'
            and payload->>'workKey'=$2`,
        [sessionId, workKey],
      );
      expect(event.rows[0]?.count).toBe(0);
    } finally {
      await db.pool.query(
        "drop trigger if exists akp_test_claim_acquisition_crash on workspace_events",
      );
      await db.pool.query(
        "drop function if exists akp_test_claim_acquisition_crash()",
      );
    }
  });
});
