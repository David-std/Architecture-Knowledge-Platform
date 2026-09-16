import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  pathMatchesVaultPrefix,
  resolveAuthorizedVaultScope,
  type AppendOutboxEventInput,
  type Postgres,
} from "@akp/postgres";
import { GitKnowledgeStore } from "@akp/git-store";
import { assertSafeKnowledgePath } from "@akp/compiler";
import {
  parseKnowledgeDocumentMetadata,
  validateMarkdownDocument,
} from "@akp/validation";
import { withSpan } from "@akp/observability";
import {
  assertManagedRepositoryBoundary,
  repositoryPublicationKey,
  synchronizeManagedPaths,
  type ManagedChange,
} from "../projections.js";
import {
  actorOf,
  audit,
  hasPathAccess,
  hasSpaceAccess,
  hasUnrestrictedPathAccess,
  requirePermission,
  spaceIdsForPermission,
} from "../auth.js";
import {
  claimReviewForPublication,
  recordReviewApproval,
  resolveProposalReviewPolicy,
  reviewApprovalStatus,
  reviewPolicyState,
} from "../review-policy.js";
import { createReviewDraft } from "../review-draft.js";

// Keep review routes importable by lightweight API tests that mock only the
// Postgres constructor. The helper is resolved lazily when a review is
// published, while still receiving the caller's transaction client.
type AppendHelper = (typeof import("@akp/postgres"))["appendOutboxEvent"];
type AppendTarget = Parameters<AppendHelper>[0];
type PublicationClient = Exclude<AppendTarget, Postgres>;
let reviewOutboxModule: Promise<typeof import("@akp/postgres")> | undefined;
async function appendReviewEvent(
  client: AppendTarget,
  input: AppendOutboxEventInput,
): Promise<Awaited<ReturnType<AppendHelper>>> {
  const module = await (reviewOutboxModule ??= import("@akp/postgres"));
  return module.appendOutboxEvent(client, input);
}

function repositoryPath(): string {
  const managed =
    process.env.AKP_MANAGED_REPO ||
    path.join(tmpdir(), "akp-managed-knowledge");
  assertManagedRepositoryBoundary(managed);
  return managed;
}

async function renewPublicationLock(
  db: Postgres,
  repositoryKey: string,
  owner: string,
): Promise<void> {
  const renewed = await db.pool.query(
    `
    update repository_publication_locks
       set expires_at=now()+interval '10 minutes',updated_at=now()
     where repository_key=$1 and owner=$2 and expires_at > now()
     returning repository_key
    `,
    [repositoryKey, owner],
  );
  if (!renewed.rowCount) {
    throw new Error("PUBLICATION_LOCK_LOST");
  }
}

/** `source-summary` is a v0.3 ingest/compiler provenance draft, not a
 * KnowledgeProfile kind. Only an already-persisted worker review whose
 * manifest points back to its durable ingest job may retain that legacy
 * shape while being revised. Direct proposals never reach this boundary. */
async function isLegacyWorkerSourceSummaryReview(
  db: Postgres,
  review: Record<string, unknown>,
  kinds: readonly string[],
): Promise<boolean> {
  if (
    kinds.length !== 1 ||
    kinds[0] !== "source-summary" ||
    reviewPolicyState(review).pinned
  ) {
    return false;
  }
  const manifest = (review.impact_manifest ?? {}) as Record<string, unknown>;
  const jobId = typeof manifest.jobId === "string" ? manifest.jobId : "";
  const spaceId = String(review.space_id ?? "");
  const vaultId = String(review.vault_id ?? "");
  const authorId =
    typeof review.author_id === "string" ? review.author_id : null;
  if (!jobId || !spaceId || !vaultId) return false;
  const source = await db.pool.query(
    `select 1
       from ingest_jobs
      where id::text=$1 and space_id=$2 and vault_id=$3
        and created_by is not distinct from $4::uuid
      limit 1`,
    [jobId, spaceId, vaultId, authorId],
  );
  return Boolean(source.rowCount);
}

async function recordPublicationFailure(
  db: Postgres,
  spaceId: string,
  rootCause: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db.pool.query(
    `
    insert into error_book(space_id,error_type,status,root_cause,metadata)
    values($1,'REVIEW_ESCAPE','OPEN',$2,$3::jsonb)
    `,
    [spaceId, rootCause, JSON.stringify(metadata)],
  );
}

/** Reconcile changed Git paths only for rollback compensation. Publication
 * success and crash recovery use the durable outbox instead. */
async function indexMergedChanges(
  db: Postgres,
  review: Record<string, unknown>,
  revision: string,
): Promise<void> {
  const manifest = review.impact_manifest as {
    sourceId?: string;
    proposedChanges?: Array<{ path: string; operation?: "CREATE" | "UPDATE" }>;
  };
  const changes: ManagedChange[] = (manifest.proposedChanges ?? []).map(
    (change) => ({
      path: change.path,
      ...(change.operation ? { operation: change.operation } : {}),
    }),
  );
  const vaultId = String(review.vault_id ?? "");
  if (!vaultId) throw new Error("REVIEW_VAULT_SCOPE_REQUIRED");
  const store = new GitKnowledgeStore(repositoryPath());
  await synchronizeManagedPaths(db, store, {
    spaceId: String(review.space_id),
    vaultId,
    revision,
    changes,
    ...(typeof manifest.sourceId === "string"
      ? { sourceId: manifest.sourceId }
      : {}),
  });
}

interface PublicationLifecycle {
  reviewId: string;
  jobId?: string;
  spaceId: string;
  vaultId: string;
  revision: string;
  manifest: Record<string, unknown>;
}

/**
 * Persist the publication state and its downstream work requests together.
 * The review status is the business commit point; the outbox rows share that
 * transaction so a retry cannot publish without a durable event (or emit an
 * event for a publication that rolled back).
 */
async function appendPublicationLifecycle(
  client: AppendTarget,
  input: PublicationLifecycle,
): Promise<void> {
  const proposed = Array.isArray(input.manifest.proposedChanges)
    ? input.manifest.proposedChanges
    : [];
  const changedPaths = proposed
    .map((entry) =>
      entry && typeof entry === "object" && "path" in entry
        ? String((entry as Record<string, unknown>).path ?? "")
        : "",
    )
    .filter(Boolean);
  const tombstones = proposed
    .filter(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        String(
          (entry as Record<string, unknown>).operation ?? "",
        ).toUpperCase() === "DELETE",
    )
    .map((entry) => String((entry as Record<string, unknown>).path ?? ""))
    .filter(Boolean);
  const payload = {
    reviewId: input.reviewId,
    ...(input.jobId ? { jobId: input.jobId } : {}),
    revision: input.revision,
    changedPaths,
    tombstones,
    ...(typeof input.manifest.sourceId === "string"
      ? { sourceId: input.manifest.sourceId }
      : {}),
  };
  const published = await appendReviewEvent(client, {
    eventType: "KnowledgePublished",
    resourceId: input.reviewId,
    spaceId: input.spaceId,
    vaultId: input.vaultId,
    correlationId: input.jobId ?? input.reviewId,
    payload,
  });
  const corpus = await appendReviewEvent(client, {
    eventType: "CorpusRevisionPublished",
    resourceId: input.reviewId,
    spaceId: input.spaceId,
    vaultId: input.vaultId,
    correlationId: input.jobId ?? input.reviewId,
    causationId: published.eventId,
    payload,
  });
  const requested: Array<{
    eventType:
      | "LexicalIndexUpdateRequested"
      | "VectorIndexUpdateRequested"
      | "GraphIndexUpdateRequested"
      | "ContextPackInvalidationRequested"
      | "ImpactedEvalRunRequested";
  }> = [
    { eventType: "LexicalIndexUpdateRequested" },
    { eventType: "VectorIndexUpdateRequested" },
    { eventType: "GraphIndexUpdateRequested" },
    { eventType: "ContextPackInvalidationRequested" },
    { eventType: "ImpactedEvalRunRequested" },
  ];
  for (const request of requested) {
    await appendReviewEvent(client, {
      eventType: request.eventType,
      resourceId: input.reviewId,
      spaceId: input.spaceId,
      vaultId: input.vaultId,
      correlationId: input.jobId ?? input.reviewId,
      causationId: corpus.eventId,
      payload,
    });
  }
}

async function finalizePublicationTransaction(
  client: PublicationClient,
  review: Record<string, unknown>,
  revision: string,
): Promise<boolean> {
  const approved = await client.query(
    `
    update reviews
       set status='APPROVED',decision_at=coalesce(decision_at,now()),
           merged_commit=$2,updated_at=now()
     where id=$1 and status='PUBLISHING'
     returning id
    `,
    [review.id, revision],
  );
  if (!approved.rowCount) return false;
  const manifest = (review.impact_manifest ?? {}) as Record<string, unknown>;
  const jobId = manifest.jobId;
  if (typeof jobId === "string") {
    await client.query(
      `
      update ingest_jobs set state='COMPLETED',updated_at=now(),
             result=coalesce(result,'{}'::jsonb)||$2::jsonb
       where id=$1 and space_id=$3 and vault_id=$4
      `,
      [
        jobId,
        JSON.stringify({ mergedCommit: revision }),
        review.space_id,
        review.vault_id,
      ],
    );
  }
  await appendPublicationLifecycle(client, {
    reviewId: String(review.id),
    ...(typeof jobId === "string" ? { jobId } : {}),
    spaceId: String(review.space_id),
    vaultId: String(review.vault_id ?? ""),
    revision,
    manifest,
  });
  return true;
}

export type PublicationReconciliationResult =
  | { status: "RECOVERED"; reviewId: string; revision: string }
  | { status: "ALREADY_COMMITTED"; reviewId: string; revision: string }
  | {
      status: "RECOVERY_REQUIRED";
      reviewId: string;
      currentRevision: string;
      reason: "MAIN_REVISION_MISMATCH" | "DRAFT_REVISION_UNAVAILABLE";
    }
  | { status: "NOT_RECOVERABLE"; reviewId: string; reviewStatus: string };

/**
 * Recover only a publication whose Git commit can be attributed exactly to
 * the durable PUBLISHING intent. Ambiguous main history is never reverted or
 * finalized automatically. The PUBLISHING -> APPROVED conditional update is
 * the idempotency fence: only its winner may append the publication outbox.
 */
export async function reconcilePublishingReview(
  db: Postgres,
  reviewId: string,
): Promise<PublicationReconciliationResult> {
  const initial = await db.pool.query("select * from reviews where id=$1", [
    reviewId,
  ]);
  const row = initial.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error("REVIEW_NOT_FOUND");
  if (String(row.status) === "APPROVED" && row.merged_commit) {
    return {
      status: "ALREADY_COMMITTED",
      reviewId,
      revision: String(row.merged_commit),
    };
  }
  if (String(row.status) !== "PUBLISHING") {
    return {
      status: "NOT_RECOVERABLE",
      reviewId,
      reviewStatus: String(row.status),
    };
  }

  const publicationKey = repositoryPublicationKey(repositoryPath());
  const lockOwner = `reconcile:${reviewId}:${randomUUID()}`;
  const lock = await db.pool.query(
    `
    insert into repository_publication_locks(repository_key,owner,expires_at)
    values($1,$2,now()+interval '10 minutes')
    on conflict(repository_key) do update set
      owner=excluded.owner,expires_at=excluded.expires_at,updated_at=now()
    where repository_publication_locks.expires_at < now()
    returning owner
    `,
    [publicationKey, lockOwner],
  );
  if (!lock.rowCount) throw new Error("PUBLICATION_LOCKED");
  const store = new GitKnowledgeStore(repositoryPath());
  try {
    const refreshed = await db.pool.query("select * from reviews where id=$1", [
      reviewId,
    ]);
    const review = refreshed.rows[0] as Record<string, unknown> | undefined;
    if (!review) throw new Error("REVIEW_NOT_FOUND");
    if (String(review.status) === "APPROVED" && review.merged_commit) {
      return {
        status: "ALREADY_COMMITTED",
        reviewId,
        revision: String(review.merged_commit),
      };
    }
    if (String(review.status) !== "PUBLISHING") {
      return {
        status: "NOT_RECOVERABLE",
        reviewId,
        reviewStatus: String(review.status),
      };
    }

    const current = await store.commitMetadata();
    const draft = await store
      .commitMetadata(String(review.head_commit))
      .catch(() => null);
    const expectedSubject = `review: publish ${String(review.branch_name)}`;
    const exact =
      draft !== null &&
      current.parents.length === 1 &&
      current.parents[0] === String(review.base_commit) &&
      current.tree === draft.tree &&
      current.subject === expectedSubject;
    if (!exact) {
      const reason = draft
        ? "MAIN_REVISION_MISMATCH"
        : "DRAFT_REVISION_UNAVAILABLE";
      await db.pool.query(
        `update reviews
            set status='PUBLICATION_RECOVERY_REQUIRED',
                decision_reason='Publication reconciliation requires manual review.',
                updated_at=now()
          where id=$1 and status='PUBLISHING'`,
        [reviewId],
      );
      await recordPublicationFailure(
        db,
        String(review.space_id),
        "Publication reconciliation could not attribute current main",
        {
          reviewId,
          expectedBase: review.base_commit,
          currentRevision: current.revision,
          reason,
        },
      );
      return {
        status: "RECOVERY_REQUIRED",
        reviewId,
        currentRevision: current.revision,
        reason,
      };
    }

    const client = await db.pool.connect();
    try {
      await client.query("begin");
      const finalized = await finalizePublicationTransaction(
        client,
        review,
        current.revision,
      );
      if (!finalized) {
        await client.query("rollback");
        const latest = await db.pool.query(
          "select status,merged_commit from reviews where id=$1",
          [reviewId],
        );
        if (
          latest.rows[0]?.status === "APPROVED" &&
          latest.rows[0]?.merged_commit
        ) {
          return {
            status: "ALREADY_COMMITTED",
            reviewId,
            revision: String(latest.rows[0].merged_commit),
          };
        }
        return {
          status: "NOT_RECOVERABLE",
          reviewId,
          reviewStatus: String(latest.rows[0]?.status ?? "UNKNOWN"),
        };
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    await store.cleanupDraft(String(review.branch_name)).catch(async (error) =>
      recordPublicationFailure(
        db,
        String(review.space_id),
        "Recovered publication draft cleanup failed",
        {
          reviewId,
          error: error instanceof Error ? error.message : String(error),
        },
      ),
    );
    return { status: "RECOVERED", reviewId, revision: current.revision };
  } finally {
    await db.pool.query(
      "delete from repository_publication_locks where repository_key=$1 and owner=$2",
      [publicationKey, lockOwner],
    );
  }
}

/**
 * Rollback is a publication of a new canonical corpus revision, not an
 * in-process projection mutation. The review state and root revision event
 * commit atomically, then the same causal projection fanout used by normal
 * publication is consumed by the durable worker.
 */
async function appendRollbackLifecycle(
  client: AppendTarget,
  input: PublicationLifecycle,
): Promise<void> {
  const proposed = Array.isArray(input.manifest.proposedChanges)
    ? input.manifest.proposedChanges
    : [];
  const changedPaths = proposed
    .map((entry) =>
      entry && typeof entry === "object" && "path" in entry
        ? String((entry as Record<string, unknown>).path ?? "")
        : "",
    )
    .filter(Boolean);
  // Reverting a CREATE removes the path from canonical Git. Reverting an
  // UPDATE (or a future DELETE) restores bytes from the prior revision, so it
  // remains a changed path but is not a tombstone.
  const tombstones = proposed
    .filter(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        String(
          (entry as Record<string, unknown>).operation ?? "",
        ).toUpperCase() === "CREATE",
    )
    .map((entry) => String((entry as Record<string, unknown>).path ?? ""))
    .filter(Boolean);
  const payload = {
    reviewId: input.reviewId,
    operation: "ROLLBACK",
    ...(input.jobId ? { jobId: input.jobId } : {}),
    revision: input.revision,
    changedPaths,
    tombstones,
    ...(typeof input.manifest.sourceId === "string"
      ? { sourceId: input.manifest.sourceId }
      : {}),
  };
  const corpus = await appendReviewEvent(client, {
    eventType: "CorpusRevisionPublished",
    resourceId: input.reviewId,
    spaceId: input.spaceId,
    vaultId: input.vaultId,
    correlationId: input.jobId ?? input.reviewId,
    payload,
  });
  const requested: Array<{
    eventType:
      | "LexicalIndexUpdateRequested"
      | "VectorIndexUpdateRequested"
      | "GraphIndexUpdateRequested"
      | "ContextPackInvalidationRequested"
      | "ImpactedEvalRunRequested";
  }> = [
    { eventType: "LexicalIndexUpdateRequested" },
    { eventType: "VectorIndexUpdateRequested" },
    { eventType: "GraphIndexUpdateRequested" },
    { eventType: "ContextPackInvalidationRequested" },
    { eventType: "ImpactedEvalRunRequested" },
  ];
  for (const request of requested) {
    await appendReviewEvent(client, {
      eventType: request.eventType,
      resourceId: input.reviewId,
      spaceId: input.spaceId,
      vaultId: input.vaultId,
      correlationId: input.jobId ?? input.reviewId,
      causationId: corpus.eventId,
      payload,
    });
  }
}

function reviewPaths(review: Record<string, unknown>): string[] {
  const manifest = review.impact_manifest as {
    proposedChanges?: Array<{ path?: string }>;
  };
  return (manifest.proposedChanges ?? [])
    .map((change) => change.path)
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
}

function hasValidReviewManifest(review: Record<string, unknown>): boolean {
  const paths = reviewPaths(review);
  return paths.length > 0 && new Set(paths).size === paths.length;
}

/** Include compiler retrieval context in the authorization boundary. A review
 * cannot expose candidate metadata gathered from a path the current actor
 * cannot read, even when the proposed file itself is inside their prefix. */
export function reviewAccessPaths(review: Record<string, unknown>): string[] {
  const manifest = (review.impact_manifest ?? {}) as Record<string, unknown>;
  const context =
    manifest.reviewContext && typeof manifest.reviewContext === "object"
      ? (manifest.reviewContext as Record<string, unknown>)
      : null;
  const candidates = Array.isArray(context?.existingCandidates)
    ? context.existingCandidates
    : [];
  const candidatePaths = candidates
    .map((candidate) =>
      candidate && typeof candidate === "object" && "path" in candidate
        ? String((candidate as Record<string, unknown>).path ?? "")
        : "",
    )
    .filter(Boolean);
  return [...new Set([...reviewPaths(review), ...candidatePaths])];
}

const REVIEW_VAULT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ReviewVaultAccess = {
  pathPrefix: string | null;
  permissions: string[];
};

async function reviewVaultAccess(
  db: Postgres,
  actor: ReturnType<typeof actorOf>,
  review: Record<string, unknown>,
  permission:
    "knowledge:read" | "knowledge:propose" | "knowledge:review" | "admin",
): Promise<ReviewVaultAccess | null> {
  if (!actor) return null;
  const spaceId = String(review.space_id);
  const vaultId = String(review.vault_id ?? "");
  if (
    !hasValidReviewManifest(review) ||
    !hasSpaceAccess(actor, spaceId, permission) ||
    !REVIEW_VAULT_ID.test(vaultId)
  ) {
    return null;
  }
  try {
    const scope = await resolveAuthorizedVaultScope(db, {
      userId: actor.id,
      spaceId,
      vaultId,
      permission,
      federated: false,
    });
    return scope.accessByVault[vaultId] ?? null;
  } catch {
    return null;
  }
}

async function canAccessReview(
  db: Postgres,
  actor: ReturnType<typeof actorOf>,
  review: Record<string, unknown>,
  permission:
    "knowledge:read" | "knowledge:propose" | "knowledge:review" | "admin",
): Promise<boolean> {
  const access = await reviewVaultAccess(db, actor, review, permission);
  if (!access) return false;
  const spaceId = String(review.space_id);
  return reviewAccessPaths(review).every(
    (reviewPath) =>
      hasPathAccess(actor, spaceId, permission, reviewPath) &&
      pathMatchesVaultPrefix(reviewPath, access.pathPrefix),
  );
}

function reviewPolicyDecisionHttpStatus(code: string): 403 | 409 | null {
  if (code === "REVIEW_ROLE_NOT_ALLOWED") return 403;
  if (
    [
      "REVIEW_PROFILE_STALE",
      "REVIEW_POLICY_SNAPSHOT_INVALID",
      "REVIEW_POLICY_KINDS_REQUIRED",
      "REVIEW_ROUND_INVALID",
      "REVIEW_HEAD_REQUIRED",
      "REVIEW_ALREADY_DECIDED",
      "REVIEW_APPROVAL_CONTEXT_CHANGED",
      "REVIEW_APPROVAL_QUORUM_NOT_MET",
    ].includes(code)
  ) {
    return 409;
  }
  return null;
}

export function registerReviewRoutes(app: FastifyInstance, db: Postgres): void {
  app.post<{ Body: { reviewId?: string } }>(
    "/v1/operator/publications/reconcile",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      const reviewId = request.body?.reviewId?.trim();
      if (!reviewId) {
        return reply.code(400).send({ code: "REVIEW_ID_REQUIRED" });
      }
      const actor = actorOf(request);
      const found = await db.pool.query(
        "select * from reviews where id=$1 and space_id=any($2::uuid[])",
        [reviewId, spaceIdsForPermission(actor, "admin")],
      );
      const review = found.rows[0] as Record<string, unknown> | undefined;
      if (!review) return reply.code(404).send({ code: "REVIEW_NOT_FOUND" });
      if (
        !hasUnrestrictedPathAccess(actor, String(review.space_id), "admin") ||
        !(await canAccessReview(db, actor, review, "admin"))
      ) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      try {
        const result = await reconcilePublishingReview(db, reviewId);
        await audit(
          db,
          request,
          "review.reconcile",
          "review",
          reviewId,
          { vaultId: String(review.vault_id), result: result.status },
          String(review.space_id),
        );
        return result;
      } catch (error) {
        if (String(error).includes("PUBLICATION_LOCKED")) {
          return reply.code(409).send({ code: "PUBLICATION_LOCKED" });
        }
        throw error;
      }
    },
  );

  app.post<{
    Body: {
      spaceId: string;
      vaultId: string;
      summary?: string;
      changes?: Array<{ path: string; content: string; reason?: string }>;
    };
  }>(
    "/v1/proposals",
    { preHandler: requirePermission("knowledge:propose") },
    async (request, reply) => {
      const changes = request.body?.changes ?? [];
      if (!changes.length)
        return reply.code(400).send({ code: "PROPOSAL_CHANGES_REQUIRED" });
      const duplicatePaths = changes
        .map((change) => change.path)
        .filter((path, index, paths) => paths.indexOf(path) !== index);
      if (duplicatePaths.length) {
        return reply.code(400).send({
          code: "DUPLICATE_PROPOSAL_PATH",
          paths: [...new Set(duplicatePaths)],
        });
      }
      for (const change of changes) {
        try {
          assertSafeKnowledgePath(change.path);
        } catch {
          return reply
            .code(400)
            .send({ code: "UNSAFE_KNOWLEDGE_PATH", path: change.path });
        }
        if (!change.path.endsWith(".md")) {
          return reply
            .code(400)
            .send({ code: "MARKDOWN_ONLY", path: change.path });
        }
      }
      const spaceId = request.body?.spaceId;
      const vaultId = request.body?.vaultId;
      if (!spaceId || !vaultId) {
        return reply.code(400).send({ code: "VAULT_SCOPE_REQUIRED" });
      }
      if (!hasSpaceAccess(actorOf(request), spaceId, "knowledge:propose")) {
        return reply.code(403).send({ code: "SPACE_ACCESS_DENIED" });
      }
      const actor = actorOf(request);
      let vaultAccess: ReviewVaultAccess | null = null;
      try {
        const scope = await resolveAuthorizedVaultScope(db, {
          userId: actor?.id ?? "",
          spaceId,
          vaultId,
          permission: "knowledge:propose",
          federated: false,
        });
        vaultAccess = scope.accessByVault[vaultId] ?? null;
      } catch (error) {
        const code =
          error instanceof Error ? error.message : "VAULT_ACCESS_DENIED";
        return reply
          .code(code === "VAULT_SCOPE_NOT_FOUND" ? 404 : 403)
          .send({ code });
      }
      if (!vaultAccess) {
        return reply.code(403).send({ code: "VAULT_ACCESS_DENIED" });
      }
      const deniedPath = changes.find(
        (change) =>
          !hasPathAccess(actor, spaceId, "knowledge:propose", change.path) ||
          !pathMatchesVaultPrefix(change.path, vaultAccess?.pathPrefix),
      );
      if (deniedPath) {
        return reply
          .code(403)
          .send({ code: "PATH_SCOPE_DENIED", path: deniedPath.path });
      }
      const issues = changes.flatMap((change) =>
        validateMarkdownDocument(change.content).map((issue) => ({
          ...issue,
          path: change.path,
        })),
      );
      const errors = issues.filter((issue) => issue.severity === "ERROR");
      if (errors.length) {
        return reply
          .code(422)
          .send({ code: "DRAFT_VALIDATION_FAILED", issues });
      }
      const reviewKinds = changes.map(
        (change) => parseKnowledgeDocumentMetadata(change.content)?.type,
      );
      if (reviewKinds.some((kind) => !kind)) {
        return reply.code(422).send({ code: "KNOWLEDGE_KIND_REQUIRED" });
      }
      let resolvedReviewPolicy: Awaited<
        ReturnType<typeof resolveProposalReviewPolicy>
      >;
      try {
        resolvedReviewPolicy = await resolveProposalReviewPolicy(
          db,
          spaceId,
          vaultId,
          reviewKinds as string[],
        );
      } catch (error) {
        const code = error instanceof Error ? error.message : String(error);
        if (code.startsWith("COMPILER_PROFILE_KIND_NOT_DECLARED:")) {
          return reply.code(422).send({
            code: "KNOWLEDGE_PROFILE_KIND_NOT_ALLOWED",
            kind: code.split(":")[1] ?? "",
          });
        }
        if (code === "COMPILER_REVIEW_POLICY_ROLE_CONFLICT") {
          return reply
            .code(422)
            .send({ code: "KNOWLEDGE_PROFILE_REVIEW_POLICY_CONFLICT" });
        }
        if (code === "ACTIVE_KNOWLEDGE_PROFILE_BINDING_INVALID") {
          return reply.code(409).send({ code });
        }
        throw error;
      }
      const created = await createReviewDraft(db, {
        repositoryPath: repositoryPath(),
        spaceId,
        vaultId,
        authorId: actorOf(request)?.id ?? null,
        summary: request.body.summary ?? "knowledge: direct proposal",
        changes,
        defaultReason: "Direct proposal",
        impactManifest: {
          summary: request.body.summary ?? "",
          reviewKinds: [...new Set(reviewKinds as string[])],
          reviewPolicy: resolvedReviewPolicy.policy,
          reviewPolicyPinned: resolvedReviewPolicy.pinned,
        },
        validationReport: { issues, errors: 0 },
      });
      await audit(
        db,
        request,
        "knowledge.propose",
        "review",
        created.reviewId,
        { vaultId },
        spaceId,
      );
      return reply.code(201).send({
        reviewId: created.reviewId,
        status: "PENDING",
        branchName: created.branchName,
        headCommit: created.headCommit,
      });
    },
  );

  app.get(
    "/v1/reviews",
    { preHandler: requirePermission("knowledge:read") },
    async (request) => {
      const actor = actorOf(request);
      const status = String(
        (request.query as Record<string, unknown>).status ?? "",
      );
      const result = await db.pool.query(
        `
        select r.*, u.display_name author_name
         from reviews r left join users u on u.id=r.author_id
         where ($1='' or r.status=$1) and r.space_id=any($2::uuid[])
         order by r.created_at desc limit 100
        `,
        [status, spaceIdsForPermission(actor, "knowledge:read")],
      );
      const visibleReviews = await Promise.all(
        result.rows.map(async (review) =>
          (await canAccessReview(db, actor, review, "knowledge:read"))
            ? review
            : null,
        ),
      );
      return {
        reviews: visibleReviews.filter(
          (review): review is (typeof result.rows)[number] => review !== null,
        ),
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/reviews/:id/submit",
    { preHandler: requirePermission("knowledge:propose") },
    async (request, reply) => {
      const actor = actorOf(request);
      const review = await db.pool.query(
        `
        select * from reviews
         where id=$1 and author_id=$2 and space_id=any($3::uuid[])
           and status in ('PENDING','CHANGES_REQUESTED')
        `,
        [
          request.params.id,
          actor?.id ?? null,
          spaceIdsForPermission(actor, "knowledge:propose"),
        ],
      );
      if (!review.rowCount) {
        return reply.code(409).send({ code: "REVIEW_NOT_SUBMITTABLE" });
      }
      if (
        !(await canAccessReview(db, actor, review.rows[0], "knowledge:propose"))
      ) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const result = await db.pool.query(
        `
        update reviews set status='PENDING',updated_at=now()
         where id=$1 and author_id=$2 and space_id=any($3::uuid[])
           and status in ('PENDING','CHANGES_REQUESTED')
         returning id,status,space_id,vault_id
        `,
        [
          request.params.id,
          actor?.id ?? null,
          spaceIdsForPermission(actor, "knowledge:propose"),
        ],
      );
      if (!result.rowCount) {
        return reply.code(409).send({ code: "REVIEW_NOT_SUBMITTABLE" });
      }
      await audit(
        db,
        request,
        "review.submit",
        "review",
        request.params.id,
        { vaultId: String(result.rows[0]?.vault_id) },
        String(result.rows[0]?.space_id),
      );
      return result.rows[0];
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      summary?: string;
      changes?: Array<{ path: string; content: string; reason?: string }>;
    };
  }>(
    "/v1/reviews/:id/revise",
    { preHandler: requirePermission("knowledge:propose") },
    async (request, reply) => {
      const actor = actorOf(request);
      const changes = request.body?.changes ?? [];
      if (!changes.length) {
        return reply.code(400).send({ code: "REVISION_CHANGES_REQUIRED" });
      }
      const duplicatePaths = changes
        .map((change) => change.path)
        .filter(
          (candidate, index, paths) => paths.indexOf(candidate) !== index,
        );
      if (duplicatePaths.length) {
        return reply.code(400).send({
          code: "DUPLICATE_PROPOSAL_PATH",
          paths: [...new Set(duplicatePaths)],
        });
      }
      for (const change of changes) {
        try {
          assertSafeKnowledgePath(change.path);
        } catch {
          return reply
            .code(400)
            .send({ code: "UNSAFE_KNOWLEDGE_PATH", path: change.path });
        }
        if (!change.path.endsWith(".md")) {
          return reply
            .code(400)
            .send({ code: "MARKDOWN_ONLY", path: change.path });
        }
      }
      const found = await db.pool.query(
        `select * from reviews
          where id=$1 and author_id=$2 and space_id=any($3::uuid[])
            and status='CHANGES_REQUESTED'`,
        [
          request.params.id,
          actor?.id ?? null,
          spaceIdsForPermission(actor, "knowledge:propose"),
        ],
      );
      if (!found.rowCount) {
        return reply.code(409).send({ code: "REVIEW_NOT_REVISABLE" });
      }
      const review = found.rows[0] as Record<string, unknown>;
      const reviewAccess = await reviewVaultAccess(
        db,
        actor,
        review,
        "knowledge:propose",
      );
      if (
        !reviewAccess ||
        !(await canAccessReview(db, actor, review, "knowledge:propose"))
      ) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const previousPaths = [...new Set(reviewPaths(review))].sort();
      const revisedPaths = [
        ...new Set(changes.map((change) => change.path)),
      ].sort();
      if (
        previousPaths.length !== revisedPaths.length ||
        previousPaths.some((path, index) => path !== revisedPaths[index])
      ) {
        return reply.code(400).send({
          code: "REVISION_PATH_SET_CHANGED",
          expectedPaths: previousPaths,
          receivedPaths: revisedPaths,
        });
      }
      const deniedPath = changes.find(
        (change) =>
          !hasPathAccess(
            actor,
            String(review.space_id),
            "knowledge:propose",
            change.path,
          ) || !pathMatchesVaultPrefix(change.path, reviewAccess.pathPrefix),
      );
      if (deniedPath) {
        return reply
          .code(403)
          .send({ code: "PATH_SCOPE_DENIED", path: deniedPath.path });
      }
      const issues = changes.flatMap((change) =>
        validateMarkdownDocument(change.content).map((issue) => ({
          ...issue,
          path: change.path,
        })),
      );
      if (issues.some((issue) => issue.severity === "ERROR")) {
        return reply
          .code(422)
          .send({ code: "DRAFT_VALIDATION_FAILED", issues });
      }
      const revisedReviewKinds = changes.map(
        (change) => parseKnowledgeDocumentMetadata(change.content)?.type,
      );
      if (revisedReviewKinds.some((kind) => !kind)) {
        return reply.code(422).send({ code: "KNOWLEDGE_KIND_REQUIRED" });
      }
      let revisedReviewPolicy: Awaited<
        ReturnType<typeof resolveProposalReviewPolicy>
      >;
      try {
        revisedReviewPolicy = await resolveProposalReviewPolicy(
          db,
          String(review.space_id),
          String(review.vault_id),
          revisedReviewKinds as string[],
        );
      } catch (error) {
        const code = error instanceof Error ? error.message : String(error);
        if (
          code === "COMPILER_PROFILE_KIND_NOT_DECLARED:source-summary" &&
          (await isLegacyWorkerSourceSummaryReview(
            db,
            review,
            revisedReviewKinds as string[],
          ))
        ) {
          const legacyState = reviewPolicyState(review);
          revisedReviewPolicy = {
            policy: legacyState.policy,
            pinned: false,
          };
        } else if (code.startsWith("COMPILER_PROFILE_KIND_NOT_DECLARED:")) {
          return reply.code(422).send({
            code: "KNOWLEDGE_PROFILE_KIND_NOT_ALLOWED",
            kind: code.split(":")[1] ?? "",
          });
        } else if (code === "COMPILER_REVIEW_POLICY_ROLE_CONFLICT") {
          return reply
            .code(422)
            .send({ code: "KNOWLEDGE_PROFILE_REVIEW_POLICY_CONFLICT" });
        } else if (code === "ACTIVE_KNOWLEDGE_PROFILE_BINDING_INVALID") {
          return reply.code(409).send({ code });
        } else {
          throw error;
        }
      }

      const previousManifest = (review.impact_manifest ?? {}) as Record<
        string,
        unknown
      >;
      const previousDraftRevision = Number(previousManifest.draftRevision ?? 1);
      const draftRevision = Number.isSafeInteger(previousDraftRevision)
        ? previousDraftRevision + 1
        : 2;
      const store = new GitKnowledgeStore(repositoryPath());
      const baseRevision = String(review.base_commit);
      const branchName = await store.createDraftBranch(
        `${request.params.id}-r${draftRevision}`,
        baseRevision,
      );
      const proposedChanges = await Promise.all(
        changes.map(async (change) => ({
          path: change.path,
          operation: (await store.hasFileAtRevision(baseRevision, change.path))
            ? ("UPDATE" as const)
            : ("CREATE" as const),
          reasons: [change.reason ?? "Requested review correction"],
        })),
      );
      try {
        for (const change of changes) {
          await store.writeDraftFile(change.path, change.content);
        }
        const headCommit = await store.commitAll(
          request.body.summary ??
            `review: revise ${request.params.id} (${draftRevision})`,
          process.env.AKP_GIT_AUTHOR_NAME ?? "Architecture Knowledge Platform",
          process.env.AKP_GIT_AUTHOR_EMAIL ?? "akp@localhost",
        );
        const updated = await db.pool.query(
          `update reviews
              set branch_name=$2,head_commit=$3,
                  impact_manifest=$4::jsonb,validation_report=$5::jsonb,
                  decision_by=null,decision_at=null,decision_reason=null,
                  updated_at=now()
            where id=$1 and author_id=$6 and status='CHANGES_REQUESTED'
              and head_commit=$7 and branch_name=$8
            returning id,status,branch_name,head_commit`,
          [
            request.params.id,
            branchName,
            headCommit,
            JSON.stringify({
              ...previousManifest,
              summary: request.body.summary ?? previousManifest.summary ?? "",
              draftRevision,
              proposedChanges,
              reviewKinds: [...new Set(revisedReviewKinds as string[])],
              reviewPolicy: revisedReviewPolicy.policy,
              reviewPolicyPinned: revisedReviewPolicy.pinned,
            }),
            JSON.stringify({ issues, errors: 0 }),
            actor?.id ?? null,
            review.head_commit,
            review.branch_name,
          ],
        );
        if (!updated.rowCount) {
          await store.cleanupDraft(branchName).catch(() => undefined);
          return reply.code(409).send({ code: "REVIEW_REVISION_CONFLICT" });
        }
        await audit(
          db,
          request,
          "review.revise",
          "review",
          request.params.id,
          { vaultId: String(review.vault_id), draftRevision },
          String(review.space_id),
        );
        await new GitKnowledgeStore(repositoryPath())
          .cleanupDraft(String(review.branch_name))
          .catch(async (cleanupError) =>
            recordPublicationFailure(
              db,
              String(review.space_id),
              "Superseded review draft cleanup failed",
              {
                reviewId: request.params.id,
                branchName: review.branch_name,
                error:
                  cleanupError instanceof Error
                    ? cleanupError.message
                    : String(cleanupError),
              },
            ),
          );
        return { ...updated.rows[0], draftRevision };
      } catch (error) {
        await store.cleanupDraft(branchName).catch(() => undefined);
        throw error;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/reviews/:id",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const result = await db.pool.query(
        "select * from reviews where id=$1 and space_id=any($2::uuid[])",
        [
          request.params.id,
          spaceIdsForPermission(actorOf(request), "knowledge:read"),
        ],
      );
      if (!result.rowCount)
        return reply.code(404).send({ code: "REVIEW_NOT_FOUND" });
      const review = result.rows[0];
      if (
        !review ||
        !(await canAccessReview(db, actorOf(request), review, "knowledge:read"))
      ) {
        return reply.code(404).send({ code: "REVIEW_NOT_FOUND" });
      }
      const comments = await db.pool.query(
        "select * from review_comments where review_id=$1 order by created_at",
        [request.params.id],
      );
      const approvalStatus = await reviewApprovalStatus(db, review);
      const store = new GitKnowledgeStore(repositoryPath());
      const diff = await store
        .diff(String(review.base_commit), String(review.head_commit))
        .catch(() => "");
      return {
        ...review,
        comments: comments.rows,
        diff,
        reviewPolicy: approvalStatus.policy,
        approvalProgress: {
          reviewRound: approvalStatus.reviewRound,
          count: approvalStatus.approvalCount,
          minimumApprovals: approvalStatus.minimumApprovals,
          remainingApprovals: approvalStatus.remainingApprovals,
          pinned: approvalStatus.pinned,
        },
        approvals: approvalStatus.approvals,
      };
    },
  );

  app.post<{
    Params: { id: string };
    Body: { decision: string; reason?: string };
  }>(
    "/v1/reviews/:id/decision",
    { preHandler: requirePermission("knowledge:review") },
    async (request, reply) => {
      const decision = String(request.body?.decision ?? "").toUpperCase();
      if (!["APPROVE", "REJECT", "REQUEST_CHANGES"].includes(decision)) {
        return reply.code(400).send({ code: "INVALID_REVIEW_DECISION" });
      }
      if (!request.body?.reason?.trim()) {
        return reply.code(400).send({ code: "REVIEW_REASON_REQUIRED" });
      }
      const found = await db.pool.query(
        "select * from reviews where id=$1 and space_id=any($2::uuid[])",
        [
          request.params.id,
          spaceIdsForPermission(actorOf(request), "knowledge:review"),
        ],
      );
      if (!found.rowCount)
        return reply.code(404).send({ code: "REVIEW_NOT_FOUND" });
      const review = found.rows[0];
      if (
        !review ||
        !(await canAccessReview(
          db,
          actorOf(request),
          review,
          "knowledge:review",
        ))
      ) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      if (!["PENDING", "CHANGES_REQUESTED"].includes(String(review.status))) {
        return reply
          .code(409)
          .send({ code: "REVIEW_ALREADY_DECIDED", status: review.status });
      }
      const actor = actorOf(request);
      if (decision === "APPROVE") {
        if (
          !hasUnrestrictedPathAccess(
            actor,
            String(review.space_id),
            "knowledge:review",
          )
        ) {
          return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
        }
        if (!actor)
          return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
        let approval: Awaited<ReturnType<typeof recordReviewApproval>>;
        try {
          approval = await recordReviewApproval(db, {
            reviewId: request.params.id,
            actor,
            reason: request.body.reason ?? "",
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : String(error);
          const status = reviewPolicyDecisionHttpStatus(code);
          if (status) return reply.code(status).send({ code });
          throw error;
        }
        await audit(
          db,
          request,
          "review.approval_recorded",
          "review",
          request.params.id,
          {
            vaultId: String(review.vault_id),
            reviewerRole: approval.reviewerRole,
            approvalCount: approval.approvalCount,
            minimumApprovals: approval.minimumApprovals,
            duplicate: approval.duplicate,
            reviewRound: approval.reviewRound,
          },
          String(review.space_id),
        );
        if (!approval.quorumReached) {
          return {
            id: request.params.id,
            status: "PENDING",
            approvalProgress: {
              reviewRound: approval.reviewRound,
              count: approval.approvalCount,
              minimumApprovals: approval.minimumApprovals,
              remainingApprovals:
                approval.minimumApprovals - approval.approvalCount,
              duplicate: approval.duplicate,
            },
          };
        }
        const store = new GitKnowledgeStore(repositoryPath());
        const publicationKey = repositoryPublicationKey(repositoryPath());
        const lockOwner = `approve:${request.params.id}:${request.id}`;
        const lock = await db.pool.query(
          `
          insert into repository_publication_locks(repository_key,owner,expires_at)
          values($1,$2,now()+interval '10 minutes')
          on conflict(repository_key) do update set
            owner=excluded.owner,expires_at=excluded.expires_at,updated_at=now()
          where repository_publication_locks.expires_at < now()
          returning owner
          `,
          [publicationKey, lockOwner],
        );
        if (!lock.rowCount) {
          return reply.code(409).send({ code: "PUBLICATION_LOCKED" });
        }
        let revision: string | null = null;
        try {
          let claimedReview: Record<string, unknown>;
          try {
            claimedReview = await claimReviewForPublication(db, {
              reviewId: request.params.id,
              expectedHeadCommit: approval.headCommit,
              expectedPolicyFingerprint: approval.policyFingerprint,
              expectedReviewRound: approval.reviewRound,
              actorId: actor.id,
              reason: request.body.reason ?? "",
            });
          } catch (error) {
            const code = error instanceof Error ? error.message : String(error);
            const status = reviewPolicyDecisionHttpStatus(code);
            if (status) return reply.code(status).send({ code });
            throw error;
          }
          await renewPublicationLock(db, publicationKey, lockOwner);
          revision = await withSpan(
            "review.publish",
            { "akp.review.operation": "approve" },
            () =>
              store.mergeDraft(
                String(review.branch_name),
                String(review.base_commit),
                String(review.head_commit),
                process.env.AKP_GIT_AUTHOR_NAME ??
                  "Architecture Knowledge Platform",
                process.env.AKP_GIT_AUTHOR_EMAIL ?? "akp@localhost",
              ),
          );
          await renewPublicationLock(db, publicationKey, lockOwner);
          const publicationClient = await db.pool.connect();
          try {
            await publicationClient.query("begin");
            const finalized = await finalizePublicationTransaction(
              publicationClient,
              claimedReview,
              revision,
            );
            if (!finalized) throw new Error("PUBLICATION_STATE_LOST");
            await publicationClient.query("commit");
          } catch (error) {
            await publicationClient.query("rollback");
            throw error;
          } finally {
            publicationClient.release();
          }
          await audit(
            db,
            request,
            "review.approve",
            "review",
            request.params.id,
            { vaultId: String(review.vault_id), revision },
            String(review.space_id),
          );
          await store
            .cleanupDraft(String(review.branch_name))
            .catch(async (cleanupError) =>
              recordPublicationFailure(
                db,
                String(review.space_id),
                "Published review draft cleanup failed",
                {
                  reviewId: request.params.id,
                  error:
                    cleanupError instanceof Error
                      ? cleanupError.message
                      : String(cleanupError),
                },
              ),
            );
          return {
            id: request.params.id,
            status: "APPROVED",
            mergedCommit: revision,
            approvalProgress: {
              reviewRound: approval.reviewRound,
              count: approval.approvalCount,
              minimumApprovals: approval.minimumApprovals,
              remainingApprovals: 0,
            },
            indexing: "PENDING",
            queuedEvents: [
              "KnowledgePublished",
              "CorpusRevisionPublished",
              "LexicalIndexUpdateRequested",
              "VectorIndexUpdateRequested",
              "GraphIndexUpdateRequested",
              "ContextPackInvalidationRequested",
              "ImpactedEvalRunRequested",
            ],
          };
        } catch (error) {
          let compensatingRevision: string | null = null;
          let observedMainRevision: string | null = null;
          let compensationSucceeded = false;
          if (revision) {
            try {
              compensatingRevision = await store.rollbackMain(revision);
              compensationSucceeded = true;
            } catch (compensationError) {
              await recordPublicationFailure(
                db,
                String(review.space_id),
                "Publication compensation failed",
                {
                  reviewId: request.params.id,
                  mergedRevision: revision,
                  error:
                    compensationError instanceof Error
                      ? compensationError.message
                      : String(compensationError),
                },
              );
            }
          } else {
            try {
              observedMainRevision = await store.revision();
              compensationSucceeded =
                observedMainRevision === String(review.base_commit);
            } catch {
              compensationSucceeded = false;
            }
          }
          if (compensationSucceeded) {
            await db.pool.query(
              `
              update reviews
                 set status='CHANGES_REQUESTED',merged_commit=null,
                     base_commit=coalesce($2,base_commit),
                     decision_by=null,decision_at=null,
                     decision_reason=$3,updated_at=now()
               where id=$1 and status='PUBLISHING'
              `,
              [
                request.params.id,
                compensatingRevision,
                "Publication failed safely; retry from the compensated Git revision.",
              ],
            );
          } else {
            await db.pool.query(
              `
              update reviews
                 set status='PUBLICATION_RECOVERY_REQUIRED',
                     decision_reason=$2,updated_at=now()
               where id=$1 and status='PUBLISHING'
              `,
              [
                request.params.id,
                "Publication state is ambiguous; manual reconciliation is required.",
              ],
            );
          }
          await recordPublicationFailure(
            db,
            String(review.space_id),
            error instanceof Error ? error.message : String(error),
            {
              reviewId: request.params.id,
              mergedRevision: revision,
              compensatingRevision,
              observedMainRevision,
              compensationSucceeded,
            },
          );
          const conflict =
            /OPTIMISTIC_BASE_CONFLICT|DRAFT_HEAD_CONFLICT|PUBLICATION_LOCK_LOST/.test(
              String(error),
            );
          return reply.code(conflict ? 409 : 500).send({
            code: conflict ? "PUBLICATION_CONFLICT" : "PUBLICATION_FAILED",
          });
        } finally {
          await db.pool.query(
            "delete from repository_publication_locks where repository_key=$1 and owner=$2",
            [publicationKey, lockOwner],
          );
        }
      }
      const reviewStatus =
        decision === "REJECT" ? "REJECTED" : "CHANGES_REQUESTED";
      const transitioned = await db.pool.query(
        `
        update reviews set status=$2,decision_by=$3,decision_at=now(),
               decision_reason=$4,
               review_round=case when $2='CHANGES_REQUESTED' then review_round+1 else review_round end,
               updated_at=now()
         where id=$1 and space_id=$5 and status in ('PENDING','CHANGES_REQUESTED')
         returning id,status
        `,
        [
          request.params.id,
          reviewStatus,
          actor?.id ?? null,
          request.body.reason ?? null,
          review.space_id,
        ],
      );
      if (!transitioned.rowCount) {
        return reply.code(409).send({ code: "REVIEW_ALREADY_DECIDED" });
      }
      const relatedJobId = (review.impact_manifest as Record<string, unknown>)
        ?.jobId;
      if (typeof relatedJobId === "string") {
        await db.pool.query(
          `
          update ingest_jobs
             set state=$2,updated_at=now(),
                 result=coalesce(result,'{}'::jsonb)||$3::jsonb
           where id=$1 and space_id=$4 and vault_id=$5
          `,
          [
            relatedJobId,
            decision === "REJECT" ? "CANCELLED" : "DRAFTED",
            JSON.stringify({
              reviewDecision: decision,
              reason: request.body.reason ?? null,
            }),
            review.space_id,
            review.vault_id,
          ],
        );
      }
      await audit(
        db,
        request,
        `review.${decision.toLowerCase()}`,
        "review",
        request.params.id,
        { vaultId: String(review.vault_id) },
        String(review.space_id),
      );
      if (decision === "REJECT") {
        await new GitKnowledgeStore(repositoryPath())
          .cleanupDraft(String(review.branch_name))
          .catch(async (cleanupError) => {
            await recordPublicationFailure(
              db,
              String(review.space_id),
              "Rejected review draft cleanup failed",
              {
                reviewId: request.params.id,
                error:
                  cleanupError instanceof Error
                    ? cleanupError.message
                    : String(cleanupError),
              },
            );
          });
      }
      return { id: request.params.id, status: reviewStatus };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    "/v1/reviews/:id/rollback",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      if (!request.body?.reason?.trim()) {
        return reply.code(400).send({ code: "ROLLBACK_REASON_REQUIRED" });
      }
      const found = await db.pool.query(
        `
        select * from reviews
         where id=$1 and space_id=any($2::uuid[]) and status='APPROVED'
        `,
        [request.params.id, spaceIdsForPermission(actorOf(request), "admin")],
      );
      if (!found.rowCount || !found.rows[0]?.merged_commit) {
        return reply.code(409).send({ code: "REVIEW_NOT_ROLLBACKABLE" });
      }
      const review = found.rows[0];
      if (
        !review ||
        !(await canAccessReview(db, actorOf(request), review, "admin")) ||
        !hasUnrestrictedPathAccess(
          actorOf(request),
          String(review.space_id),
          "admin",
        )
      ) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const store = new GitKnowledgeStore(repositoryPath());
      const publicationKey = repositoryPublicationKey(repositoryPath());
      const lockOwner = `rollback:${request.params.id}:${request.id}`;
      const lock = await db.pool.query(
        `
        insert into repository_publication_locks(repository_key,owner,expires_at)
        values($1,$2,now()+interval '10 minutes')
        on conflict(repository_key) do update set
          owner=excluded.owner,expires_at=excluded.expires_at,updated_at=now()
        where repository_publication_locks.expires_at < now()
        returning owner
        `,
        [publicationKey, lockOwner],
      );
      if (!lock.rowCount) {
        return reply.code(409).send({ code: "PUBLICATION_LOCKED" });
      }
      let revision: string | null = null;
      try {
        const claimed = await db.pool.query(
          `
          update reviews set status='ROLLING_BACK',updated_at=now()
           where id=$1 and space_id=$2 and status='APPROVED'
           returning id
          `,
          [request.params.id, review.space_id],
        );
        if (!claimed.rowCount) {
          return reply.code(409).send({ code: "REVIEW_NOT_ROLLBACKABLE" });
        }
        await renewPublicationLock(db, publicationKey, lockOwner);
        revision = await withSpan(
          "review.rollback",
          { "akp.review.operation": "rollback" },
          () => store.rollbackMain(String(review.merged_commit)),
        );
        await renewPublicationLock(db, publicationKey, lockOwner);
        const manifest = (review.impact_manifest ?? {}) as Record<
          string,
          unknown
        >;
        const jobId = manifest.jobId;
        await renewPublicationLock(db, publicationKey, lockOwner);
        const rollbackClient = await db.pool.connect();
        try {
          await rollbackClient.query("begin");
          const completed = await rollbackClient.query(
            `
            update reviews set status='ROLLED_BACK',decision_reason=$2,updated_at=now()
             where id=$1 and status='ROLLING_BACK'
             returning id
            `,
            [request.params.id, request.body.reason.trim()],
          );
          if (!completed.rowCount) {
            throw new Error("ROLLBACK_STATE_CONFLICT");
          }
          await appendRollbackLifecycle(rollbackClient, {
            reviewId: request.params.id,
            ...(typeof jobId === "string" ? { jobId } : {}),
            spaceId: String(review.space_id),
            vaultId: String(review.vault_id ?? ""),
            revision,
            manifest,
          });
          await rollbackClient.query("commit");
        } catch (error) {
          await rollbackClient.query("rollback");
          throw error;
        } finally {
          rollbackClient.release();
        }
        await audit(
          db,
          request,
          "review.rollback",
          "review",
          request.params.id,
          {
            vaultId: String(review.vault_id),
            revision,
            indexing: "PENDING",
          },
          String(review.space_id),
        );
        return {
          id: request.params.id,
          status: "ROLLED_BACK",
          revision,
          indexing: "PENDING",
          queuedEvents: [
            "CorpusRevisionPublished",
            "LexicalIndexUpdateRequested",
            "VectorIndexUpdateRequested",
            "GraphIndexUpdateRequested",
            "ContextPackInvalidationRequested",
            "ImpactedEvalRunRequested",
          ],
        };
      } catch (error) {
        let recoveryRevision: string | null = null;
        let recoverySucceeded = revision === null;
        if (revision) {
          try {
            recoveryRevision = await store.rollbackMain(revision);
            await indexMergedChanges(db, review, recoveryRevision);
            recoverySucceeded = true;
          } catch (recoveryError) {
            await recordPublicationFailure(
              db,
              String(review.space_id),
              "Rollback compensation failed",
              {
                reviewId: request.params.id,
                rollbackRevision: revision,
                error:
                  recoveryError instanceof Error
                    ? recoveryError.message
                    : String(recoveryError),
              },
            );
          }
        }
        await db.pool.query(
          `
          update reviews
             set status=$2,decision_reason=$3,updated_at=now()
           where id=$1 and status='ROLLING_BACK'
          `,
          [
            request.params.id,
            recoverySucceeded ? "APPROVED" : "ROLLBACK_RECOVERY_REQUIRED",
            recoverySucceeded
              ? "Rollback failed and canonical Git was restored; inspect the Error Book."
              : "Rollback recovery requires operator intervention; inspect the Error Book.",
          ],
        );
        await recordPublicationFailure(
          db,
          String(review.space_id),
          error instanceof Error ? error.message : String(error),
          {
            reviewId: request.params.id,
            rollbackRevision: revision,
            recoveryRevision,
            recoverySucceeded,
          },
        );
        return reply.code(500).send({ code: "ROLLBACK_FAILED" });
      } finally {
        await db.pool.query(
          "delete from repository_publication_locks where repository_key=$1 and owner=$2",
          [publicationKey, lockOwner],
        );
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: { body: string; path?: string; line?: number };
  }>(
    "/v1/reviews/:id/comments",
    { preHandler: requirePermission("knowledge:review") },
    async (request, reply) => {
      if (!request.body?.body?.trim())
        return reply.code(400).send({ code: "COMMENT_REQUIRED" });
      const review = await db.pool.query(
        "select * from reviews where id=$1 and space_id=any($2::uuid[])",
        [
          request.params.id,
          spaceIdsForPermission(actorOf(request), "knowledge:review"),
        ],
      );
      if (!review.rowCount) {
        return reply.code(404).send({ code: "REVIEW_NOT_FOUND" });
      }
      if (
        !review.rows[0] ||
        !(await canAccessReview(
          db,
          actorOf(request),
          review.rows[0],
          "knowledge:review",
        ))
      ) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const commentPath = request.body.path?.trim();
      if (
        commentPath &&
        (!reviewPaths(review.rows[0]).includes(commentPath) ||
          !hasPathAccess(
            actorOf(request),
            String(review.rows[0].space_id),
            "knowledge:review",
            commentPath,
          ))
      ) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const result = await db.pool.query(
        `
        insert into review_comments(review_id,author_id,path,line,body)
        select $1,$2,$3,$4,$5 from reviews r
         where r.id=$1 and r.space_id=any($6::uuid[])
        returning *
        `,
        [
          request.params.id,
          actorOf(request)?.id ?? null,
          request.body.path ?? null,
          request.body.line ?? null,
          request.body.body.trim(),
          spaceIdsForPermission(actorOf(request), "knowledge:review"),
        ],
      );
      if (!result.rowCount)
        return reply.code(404).send({ code: "REVIEW_NOT_FOUND" });
      await audit(
        db,
        request,
        "review.comment.create",
        "review_comment",
        String(result.rows[0]?.id ?? ""),
        {
          vaultId: String(review.rows[0]?.vault_id),
          path: request.body.path ?? null,
          line: request.body.line ?? null,
        },
        String(review.rows[0]?.space_id),
      );
      return reply.code(201).send(result.rows[0]);
    },
  );
}
