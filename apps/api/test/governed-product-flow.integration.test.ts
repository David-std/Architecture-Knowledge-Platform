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

    // A finishes its compiler work and explicitly releases the scope instead of
    // waiting for the lease to lapse. That release, not a timeout, is what
    // unblocks the overlapping claim B was denied above.
    const compilerRelease = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims/release`,
      headers: actorAHeaders,
      payload: { workKey: "packages/compiler/**", fencingToken: 1 },
    });
    expect(compilerRelease.statusCode).toBe(200);
    expect(compilerRelease.json()).toMatchObject({
      ownerId: actorAId,
      workKey: "packages/compiler/**",
      status: "RELEASED",
      fencingToken: 2,
    });

    const overlapAfterRelease = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims`,
      headers: actorBHeaders,
      payload: { workKey: "packages/compiler/src/**", leaseSeconds: 120 },
    });
    expect(overlapAfterRelease.statusCode).toBe(201);
    expect(overlapAfterRelease.json()).toMatchObject({
      ownerId: actorBId,
      workKey: "packages/compiler/src/**",
      status: "ACTIVE",
    });

    // A cannot keep writing under the fence it just gave up.
    const staleCompilerWriter = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims/heartbeat`,
      headers: actorAHeaders,
      payload: {
        workKey: "packages/compiler/**",
        fencingToken: 1,
        leaseSeconds: 120,
      },
    });
    expect(staleCompilerWriter.statusCode).toBe(409);
    expect(staleCompilerWriter.json()).toMatchObject({
      code: "WORK_CLAIM_FENCE_STALE",
    });

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
    ).toEqual(
      expect.arrayContaining(["FINDING", "CLAIM_RELEASED", "CLAIM_HANDOFF"]),
    );

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

  it("captures consultative decisions, keeps agent suggestions non-authoritative, and supersedes only after human publication", async () => {
    const humanPrincipals = await db.pool.query<{
      id: string;
      user_id: string;
    }>(
      `select id,user_id from principals
        where kind='HUMAN' and user_id=any($1::uuid[])`,
      [[actorAId, actorBId, reviewerId]],
    );
    const principalByUser = new Map(
      humanPrincipals.rows.map((row) => [row.user_id, row.id]),
    );
    const actorAPrincipalId = principalByUser.get(actorAId);
    const actorBPrincipalId = principalByUser.get(actorBId);
    const reviewerPrincipalId = principalByUser.get(reviewerId);
    expect(actorAPrincipalId).toBeTruthy();
    expect(actorBPrincipalId).toBeTruthy();
    expect(reviewerPrincipalId).toBeTruthy();

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: actorAHeaders,
      payload: {
        spaceId,
        vaultId,
        purpose: "Consultative architecture decision workflow",
        contextBudget: 4096,
      },
    });
    expect(created.statusCode).toBe(201);
    const sessionId = (created.json() as { id: string }).id;

    for (const userId of [actorBId, reviewerId]) {
      const joined = await app.inject({
        method: "POST",
        url: `/v1/sessions/${sessionId}/participants`,
        headers: actorAHeaders,
        payload: { userId },
      });
      expect(joined.statusCode).toBe(201);
    }

    const agentCredential = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/agent-processes`,
      headers: actorAHeaders,
      payload: {
        label: "P2 decision-preparation agent",
        durationMinutes: 30,
        allowedActions: [
          "workspace:read",
          "workspace:event:append",
          "knowledge:read",
          "knowledge:propose",
        ],
      },
    });
    expect(agentCredential.statusCode).toBe(201);
    const agent = agentCredential.json() as {
      token: string;
      principal: { id: string };
    };
    const agentHeaders = { authorization: `Bearer ${agent.token}` };

    const createdDecision = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/decisions`,
      headers: agentHeaders,
      payload: {
        decisionAuthorityPrincipalId: reviewerPrincipalId,
        title: "Context delivery mode",
        problem:
          "Choose how the workspace should expose an approved context projection without allowing coordination state to become canonical knowledge.",
        drivers: [
          "permission fidelity",
          "offline behavior",
          "revision correctness",
        ],
        affectedRefs: ["service:context-api", "work:connector-runtime"],
        evidenceRefs: ["fixture:connector-capabilities", "fixture:p2-flow"],
        verificationPlan:
          "Re-run the governed two-agent flow and verify that publication advances the canonical revision while stale sessions fail closed.",
        decisionDeadline: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(createdDecision.statusCode).toBe(201);
    const firstDecision = createdDecision.json() as {
      id: string;
      createdByPrincipalId: string;
      decisionAuthorityPrincipalId: string;
      status: string;
    };
    expect(firstDecision).toMatchObject({
      createdByPrincipalId: agent.principal.id,
      decisionAuthorityPrincipalId: reviewerPrincipalId,
      status: "DRAFT",
    });

    const agentAlternative = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/decisions/${firstDecision.id}/alternatives`,
      headers: agentHeaders,
      payload: {
        title: "Mirror the governed projection",
        description:
          "Serve an indexed local projection whose source permissions can be reproduced exactly.",
        tradeoffs:
          "Supports offline reads but requires explicit freshness and deletion propagation semantics.",
        evidenceRefs: ["fixture:mirror-indexed"],
      },
    });
    expect(agentAlternative.statusCode).toBe(201);
    const suggested = agentAlternative.json() as {
      id: string;
      origin: string;
      status: string;
    };
    expect(suggested).toMatchObject({
      origin: "AGENT_SUGGESTED",
      status: "SUGGESTED",
    });

    const humanAlternative = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/decisions/${firstDecision.id}/alternatives`,
      headers: actorAHeaders,
      payload: {
        title: "Resolve every reference live",
        description:
          "Keep only safe identifiers locally and resolve approved content from its source whenever it is requested.",
        tradeoffs:
          "Avoids mirrored content but makes availability and latency depend on the source system.",
        evidenceRefs: ["fixture:reference-live"],
      },
    });
    expect(humanAlternative.statusCode).toBe(201);
    const humanAlternativeBody = humanAlternative.json() as {
      id: string;
      origin: string;
      status: string;
    };
    expect(humanAlternativeBody).toMatchObject({
      origin: "HUMAN_SUBMITTED",
      status: "CONSIDERED",
    });

    const prematureSelection = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/decisions/${firstDecision.id}/selection`,
      headers: reviewerHeaders,
      payload: { alternativeId: suggested.id },
    });
    expect(prematureSelection.statusCode).toBe(409);
    expect(prematureSelection.json()).toMatchObject({
      code: "DECISION_ALTERNATIVE_NOT_CONSIDERED",
    });

    const acceptSuggestion = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/decisions/${firstDecision.id}/alternatives/${suggested.id}/decision`,
      headers: reviewerHeaders,
      payload: { decision: "CONSIDER" },
    });
    expect(acceptSuggestion.statusCode).toBe(200);
    expect(acceptSuggestion.json()).toMatchObject({
      id: suggested.id,
      origin: "AGENT_SUGGESTED",
      status: "CONSIDERED",
      decidedByPrincipalId: reviewerPrincipalId,
    });

    const consultation = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/decisions/${firstDecision.id}/consultations`,
      headers: reviewerHeaders,
      payload: {
        reviewerPrincipalId: actorBPrincipalId,
        question:
          "Does the mirrored option preserve the source authorization boundary in the two-agent workspace?",
      },
    });
    expect(consultation.statusCode).toBe(201);
    const consultationBody = consultation.json() as { id: string };

    const consultationResponse = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/decisions/${firstDecision.id}/consultations/${consultationBody.id}/respond`,
      headers: actorBHeaders,
      payload: {
        position: "SUPPORT",
        response:
          "Yes, provided the connector declares exact source ACL fidelity and stale mirrored state remains explicitly disclosed.",
      },
    });
    expect(consultationResponse.statusCode).toBe(200);
    expect(consultationResponse.json()).toMatchObject({
      status: "RESPONDED",
      position: "SUPPORT",
      reviewerPrincipalId: actorBPrincipalId,
    });

    const objection = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/decisions/${firstDecision.id}/objections`,
      headers: agentHeaders,
      payload: {
        alternativeId: suggested.id,
        statement:
          "The mirror must fail closed when its declared permission fidelity no longer matches the source.",
        evidenceRefs: ["fixture:permission-fidelity"],
      },
    });
    expect(objection.statusCode).toBe(201);
    const objectionBody = objection.json() as { id: string };
    expect(objection.json()).toMatchObject({
      status: "OPEN",
      authorPrincipalId: agent.principal.id,
    });

    const blockedByObjection = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/decisions/${firstDecision.id}/selection`,
      headers: reviewerHeaders,
      payload: { alternativeId: suggested.id },
    });
    expect(blockedByObjection.statusCode).toBe(409);
    expect(blockedByObjection.json()).toMatchObject({
      code: "DECISION_OPEN_OBJECTIONS",
    });

    const resolved = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/decisions/${firstDecision.id}/objections/${objectionBody.id}/resolve`,
      headers: reviewerHeaders,
      payload: {
        resolution:
          "Accepted as a hard connector-policy gate; mismatched permission fidelity denies use rather than degrading silently.",
      },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({
      status: "RESOLVED",
      resolvedByPrincipalId: reviewerPrincipalId,
    });

    const selected = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/decisions/${firstDecision.id}/selection`,
      headers: reviewerHeaders,
      payload: { alternativeId: suggested.id },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toMatchObject({
      status: "READY_FOR_REVIEW",
      selectedAlternativeId: suggested.id,
    });

    const captured = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/decisions/${firstDecision.id}/capture`,
      headers: agentHeaders,
    });
    expect(captured.statusCode).toBe(201);
    const capturedBody = captured.json() as { eventId: string };
    expect(captured.json()).toMatchObject({
      eventType: "DECISION_CANDIDATE",
      candidate: {
        id: firstDecision.id,
        status: "READY_FOR_REVIEW",
      },
    });

    const capturedAgain = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/decisions/${firstDecision.id}/capture`,
      headers: agentHeaders,
    });
    expect(capturedAgain.statusCode).toBe(201);
    expect(capturedAgain.json()).toMatchObject({
      eventId: capturedBody.eventId,
    });

    const firstPromotion = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/promotions`,
      headers: agentHeaders,
      payload: {
        evidenceEventIds: [capturedBody.eventId],
        summary: "Promote consulted context delivery decision",
        changes: [
          {
            path: `20-knowledge/generated/decision/context-delivery-${vaultId.slice(0, 8)}.md`,
            content:
              "---\\nid: P2-CONTEXT-DELIVERY\\ntype: decision\\nstatus: proposed\\nknowledge_layer: project\\n---\\n# Context delivery mode\\n\\nUse an indexed governed projection only when connector capabilities preserve the source authorization boundary. The alternative originated as an agent suggestion, was explicitly considered by the human decision authority, received independent consultation, and resolved its open objection before entering governed review.\\n",
            reason:
              "Promote only the captured consultative decision through human review.",
          },
        ],
      },
    });
    expect(firstPromotion.statusCode).toBe(201);
    const firstPromotionBody = firstPromotion.json() as {
      reviewId: string;
      decisionCandidateId: string;
    };
    expect(firstPromotionBody.decisionCandidateId).toBe(firstDecision.id);

    const pendingSnapshot = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/decisions/${firstDecision.id}`,
      headers: reviewerHeaders,
    });
    expect(pendingSnapshot.statusCode).toBe(200);
    expect(pendingSnapshot.json()).toMatchObject({
      candidate: {
        id: firstDecision.id,
        status: "PENDING_REVIEW",
        reviewId: firstPromotionBody.reviewId,
        reviewStatus: "PENDING",
      },
    });

    const agentApproval = await app.inject({
      method: "POST",
      url: `/v1/reviews/${firstPromotionBody.reviewId}/decision`,
      headers: agentHeaders,
      payload: {
        decision: "APPROVE",
        reason:
          "An agent that prepared the candidate still must not approve canonical publication.",
      },
    });
    expect(agentApproval.statusCode).toBe(403);
    expect(agentApproval.json()).toMatchObject({
      code: "PRINCIPAL_ROUTE_DENIED",
    });

    const firstApproval = await app.inject({
      method: "POST",
      url: `/v1/reviews/${firstPromotionBody.reviewId}/decision`,
      headers: reviewerHeaders,
      payload: {
        decision: "APPROVE",
        reason:
          "Human decision authority approves the consulted, evidence-linked candidate.",
      },
    });
    expect(firstApproval.statusCode).toBe(200);
    const firstApproved = firstApproval.json() as {
      status: string;
      mergedCommit: string;
    };
    expect(firstApproved.status).toBe("APPROVED");

    const approvedSnapshot = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/decisions/${firstDecision.id}`,
      headers: reviewerHeaders,
    });
    expect(approvedSnapshot.statusCode).toBe(200);
    expect(approvedSnapshot.json()).toMatchObject({
      candidate: {
        id: firstDecision.id,
        status: "APPROVED",
        publishedRevision: firstApproved.mergedCommit,
      },
    });

    const secondSessionResponse = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: actorAHeaders,
      payload: {
        spaceId,
        vaultId,
        purpose: "Supersede an approved architecture decision",
        contextBudget: 4096,
      },
    });
    expect(secondSessionResponse.statusCode).toBe(201);
    const secondSessionId = (secondSessionResponse.json() as { id: string }).id;
    for (const userId of [actorBId, reviewerId]) {
      const joined = await app.inject({
        method: "POST",
        url: `/v1/sessions/${secondSessionId}/participants`,
        headers: actorAHeaders,
        payload: { userId },
      });
      expect(joined.statusCode).toBe(201);
    }

    const replacement = await app.inject({
      method: "POST",
      url: `/v1/sessions/${secondSessionId}/decisions`,
      headers: actorAHeaders,
      payload: {
        decisionAuthorityPrincipalId: reviewerPrincipalId,
        title: "Context delivery mode v2",
        problem:
          "Supersede the original choice after operational evidence requires live revalidation for a subset of sources.",
        drivers: ["freshness", "permission fidelity", "provider availability"],
        affectedRefs: ["service:context-api"],
        evidenceRefs: ["fixture:first-decision", "fixture:operational-change"],
        verificationPlan:
          "Verify the replacement through the same governed publication path and confirm that the predecessor is marked superseded atomically.",
        supersedesCandidateId: firstDecision.id,
      },
    });
    expect(replacement.statusCode).toBe(201);
    const replacementBody = replacement.json() as { id: string };

    const replacementAltA = await app.inject({
      method: "POST",
      url: `/v1/sessions/${secondSessionId}/decisions/${replacementBody.id}/alternatives`,
      headers: actorAHeaders,
      payload: {
        title: "Hybrid bounded cache",
        description:
          "Use bounded local cache with live revalidation where source policy permits it.",
        tradeoffs:
          "Improves availability but stale windows must be bounded and disclosed.",
      },
    });
    expect(replacementAltA.statusCode).toBe(201);
    const replacementAltAId = (replacementAltA.json() as { id: string }).id;

    const replacementAltB = await app.inject({
      method: "POST",
      url: `/v1/sessions/${secondSessionId}/decisions/${replacementBody.id}/alternatives`,
      headers: actorBHeaders,
      payload: {
        title: "Live reference only",
        description:
          "Use only live references for the changed provider.",
        tradeoffs:
          "Strong freshness but no offline content when the provider is unavailable.",
      },
    });
    expect(replacementAltB.statusCode).toBe(201);

    const replacementConsultation = await app.inject({
      method: "POST",
      url: `/v1/sessions/${secondSessionId}/decisions/${replacementBody.id}/consultations`,
      headers: reviewerHeaders,
      payload: {
        reviewerPrincipalId: actorBPrincipalId,
        question:
          "Is a bounded hybrid cache preferable to live-only access for this source?",
      },
    });
    expect(replacementConsultation.statusCode).toBe(201);
    const replacementConsultationId = (
      replacementConsultation.json() as { id: string }
    ).id;

    const replacementResponse = await app.inject({
      method: "POST",
      url: `/v1/sessions/${secondSessionId}/decisions/${replacementBody.id}/consultations/${replacementConsultationId}/respond`,
      headers: actorBHeaders,
      payload: {
        position: "SUPPORT",
        response:
          "A bounded cache is acceptable when its stale window is explicit and permission fidelity remains enforced.",
      },
    });
    expect(replacementResponse.statusCode).toBe(200);

    const replacementSelection = await app.inject({
      method: "POST",
      url: `/v1/sessions/${secondSessionId}/decisions/${replacementBody.id}/selection`,
      headers: reviewerHeaders,
      payload: { alternativeId: replacementAltAId },
    });
    expect(replacementSelection.statusCode).toBe(200);
    expect(replacementSelection.json()).toMatchObject({
      status: "READY_FOR_REVIEW",
    });

    const replacementCapture = await app.inject({
      method: "POST",
      url: `/v1/sessions/${secondSessionId}/decisions/${replacementBody.id}/capture`,
      headers: actorAHeaders,
    });
    expect(replacementCapture.statusCode).toBe(201);
    const replacementEventId = (
      replacementCapture.json() as { eventId: string }
    ).eventId;

    const replacementPromotion = await app.inject({
      method: "POST",
      url: `/v1/sessions/${secondSessionId}/promotions`,
      headers: actorAHeaders,
      payload: {
        evidenceEventIds: [replacementEventId],
        summary: "Supersede context delivery decision",
        changes: [
          {
            path: `20-knowledge/generated/decision/context-delivery-v2-${vaultId.slice(0, 8)}.md`,
            content:
              "---\\nid: P2-CONTEXT-DELIVERY-V2\\ntype: decision\\nstatus: proposed\\nknowledge_layer: project\\n---\\n# Context delivery mode v2\\n\\nUse a bounded hybrid cache only where permission fidelity is preserved and stale state is explicitly disclosed. This replacement was consulted independently and is not authoritative until the governed human review publishes it.\\n",
            reason:
              "Publish the replacement through the existing review authority.",
          },
        ],
      },
    });
    expect(replacementPromotion.statusCode).toBe(201);
    const replacementReviewId = (
      replacementPromotion.json() as { reviewId: string }
    ).reviewId;

    const replacementApproval = await app.inject({
      method: "POST",
      url: `/v1/reviews/${replacementReviewId}/decision`,
      headers: reviewerHeaders,
      payload: {
        decision: "APPROVE",
        reason:
          "Human reviewer approves the replacement and its explicit supersession link.",
      },
    });
    expect(replacementApproval.statusCode).toBe(200);
    const replacementApproved = replacementApproval.json() as {
      mergedCommit: string;
    };

    const supersessionState = await db.pool.query<{
      id: string;
      status: string;
      supersedes_candidate_id: string | null;
      superseded_by_candidate_id: string | null;
      published_revision: string | null;
    }>(
      `select id,status,supersedes_candidate_id,
              superseded_by_candidate_id,published_revision
         from workspace_decision_candidates
        where id=any($1::uuid[])
        order by id`,
      [[firstDecision.id, replacementBody.id]],
    );
    const predecessor = supersessionState.rows.find(
      (row) => row.id === firstDecision.id,
    );
    const successor = supersessionState.rows.find(
      (row) => row.id === replacementBody.id,
    );
    expect(predecessor).toMatchObject({
      status: "SUPERSEDED",
      superseded_by_candidate_id: replacementBody.id,
      published_revision: firstApproved.mergedCommit,
    });
    expect(successor).toMatchObject({
      status: "APPROVED",
      supersedes_candidate_id: firstDecision.id,
      published_revision: replacementApproved.mergedCommit,
    });
  });

});
