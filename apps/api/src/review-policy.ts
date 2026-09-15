import { createHash } from "node:crypto";
import {
  EffectiveReviewPolicy,
  defaultCompilerKnowledgeProfileContext,
  durableCompilerKnowledgeProfileContext,
  effectiveReviewPolicyForKinds,
  type CompilerKnowledgeProfileContext,
  type EffectiveReviewPolicy as EffectiveReviewPolicyType,
} from "@akp/compiler";
import {
  resolveKnowledgeProfileBinding,
  type Postgres,
  type PostgresPoolClient,
} from "@akp/postgres";
import { rolesForPermission, type Actor } from "./auth.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function canonicalPolicyValue(policy: EffectiveReviewPolicyType) {
  return {
    required: true,
    minimumApprovals: policy.minimumApprovals,
    allowedRoles: [...policy.allowedRoles].sort(),
    profileSource: policy.profileSource,
    profileRevisionId: policy.profileRevisionId,
    profileHash: policy.profileHash,
    profileId: policy.profileId,
    profileVersion: policy.profileVersion,
  };
}

export function reviewPolicyFingerprint(
  policy: EffectiveReviewPolicyType,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalPolicyValue(policy)))
    .digest("hex");
}

function defaultReviewPolicy(): EffectiveReviewPolicyType {
  const context = defaultCompilerKnowledgeProfileContext();
  const fallbackKind = Object.keys(context.profile.knowledgeKinds)[0];
  if (!fallbackKind) throw new Error("DEFAULT_REVIEW_POLICY_KIND_REQUIRED");
  return effectiveReviewPolicyForKinds(context, [fallbackKind]);
}

function manifestReviewKinds(manifest: Record<string, unknown>): string[] {
  const explicit = manifest.reviewKinds;
  if (Array.isArray(explicit)) {
    return [
      ...new Set(
        explicit.filter((kind): kind is string => typeof kind === "string"),
      ),
    ];
  }
  const context = asRecord(manifest.reviewContext);
  const nested = context.reviewKinds;
  if (Array.isArray(nested) && nested.length > 0) {
    return [
      ...new Set(
        nested.filter((kind): kind is string => typeof kind === "string"),
      ),
    ];
  }
  const candidates = Array.isArray(context.knowledgeCandidates)
    ? context.knowledgeCandidates
    : [];
  return [
    ...new Set(
      candidates.flatMap((candidate) => {
        const record = asRecord(candidate);
        return typeof record.kind === "string" ? [record.kind] : [];
      }),
    ),
  ];
}

export interface ReviewPolicyState {
  policy: EffectiveReviewPolicyType;
  fingerprint: string;
  pinned: boolean;
  kinds: string[];
}

export function reviewPolicyState(
  review: Record<string, unknown>,
): ReviewPolicyState {
  const manifest = asRecord(review.impact_manifest);
  const context = asRecord(manifest.reviewContext);
  const hasTopLevel = Object.hasOwn(manifest, "reviewPolicy");
  const hasNested = Object.hasOwn(context, "reviewPolicy");
  const candidate = hasTopLevel ? manifest.reviewPolicy : context.reviewPolicy;
  if (hasTopLevel || hasNested) {
    const parsed = EffectiveReviewPolicy.safeParse(candidate);
    if (!parsed.success) throw new Error("REVIEW_POLICY_SNAPSHOT_INVALID");
    const kinds = manifestReviewKinds(manifest);
    const pinned = hasTopLevel ? manifest.reviewPolicyPinned !== false : true;
    if (pinned && kinds.length === 0) {
      throw new Error("REVIEW_POLICY_KINDS_REQUIRED");
    }
    return {
      policy: parsed.data,
      fingerprint: reviewPolicyFingerprint(parsed.data),
      pinned,
      kinds,
    };
  }
  const policy = defaultReviewPolicy();
  return {
    policy,
    fingerprint: reviewPolicyFingerprint(policy),
    pinned: false,
    kinds: [],
  };
}

export async function resolveProposalReviewPolicy(
  db: Postgres,
  spaceId: string,
  vaultId: string,
  kinds: readonly string[],
): Promise<{ policy: EffectiveReviewPolicyType; pinned: boolean }> {
  const binding = await resolveKnowledgeProfileBinding(db, spaceId, vaultId);
  if (binding.source === "LEGACY_UNBOUND") {
    return { policy: defaultReviewPolicy(), pinned: true };
  }
  const revision = binding.revision;
  if (!revision) throw new Error("ACTIVE_KNOWLEDGE_PROFILE_BINDING_INVALID");
  const context = durableCompilerKnowledgeProfileContext({
    revisionId: revision.id,
    profileHash: revision.profileHash,
    profile: revision.profile,
  });
  return {
    policy: effectiveReviewPolicyForKinds(context, kinds),
    pinned: true,
  };
}

async function currentProfileContextForUpdate(
  client: PostgresPoolClient,
  spaceId: string,
  vaultId: string,
): Promise<CompilerKnowledgeProfileContext> {
  const result = await client.query<{
    active_revision_id: string | null;
    profile_revision_id: string | null;
    profile_hash: string | null;
    canonical_profile: string | null;
  }>(
    `
    select v.active_knowledge_profile_revision_id active_revision_id,
           p.id profile_revision_id,p.profile_hash,p.canonical_profile
      from vaults v
      left join knowledge_profile_revisions p
        on p.id=v.active_knowledge_profile_revision_id
       and p.space_id=v.space_id and p.vault_id=v.id and p.status='ACTIVE'
     where v.space_id=$1 and v.id=$2 and v.enabled
     for update of v
    `,
    [spaceId, vaultId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("REVIEW_PROFILE_STALE");
  if (!row.active_revision_id) return defaultCompilerKnowledgeProfileContext();
  if (
    row.profile_revision_id !== row.active_revision_id ||
    !row.profile_hash ||
    !row.canonical_profile
  ) {
    throw new Error("REVIEW_PROFILE_STALE");
  }
  try {
    return durableCompilerKnowledgeProfileContext({
      revisionId: row.profile_revision_id,
      profileHash: row.profile_hash,
      profile: JSON.parse(row.canonical_profile),
    });
  } catch {
    throw new Error("REVIEW_PROFILE_STALE");
  }
}

async function assertPinnedPolicyCurrent(
  client: PostgresPoolClient,
  review: Record<string, unknown>,
  state: ReviewPolicyState,
): Promise<void> {
  if (!state.pinned) return;
  const spaceId = String(review.space_id ?? "");
  const vaultId = String(review.vault_id ?? "");
  if (!spaceId || !vaultId || state.kinds.length === 0) {
    throw new Error("REVIEW_PROFILE_STALE");
  }
  try {
    const current = await currentProfileContextForUpdate(
      client,
      spaceId,
      vaultId,
    );
    const expected = effectiveReviewPolicyForKinds(current, state.kinds);
    if (reviewPolicyFingerprint(expected) !== state.fingerprint) {
      throw new Error("REVIEW_PROFILE_STALE");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "REVIEW_PROFILE_STALE") {
      throw error;
    }
    throw new Error("REVIEW_PROFILE_STALE");
  }
}

function reviewRound(review: Record<string, unknown>): number {
  const value = Number(review.review_round ?? 1);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("REVIEW_ROUND_INVALID");
  }
  return value;
}

export interface ReviewApprovalResult {
  review: Record<string, unknown>;
  policy: EffectiveReviewPolicyType;
  policyFingerprint: string;
  reviewRound: number;
  headCommit: string;
  reviewerRole: string;
  approvalCount: number;
  minimumApprovals: number;
  quorumReached: boolean;
  duplicate: boolean;
}

export async function recordReviewApproval(
  db: Postgres,
  input: {
    reviewId: string;
    actor: Actor;
    reason: string;
  },
): Promise<ReviewApprovalResult> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const found = await client.query<Record<string, unknown>>(
      "select * from reviews where id=$1 for update",
      [input.reviewId],
    );
    const review = found.rows[0];
    if (!review) throw new Error("REVIEW_NOT_FOUND");
    if (!["PENDING", "CHANGES_REQUESTED"].includes(String(review.status))) {
      throw new Error("REVIEW_ALREADY_DECIDED");
    }
    const state = reviewPolicyState(review);
    const effectiveRoles = rolesForPermission(
      input.actor,
      String(review.space_id),
      "knowledge:review",
    );
    const reviewerRole = state.policy.allowedRoles.find((role) =>
      effectiveRoles.includes(role),
    );
    if (!reviewerRole) throw new Error("REVIEW_ROLE_NOT_ALLOWED");
    await assertPinnedPolicyCurrent(client, review, state);
    const round = reviewRound(review);
    const headCommit = String(review.head_commit ?? "");
    if (!headCommit) throw new Error("REVIEW_HEAD_REQUIRED");
    const inserted = await client.query(
      `
      insert into review_approvals(
        review_id,review_round,head_commit,policy_fingerprint,profile_source,
        profile_revision_id,profile_hash,reviewer_id,reviewer_role,reason
      ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      on conflict(review_id,review_round,head_commit,policy_fingerprint,reviewer_id)
      do nothing
      returning id
      `,
      [
        input.reviewId,
        round,
        headCommit,
        state.fingerprint,
        state.policy.profileSource,
        state.policy.profileRevisionId,
        state.policy.profileHash,
        input.actor.id,
        reviewerRole,
        input.reason.trim(),
      ],
    );
    const counted = await client.query<{ count: number }>(
      `
      select count(*)::int count from review_approvals
       where review_id=$1 and review_round=$2 and head_commit=$3
         and policy_fingerprint=$4
      `,
      [input.reviewId, round, headCommit, state.fingerprint],
    );
    const approvalCount = Number(counted.rows[0]?.count ?? 0);
    await client.query("commit");
    return {
      review,
      policy: state.policy,
      policyFingerprint: state.fingerprint,
      reviewRound: round,
      headCommit,
      reviewerRole,
      approvalCount,
      minimumApprovals: state.policy.minimumApprovals,
      quorumReached: approvalCount >= state.policy.minimumApprovals,
      duplicate: !inserted.rowCount,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function claimReviewForPublication(
  db: Postgres,
  input: {
    reviewId: string;
    expectedHeadCommit: string;
    expectedPolicyFingerprint: string;
    expectedReviewRound: number;
    actorId: string;
    reason: string;
  },
): Promise<Record<string, unknown>> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const found = await client.query<Record<string, unknown>>(
      "select * from reviews where id=$1 for update",
      [input.reviewId],
    );
    const review = found.rows[0];
    if (!review) throw new Error("REVIEW_NOT_FOUND");
    if (!["PENDING", "CHANGES_REQUESTED"].includes(String(review.status))) {
      throw new Error("REVIEW_ALREADY_DECIDED");
    }
    const round = reviewRound(review);
    const state = reviewPolicyState(review);
    if (
      String(review.head_commit) !== input.expectedHeadCommit ||
      round !== input.expectedReviewRound ||
      state.fingerprint !== input.expectedPolicyFingerprint
    ) {
      throw new Error("REVIEW_APPROVAL_CONTEXT_CHANGED");
    }
    await assertPinnedPolicyCurrent(client, review, state);
    const counted = await client.query<{ count: number }>(
      `
      select count(*)::int count from review_approvals
       where review_id=$1 and review_round=$2 and head_commit=$3
         and policy_fingerprint=$4
      `,
      [input.reviewId, round, input.expectedHeadCommit, state.fingerprint],
    );
    if (Number(counted.rows[0]?.count ?? 0) < state.policy.minimumApprovals) {
      throw new Error("REVIEW_APPROVAL_QUORUM_NOT_MET");
    }
    const claimed = await client.query<Record<string, unknown>>(
      `
      update reviews
         set status='PUBLISHING',decision_by=$2,decision_at=now(),
             decision_reason=$3,updated_at=now()
       where id=$1 and status in ('PENDING','CHANGES_REQUESTED')
         and head_commit=$4 and review_round=$5
       returning *
      `,
      [
        input.reviewId,
        input.actorId,
        input.reason.trim(),
        input.expectedHeadCommit,
        round,
      ],
    );
    const row = claimed.rows[0];
    if (!row) throw new Error("REVIEW_APPROVAL_CONTEXT_CHANGED");
    await client.query("commit");
    return row;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function reviewApprovalStatus(
  db: Postgres,
  review: Record<string, unknown>,
) {
  const state = reviewPolicyState(review);
  const round = reviewRound(review);
  const result = await db.pool.query<{
    reviewer_id: string;
    reviewer_role: string;
    reason: string;
    created_at: Date;
  }>(
    `
    select reviewer_id,reviewer_role,reason,created_at
      from review_approvals
     where review_id=$1 and review_round=$2 and head_commit=$3
       and policy_fingerprint=$4
     order by created_at,reviewer_id
    `,
    [review.id, round, review.head_commit, state.fingerprint],
  );
  return {
    policy: state.policy,
    pinned: state.pinned,
    reviewRound: round,
    approvalCount: result.rows.length,
    minimumApprovals: state.policy.minimumApprovals,
    remainingApprovals: Math.max(
      0,
      state.policy.minimumApprovals - result.rows.length,
    ),
    approvals: result.rows.map((row) => ({
      reviewerId: row.reviewer_id,
      reviewerRole: row.reviewer_role,
      reason: row.reason,
      createdAt: row.created_at,
    })),
  };
}
