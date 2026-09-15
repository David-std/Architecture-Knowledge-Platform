import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  KnowledgeProfileV1,
  NEUTRAL_KNOWLEDGE_PROFILE_V1,
  canonicalKnowledgeProfileJson,
} from "@akp/contracts/knowledge-profile";
import { Postgres, grantVaultMembership } from "@akp/postgres";

const spaceId = "00000000-0000-0000-0000-000000000003";
const adminId = "00000000-0000-0000-0000-000000000002";
const reviewerOneId = randomUUID();
const reviewerTwoId = randomUUID();
const vaultId = randomUUID();
const adminToken = `review-policy-admin-${randomUUID()}`;
const reviewerOneToken = `review-policy-one-${randomUUID()}`;
const reviewerTwoToken = `review-policy-two-${randomUUID()}`;
const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const adminHeaders = { authorization: `Bearer ${adminToken}` };
const reviewerOneHeaders = { authorization: `Bearer ${reviewerOneToken}` };
const reviewerTwoHeaders = { authorization: `Bearer ${reviewerTwoToken}` };

let app: FastifyInstance;
let db: Postgres;
let fixtureRoot: string;
let activeProfileRevisionId: string;
const reviewIds = new Set<string>();
const previousManagedRepository = process.env.AKP_MANAGED_REPO;

function profile(version: string) {
  return KnowledgeProfileV1.parse({
    ...NEUTRAL_KNOWLEDGE_PROFILE_V1,
    version,
    reviewPolicies: {
      ...NEUTRAL_KNOWLEDGE_PROFILE_V1.reviewPolicies,
      "neutral-review": {
        required: true,
        minimumApprovals: 2,
        allowedRoles: ["REVIEWER"],
      },
    },
  });
}

async function activateProfile(version: string): Promise<string> {
  const candidate = profile(version);
  const canonical = canonicalKnowledgeProfileJson(candidate);
  const hash = createHash("sha256").update(canonical).digest("hex");
  const revisionId = randomUUID();
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `update knowledge_profile_revisions
          set status='SUPERSEDED',superseded_at=now(),updated_at=now()
        where vault_id=$1 and status='ACTIVE'`,
      [vaultId],
    );
    await client.query(
      `
      insert into knowledge_profile_revisions(
        id,space_id,vault_id,profile_id,version,profile_hash,canonical_profile,
        status,compatibility_class,created_by,validation_report,validated_at,activated_at
      ) values($1,$2,$3,$4,$5,$6,$7,'ACTIVE','NON_BREAKING',$8,'{}'::jsonb,now(),now())
      `,
      [
        revisionId,
        spaceId,
        vaultId,
        candidate.profileId,
        version,
        hash,
        canonical,
        adminId,
      ],
    );
    await client.query(
      "update vaults set active_knowledge_profile_revision_id=$2 where id=$1 and space_id=$3",
      [vaultId, revisionId, spaceId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  activeProfileRevisionId = revisionId;
  return revisionId;
}

function documentContent(type = "note"): string {
  return `---
type: ${type}
title: Review policy integration fixture
status: DRAFT
knowledge_layer: notes
---

# Review policy integration fixture

This deliberately substantive document proves durable profile-bound review
policy enforcement with multiple distinct human reviewers and a pinned profile
revision. The body is intentionally longer than the validation thin-content
threshold so the integration path exercises review governance rather than a
content warning.
`;
}

async function propose(type = "note") {
  const response = await app.inject({
    method: "POST",
    url: "/v1/proposals",
    headers: adminHeaders,
    payload: {
      spaceId,
      vaultId,
      summary: `review policy ${type}`,
      changes: [
        {
          path: `knowledge/${type}/${randomUUID()}.md`,
          content: documentContent(type),
        },
      ],
    },
  });
  if (response.statusCode === 201) {
    reviewIds.add((response.json() as { reviewId: string }).reviewId);
  }
  return response;
}

async function approve(reviewId: string, headers: Record<string, string>) {
  return app.inject({
    method: "POST",
    url: `/v1/reviews/${reviewId}/decision`,
    headers,
    payload: { decision: "APPROVE", reason: "profile policy approval" },
  });
}

async function requestChanges(
  reviewId: string,
  headers: Record<string, string>,
) {
  return app.inject({
    method: "POST",
    url: `/v1/reviews/${reviewId}/decision`,
    headers,
    payload: {
      decision: "REQUEST_CHANGES",
      reason: "profile policy revision requested",
    },
  });
}

async function proposedPath(reviewId: string): Promise<string> {
  const result = await db.pool.query<{
    impact_manifest: { proposedChanges?: Array<{ path?: string }> };
  }>("select impact_manifest from reviews where id=$1", [reviewId]);
  const candidate = result.rows[0]?.impact_manifest.proposedChanges?.[0]?.path;
  if (!candidate) throw new Error("TEST_REVIEW_PATH_REQUIRED");
  return candidate;
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests.");
  }
  process.env.NODE_ENV = "test";
  fixtureRoot = await mkdtemp(path.join(tmpdir(), "akp-review-policy-"));
  process.env.AKP_MANAGED_REPO = path.join(fixtureRoot, "managed-repository");
  db = new Postgres(process.env.DATABASE_URL);
  await db.pool.query(
    `
    insert into vaults(
      id,space_id,canonical_path,name,read_only,current_revision,vault_key,
      local_path,visibility,enabled
    ) values($1,$2,$3,$4,true,'fixture:initial',$5,$3,'PRIVATE',true)
    `,
    [
      vaultId,
      spaceId,
      path.join(fixtureRoot, "canonical-vault"),
      "Review policy integration vault",
      `review-policy-${vaultId.slice(0, 8)}`,
    ],
  );
  await db.pool.query(
    `insert into users(id,email,display_name) values
      ($1,$2,'Review Policy One'),($3,$4,'Review Policy Two')`,
    [
      reviewerOneId,
      `${reviewerOneId}@example.test`,
      reviewerTwoId,
      `${reviewerTwoId}@example.test`,
    ],
  );
  await db.pool.query(
    `insert into memberships(user_id,space_id,role,path_prefix) values
      ($1,$3,'REVIEWER',null),($2,$3,'REVIEWER',null)`,
    [reviewerOneId, reviewerTwoId, spaceId],
  );
  await grantVaultMembership(db, {
    userId: adminId,
    vaultId,
    role: "ADMIN",
    pathPrefix: null,
    permissions: [
      "knowledge:read",
      "source:read",
      "knowledge:propose",
      "knowledge:review",
      "admin",
    ],
  });
  for (const reviewerId of [reviewerOneId, reviewerTwoId]) {
    await grantVaultMembership(db, {
      userId: reviewerId,
      vaultId,
      role: "REVIEWER",
      pathPrefix: null,
      permissions: ["knowledge:read", "source:read", "knowledge:review"],
    });
  }
  const tokenRows = [
    {
      userId: adminId,
      token: adminToken,
      label: "review policy admin",
      permissions: [
        "knowledge:read",
        "source:read",
        "knowledge:propose",
        "knowledge:review",
        "admin",
      ],
    },
    {
      userId: reviewerOneId,
      token: reviewerOneToken,
      label: "review policy one",
      permissions: ["knowledge:read", "source:read", "knowledge:review"],
    },
    {
      userId: reviewerTwoId,
      token: reviewerTwoToken,
      label: "review policy two",
      permissions: ["knowledge:read", "source:read", "knowledge:review"],
    },
  ];
  for (const tokenRow of tokenRows) {
    await db.pool.query(
      `insert into api_tokens(user_id,token_hash,label,scopes)
       values($1,$2,$3,$4::jsonb)`,
      [
        tokenRow.userId,
        tokenHash(tokenRow.token),
        tokenRow.label,
        JSON.stringify({
          spaces: [
            { spaceId, pathPrefix: null, permissions: tokenRow.permissions },
          ],
        }),
      ],
    );
  }
  await activateProfile("1.0.1-review-policy");
  const module = await import("../src/server.js");
  app = module.buildServer();
});

afterAll(async () => {
  if (app) await app.close();
  if (db) {
    const ids = [...reviewIds];
    if (ids.length) {
      await db.pool.query(
        "delete from audit_events where resource_type='review' and resource_id=any($1::text[])",
        [ids],
      );
      await db.pool.query(
        "delete from error_book where metadata->>'reviewId'=any($1::text[])",
        [ids],
      );
      await db.pool.query("delete from reviews where id=any($1::uuid[])", [
        ids,
      ]);
    }
    await db.pool.query(
      "delete from api_tokens where token_hash=any($1::text[])",
      [
        [
          tokenHash(adminToken),
          tokenHash(reviewerOneToken),
          tokenHash(reviewerTwoToken),
        ],
      ],
    );
    await db.close();
  }
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  if (previousManagedRepository === undefined) {
    delete process.env.AKP_MANAGED_REPO;
  } else {
    process.env.AKP_MANAGED_REPO = previousManagedRepository;
  }
});

describe("KnowledgeProfile review policy integration", () => {
  it("requires allowed roles and two distinct reviewers before publication", async () => {
    const proposed = await propose("note");
    expect(proposed.statusCode).toBe(201);
    const reviewId = (proposed.json() as { reviewId: string }).reviewId;
    const persisted = await db.pool.query<{
      impact_manifest: Record<string, unknown>;
    }>("select impact_manifest from reviews where id=$1", [reviewId]);
    expect(persisted.rows[0]?.impact_manifest).toMatchObject({
      reviewKinds: ["note"],
      reviewPolicyPinned: true,
      reviewPolicy: {
        minimumApprovals: 2,
        allowedRoles: ["REVIEWER"],
        profileRevisionId: activeProfileRevisionId,
      },
    });

    const adminApproval = await approve(reviewId, adminHeaders);
    expect(adminApproval.statusCode).toBe(403);
    expect(adminApproval.json()).toMatchObject({
      code: "REVIEW_ROLE_NOT_ALLOWED",
    });

    const first = await approve(reviewId, reviewerOneHeaders);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      status: "PENDING",
      approvalProgress: { count: 1, minimumApprovals: 2 },
    });
    const duplicate = await approve(reviewId, reviewerOneHeaders);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({
      status: "PENDING",
      approvalProgress: { count: 1, minimumApprovals: 2, duplicate: true },
    });
    const beforeFinal = await db.pool.query<{ status: string }>(
      "select status from reviews where id=$1",
      [reviewId],
    );
    expect(beforeFinal.rows[0]?.status).toBe("PENDING");

    const second = await approve(reviewId, reviewerTwoHeaders);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      status: "APPROVED",
      approvalProgress: { count: 2, minimumApprovals: 2 },
    });
    const approvals = await db.pool.query<{ count: number }>(
      "select count(distinct reviewer_id)::int count from review_approvals where review_id=$1",
      [reviewId],
    );
    expect(approvals.rows[0]?.count).toBe(2);
  });

  it("fails closed when the active profile revision changes after review creation", async () => {
    const proposed = await propose("note");
    expect(proposed.statusCode).toBe(201);
    const reviewId = (proposed.json() as { reviewId: string }).reviewId;
    await activateProfile("1.0.2-review-policy");

    const stale = await approve(reviewId, reviewerOneHeaders);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "REVIEW_PROFILE_STALE" });
    const approvals = await db.pool.query<{ count: number }>(
      "select count(*)::int count from review_approvals where review_id=$1",
      [reviewId],
    );
    expect(approvals.rows[0]?.count).toBe(0);
  });

  it("rejects a direct proposal kind not declared by the durable profile", async () => {
    const response = await propose("rule");
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: "KNOWLEDGE_PROFILE_KIND_NOT_ALLOWED",
      kind: "rule",
    });
  });

  it("revalidates revised kinds instead of reusing the original review policy", async () => {
    const proposed = await propose("note");
    expect(proposed.statusCode).toBe(201);
    const reviewId = (proposed.json() as { reviewId: string }).reviewId;
    const path = await proposedPath(reviewId);
    const before = await db.pool.query<{
      head_commit: string;
      impact_manifest: Record<string, unknown>;
    }>("select head_commit,impact_manifest from reviews where id=$1", [
      reviewId,
    ]);

    const requested = await requestChanges(reviewId, reviewerOneHeaders);
    expect(requested.statusCode).toBe(200);
    expect(requested.json()).toMatchObject({ status: "CHANGES_REQUESTED" });

    const revised = await app.inject({
      method: "POST",
      url: `/v1/reviews/${reviewId}/revise`,
      headers: adminHeaders,
      payload: {
        summary: "attempt disallowed kind revision",
        changes: [{ path, content: documentContent("rule") }],
      },
    });
    expect(revised.statusCode).toBe(422);
    expect(revised.json()).toMatchObject({
      code: "KNOWLEDGE_PROFILE_KIND_NOT_ALLOWED",
      kind: "rule",
    });

    const after = await db.pool.query<{
      head_commit: string;
      impact_manifest: Record<string, unknown>;
    }>("select head_commit,impact_manifest from reviews where id=$1", [
      reviewId,
    ]);
    expect(after.rows[0]?.head_commit).toBe(before.rows[0]?.head_commit);
    expect(after.rows[0]?.impact_manifest).toMatchObject({
      reviewKinds: ["note"],
      reviewPolicy: { profileRevisionId: activeProfileRevisionId },
    });
  });

  it("pins new v0.3-default proposals so later profile activation makes them stale", async () => {
    await db.pool.query(
      "update vaults set active_knowledge_profile_revision_id=null where id=$1 and space_id=$2",
      [vaultId, spaceId],
    );
    await db.pool.query(
      `update knowledge_profile_revisions
          set status='SUPERSEDED',superseded_at=now(),updated_at=now()
        where vault_id=$1 and status='ACTIVE'`,
      [vaultId],
    );

    const proposed = await propose("rule");
    expect(proposed.statusCode).toBe(201);
    const reviewId = (proposed.json() as { reviewId: string }).reviewId;
    const persisted = await db.pool.query<{
      impact_manifest: Record<string, unknown>;
    }>("select impact_manifest from reviews where id=$1", [reviewId]);
    expect(persisted.rows[0]?.impact_manifest).toMatchObject({
      reviewKinds: ["rule"],
      reviewPolicyPinned: true,
      reviewPolicy: {
        profileSource: "V03_DEFAULT",
        profileRevisionId: null,
      },
    });

    await activateProfile("1.0.3-default-stale");
    const stale = await approve(reviewId, reviewerOneHeaders);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "REVIEW_PROFILE_STALE" });
  });

  it("rebinds an explicit revision to the current profile policy snapshot", async () => {
    const proposed = await propose("note");
    expect(proposed.statusCode).toBe(201);
    const reviewId = (proposed.json() as { reviewId: string }).reviewId;
    const path = await proposedPath(reviewId);
    const requested = await requestChanges(reviewId, reviewerOneHeaders);
    expect(requested.statusCode).toBe(200);

    const newRevisionId = await activateProfile("1.0.4-review-rebind");
    const revised = await app.inject({
      method: "POST",
      url: `/v1/reviews/${reviewId}/revise`,
      headers: adminHeaders,
      payload: {
        summary: "rebind review to current profile",
        changes: [{ path, content: documentContent("note") }],
      },
    });
    expect(revised.statusCode).toBe(200);

    const persisted = await db.pool.query<{
      impact_manifest: Record<string, unknown>;
    }>("select impact_manifest from reviews where id=$1", [reviewId]);
    expect(persisted.rows[0]?.impact_manifest).toMatchObject({
      reviewKinds: ["note"],
      reviewPolicyPinned: true,
      reviewPolicy: {
        minimumApprovals: 2,
        allowedRoles: ["REVIEWER"],
        profileRevisionId: newRevisionId,
      },
    });
  });
});
