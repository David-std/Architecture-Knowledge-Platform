import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Postgres, grantVaultMembership } from "@akp/postgres";

const spaceId = "00000000-0000-0000-0000-000000000003";
const actorAId = randomUUID();
const actorBId = randomUUID();
const reviewerId = randomUUID();
const vaultId = randomUUID();
const actorAToken = `p2-flow-a-${randomUUID()}`;
const actorBToken = `p2-flow-b-${randomUUID()}`;
const reviewerToken = `p2-flow-reviewer-${randomUUID()}`;
const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const actorAHeaders = { authorization: `Bearer ${actorAToken}` };
const actorBHeaders = { authorization: `Bearer ${actorBToken}` };
const reviewerHeaders = { authorization: `Bearer ${reviewerToken}` };

let app: FastifyInstance;
let db: Postgres;

async function insertToken(
  userId: string,
  token: string,
  label: string,
  permissions: string[],
): Promise<void> {
  await db.pool.query(
    `insert into api_tokens(user_id,token_hash,label,scopes)
     values($1,$2,$3,$4::jsonb)`,
    [
      userId,
      tokenHash(token),
      label,
      JSON.stringify({
        spaces: [{ spaceId, pathPrefix: null, permissions }],
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
     ) values($1,$2,$3,$4,false,'p2-flow:r1',$5,$3,'TEAM',true)`,
    [
      vaultId,
      spaceId,
      `/tmp/p2-flow-${vaultId}`,
      "P2 product flow integration vault",
      `p2-flow-${vaultId.slice(0, 8)}`,
    ],
  );
  await db.pool.query(
    `insert into users(id,email,display_name) values
      ($1,$2,'P2 Agent Parent A'),
      ($3,$4,'P2 Agent Parent B'),
      ($5,$6,'P2 Human Reviewer')`,
    [
      actorAId,
      `${actorAId}@example.test`,
      actorBId,
      `${actorBId}@example.test`,
      reviewerId,
      `${reviewerId}@example.test`,
    ],
  );
  await db.pool.query(
    `insert into memberships(user_id,space_id,role,path_prefix) values
      ($1,$4,'CONTRIBUTOR',null),
      ($2,$4,'CONTRIBUTOR',null),
      ($3,$4,'REVIEWER',null)`,
    [actorAId, actorBId, reviewerId, spaceId],
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
  await grantVaultMembership(db, {
    userId: reviewerId,
    vaultId,
    role: "REVIEWER",
    pathPrefix: null,
    permissions: ["knowledge:read", "knowledge:review", "source:read"],
  });
  await insertToken(actorAId, actorAToken, "p2 actor a", [
    "knowledge:read",
    "knowledge:propose",
    "source:read",
  ]);
  await insertToken(actorBId, actorBToken, "p2 actor b", [
    "knowledge:read",
    "knowledge:propose",
    "source:read",
  ]);
  await insertToken(reviewerId, reviewerToken, "p2 human reviewer", [
    "knowledge:read",
    "knowledge:review",
    "source:read",
  ]);
  const module = await import("../src/server.js");
  app = module.buildServer();
});

afterAll(async () => {
  if (app) await app.close();
  if (db) await db.close();
});

describe("P2 governed product flow", () => {
  it("coordinates two actors, denies agent approval, publishes by human review, and exposes R2", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: actorAHeaders,
      payload: {
        spaceId,
        vaultId,
        purpose: "P2 normative two-agent flow",
        contextBudget: 4096,
      },
    });
    expect(created.statusCode).toBe(201);
    const initialSession = created.json() as {
      id: string;
      contextRevisionSetHash: string;
      contextRevisionSet: {
        dimensions: { knowledgeGit: { revision: string } };
      };
    };
    const sessionId = initialSession.id;
    expect(
      initialSession.contextRevisionSet.dimensions.knowledgeGit.revision,
    ).toBe("p2-flow:r1");

    const joined = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/participants`,
      headers: actorAHeaders,
      payload: { userId: actorBId },
    });
    expect(joined.statusCode).toBe(201);

    const bootstrapA = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/bootstrap`,
      headers: actorAHeaders,
      payload: { query: "compiler boundary", intent: "WORKFLOW_EXECUTION" },
    });
    expect(bootstrapA.statusCode).toBe(200);
    expect(bootstrapA.json()).toMatchObject({
      revisionSetHash: initialSession.contextRevisionSetHash,
    });

    const bootstrapB = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/bootstrap`,
      headers: actorBHeaders,
      payload: { query: "web workspace", intent: "WORKFLOW_EXECUTION" },
    });
    expect(bootstrapB.statusCode).toBe(200);
    expect(bootstrapB.json()).toMatchObject({
      revisionSetHash: initialSession.contextRevisionSetHash,
    });

    const compilerClaim = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims`,
      headers: actorAHeaders,
      payload: { workKey: "packages/compiler/**", leaseSeconds: 120 },
    });
    expect(compilerClaim.statusCode).toBe(201);

    const webClaim = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims`,
      headers: actorBHeaders,
      payload: { workKey: "apps/web/**", leaseSeconds: 120 },
    });
    expect(webClaim.statusCode).toBe(201);

    const overlap = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims`,
      headers: actorBHeaders,
      payload: { workKey: "packages/compiler/src/**", leaseSeconds: 120 },
    });
    expect(overlap.statusCode).toBe(409);
    expect(overlap.json()).toMatchObject({ code: "WORK_CLAIM_OVERLAP" });

    const promotableClaim = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims`,
      headers: actorAHeaders,
      payload: { workKey: "finding:compiler-boundary", leaseSeconds: 120 },
    });
    expect(promotableClaim.statusCode).toBe(201);

    const finding = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/events`,
      headers: actorAHeaders,
      payload: {
        eventType: "FINDING",
        payload: {
          summary: "Compiler publication boundary requires governed review.",
          evidence: "p2-product-flow-fixture",
        },
      },
    });
    expect(finding.statusCode).toBe(201);
    const findingId = String((finding.json() as { id: string }).id);

    const handoff = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims/handoff`,
      headers: actorAHeaders,
      payload: {
        workKey: "finding:compiler-boundary",
        toUserId: actorBId,
        fencingToken: 1,
        leaseSeconds: 120,
        note: "Continue from finding and evidence in durable workspace state.",
      },
    });
    expect(handoff.statusCode).toBe(200);
    expect(handoff.json()).toMatchObject({
      ownerId: actorBId,
      fencingToken: 2,
    });

    const resumed = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/state`,
      headers: actorBHeaders,
    });
    expect(resumed.statusCode).toBe(200);
    expect(
      (resumed.json() as { events: Array<{ event_type: string }> }).events.map(
        (event) => event.event_type,
      ),
    ).toEqual(expect.arrayContaining(["FINDING", "CLAIM_HANDOFF"]));

    const promotion = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/promotions`,
      headers: actorBHeaders,
      payload: {
        evidenceEventIds: [findingId],
        summary: "Promote compiler publication boundary",
        changes: [
          {
            path: `knowledge/p2-compiler-boundary-${vaultId.slice(0, 8)}.md`,
            content:
              "---\ntype: claim\nstatus: proposed\nknowledge_layer: project\n---\n# Compiler publication boundary\n\nCanonical publication requires governed human review. This candidate is promoted from durable workspace evidence and must not become approved knowledge through agent agreement or session memory alone.\n",
            reason:
              "Promote the shared finding through the existing review lifecycle",
          },
        ],
      },
    });
    expect(promotion.statusCode).toBe(201);
    const promotionBody = promotion.json() as {
      reviewId: string;
      promotionEventId: string;
    };

    const agentCredential = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/agent-processes`,
      headers: actorAHeaders,
      payload: {
        label: "P2 approval-negative-test agent",
        durationMinutes: 30,
        allowedActions: [
          "workspace:read",
          "knowledge:read",
          "knowledge:propose",
        ],
      },
    });
    expect(agentCredential.statusCode).toBe(201);
    const agentToken = (agentCredential.json() as { token: string }).token;

    const agentApproval = await app.inject({
      method: "POST",
      url: `/v1/reviews/${promotionBody.reviewId}/decision`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        decision: "APPROVE",
        reason: "A normal agent credential must not approve publication.",
      },
    });
    expect(agentApproval.statusCode).toBe(403);
    expect(agentApproval.json()).toMatchObject({
      code: "PRINCIPAL_ROUTE_DENIED",
    });

    const humanApproval = await app.inject({
      method: "POST",
      url: `/v1/reviews/${promotionBody.reviewId}/decision`,
      headers: reviewerHeaders,
      payload: {
        decision: "APPROVE",
        reason: "Human reviewer accepts the evidence-preserving promotion.",
      },
    });
    expect(humanApproval.statusCode).toBe(200);
    const approved = humanApproval.json() as {
      status: string;
      mergedCommit: string;
    };
    expect(approved.status).toBe("APPROVED");
    expect(approved.mergedCommit).toMatch(/^[a-f0-9]{40}$/);

    const vaultRevision = await db.pool.query<{ current_revision: string }>(
      "select current_revision from vaults where id=$1 and space_id=$2",
      [vaultId, spaceId],
    );
    expect(vaultRevision.rows[0]?.current_revision).toBe(approved.mergedCommit);

    const oldState = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/state`,
      headers: actorAHeaders,
    });
    expect(oldState.statusCode).toBe(200);
    expect(oldState.json()).toMatchObject({
      contextRevision: {
        status: "CHANGED",
        changedDimensions: expect.arrayContaining(["knowledgeGit"]),
      },
    });

    const strictOldWrite = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims`,
      headers: actorAHeaders,
      payload: { workKey: "post-publication:stale", leaseSeconds: 120 },
    });
    expect(strictOldWrite.statusCode).toBe(409);
    expect(strictOldWrite.json()).toMatchObject({
      code: "CONTEXT_REVISION_CHANGED",
    });

    const nextSession = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: actorAHeaders,
      payload: {
        spaceId,
        vaultId,
        purpose: "Observe publication revision R2",
        contextBudget: 4096,
      },
    });
    expect(nextSession.statusCode).toBe(201);
    const next = nextSession.json() as {
      contextRevisionSetHash: string;
      contextRevisionSet: {
        dimensions: { knowledgeGit: { revision: string } };
      };
    };
    expect(next.contextRevisionSetHash).not.toBe(
      initialSession.contextRevisionSetHash,
    );
    expect(next.contextRevisionSet.dimensions.knowledgeGit.revision).toBe(
      approved.mergedCommit,
    );

    const publicationEvents = await db.pool.query<{ event_type: string }>(
      `select event_type from event_outbox
        where resource_id=$1
        order by occurred_at,event_id`,
      [promotionBody.reviewId],
    );
    expect(publicationEvents.rows.map((row) => row.event_type)).toEqual(
      expect.arrayContaining([
        "KnowledgePublished",
        "CorpusRevisionPublished",
        "LexicalIndexUpdateRequested",
        "VectorIndexUpdateRequested",
        "GraphIndexUpdateRequested",
        "ContextPackInvalidationRequested",
        "ImpactedEvalRunRequested",
      ]),
    );
  });
});
