import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import matter from "gray-matter";
import { runKnowledgeLint, type Postgres } from "@akp/postgres";
import { GitKnowledgeStore } from "@akp/git-store";
import { assertSafeKnowledgePath } from "@akp/compiler";
import { validateMarkdownDocument } from "@akp/validation";
import {
  DeterministicEmbeddingAdapter,
  parseKnowledgeUnits,
  toPgVector,
} from "@akp/retrieval";
import {
  rebuildSpaceProjections,
  assertManagedRepositoryBoundary,
  repositoryPublicationKey,
  synchronizeManagedPaths,
  type ManagedChange,
} from "../projections.js";
import { runEvaluation } from "./evaluation.js";
import {
  actorOf,
  audit,
  hasPathAccess,
  hasSpaceAccess,
  hasUnrestrictedPathAccess,
  requirePermission,
  spaceIdsForPermission,
} from "../auth.js";

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

async function indexMergedChangesLegacy(
  db: Postgres,
  review: Record<string, unknown>,
  revision: string,
): Promise<void> {
  const vault = await db.pool.query<{ current_revision: string }>(
    `
    select current_revision from vaults where space_id=$1
     order by last_imported_at desc nulls last limit 1
    `,
    [review.space_id],
  );
  const vaultRevision = vault.rows[0]?.current_revision ?? "no-vault";
  const projectionRevision = `composite:${vaultRevision}+managed:${revision}`;
  const manifest = review.impact_manifest as {
    proposedChanges?: Array<{ path: string; operation?: string }>;
  };
  for (const change of manifest.proposedChanges ?? []) {
    const absolutePath = path.join(
      repositoryPath(),
      ...change.path.replaceAll("\\", "/").split("/"),
    );
    const raw = await readFile(absolutePath, "utf8");
    const parsed = matter(raw);
    const data = parsed.data as Record<string, unknown>;
    const externalId = String(
      data.id ??
        `GEN-${createHash("sha256").update(change.path).digest("hex").slice(0, 12)}`,
    );
    const indexed = await db.pool.query<{ id: string }>(
      `
      insert into knowledge_documents(
        space_id,path,external_id,title,type,lifecycle,trust_tier,current_revision,
        body_cache,frontmatter,aliases,layer,content_hash,token_estimate,raw_links
      )
      values ($1,$2,$3,$4,$5,'ACTIVE','HUMAN_REVIEWED',$6,$7,$8::jsonb,$9,$10,$11,$12,'[]'::jsonb)
      on conflict(space_id,path) do update set
        external_id=excluded.external_id,title=excluded.title,type=excluded.type,
        lifecycle=excluded.lifecycle,trust_tier=excluded.trust_tier,
        current_revision=excluded.current_revision,body_cache=excluded.body_cache,
        frontmatter=excluded.frontmatter,aliases=excluded.aliases,layer=excluded.layer,
        content_hash=excluded.content_hash,token_estimate=excluded.token_estimate,
        refresh_status='CURRENT',updated_at=now()
      returning id
      `,
      [
        review.space_id,
        `managed/${change.path}`,
        externalId,
        String(data.title ?? path.basename(change.path, ".md")),
        String(data.type ?? "source-summary"),
        revision,
        parsed.content,
        JSON.stringify(data),
        Array.isArray(data.aliases) ? data.aliases.map(String) : [],
        String(data.knowledge_layer ?? "source"),
        createHash("sha256").update(raw).digest("hex"),
        Math.ceil(raw.length / 4),
      ],
    );
    const documentId = indexed.rows[0]?.id;
    if (!documentId)
      throw new Error(`Could not index merged document ${change.path}.`);
    if (change.operation === "UPDATE") {
      await db.pool.query(
        `
        with recursive downstream(id,trail) as (
          select r.from_document_id,array[$1::uuid,r.from_document_id]
            from knowledge_relations r where r.to_document_id=$1
          union all
          select r.from_document_id,d.trail||r.from_document_id
            from downstream d join knowledge_relations r on r.to_document_id=d.id
           where not r.from_document_id=any(d.trail)
        )
        update knowledge_documents k
           set refresh_status='STALE_PENDING_REVIEW',invalidated_by=$1,
               stale_reason='Dependency changed in approved review',updated_at=now()
          from downstream d where k.id=d.id
        `,
        [documentId],
      );
    }
    const contentHash = createHash("sha256").update(raw).digest("hex");
    await db.pool.query(
      `
      insert into knowledge_versions(document_id,git_commit,content_hash,body,frontmatter)
      values($1,$2,$3,$4,$5::jsonb)
      on conflict(document_id,git_commit) do nothing
      `,
      [documentId, revision, contentHash, parsed.content, JSON.stringify(data)],
    );
    const sourceId = (review.impact_manifest as Record<string, unknown>)
      .sourceId;
    if (typeof sourceId === "string") {
      await db.pool.query(
        `
        insert into document_evidence(document_id,evidence_id)
        select $1,e.id from evidence e where e.source_id=$2
        on conflict do nothing
        `,
        [documentId, sourceId],
      );
    }
    await db.pool.query("delete from knowledge_units where document_id=$1", [
      documentId,
    ]);
    const units = parseKnowledgeUnits(
      String(data.title ?? path.basename(change.path, ".md")),
      parsed.content,
    );
    const adapter = new DeterministicEmbeddingAdapter();
    const generation = await db.pool.query<{ id: string }>(
      `
      insert into embedding_generations(
        space_id,provider,model,model_revision,dimensions,normalization,
        configuration_version,corpus_revision,status
      )
      values($1,$2,$3,$4,$5,$6,$7,$8,'READY')
      on conflict(
        space_id,provider,model,model_revision,configuration_version,corpus_revision
      ) do update set status=embedding_generations.status
      returning id
      `,
      [
        review.space_id,
        adapter.descriptor.provider,
        adapter.descriptor.model,
        adapter.descriptor.modelRevision,
        adapter.descriptor.dimensions,
        adapter.descriptor.normalization,
        adapter.descriptor.configurationVersion,
        projectionRevision,
      ],
    );
    const vectors = await adapter.embed(units.map((unit) => unit.body));
    for (let index = 0; index < units.length; index += 1) {
      const unit = units[index];
      const vector = vectors[index];
      if (!unit || !vector) continue;
      const inserted = await db.pool.query<{ id: string }>(
        `
        insert into knowledge_units(
          document_id,space_id,unit_key,unit_type,heading_path,body,content_hash,
          corpus_revision,lifecycle,trust_tier,token_estimate
        )
        values($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE','HUMAN_REVIEWED',$9)
        returning id
        `,
        [
          documentId,
          review.space_id,
          unit.unitKey,
          unit.unitType,
          unit.headingPath,
          unit.body,
          unit.contentHash,
          projectionRevision,
          unit.tokenEstimate,
        ],
      );
      await db.pool.query(
        `
        insert into unit_embeddings(unit_id,generation_id,content_hash,embedding)
        values($1,$2,$3,$4::vector)
        `,
        [
          inserted.rows[0]?.id,
          generation.rows[0]?.id,
          unit.contentHash,
          toPgVector(vector),
        ],
      );
    }
  }
  await db.pool.query(
    `
    insert into index_revisions(
      space_id,corpus_revision,lexical_revision,graph_revision,context_pack_revision,
      status,warnings
    )
    values($1,$2,$2,$2,$2,'DEGRADED','["VECTOR_DISABLED_PENDING_BENCHMARK"]'::jsonb)
    on conflict(space_id) do update set
      corpus_revision=excluded.corpus_revision,
      lexical_revision=excluded.lexical_revision,
      graph_revision=excluded.graph_revision,
      context_pack_revision=excluded.context_pack_revision,
      vector_revision=null,
      status=excluded.status,
      warnings=excluded.warnings,
      updated_at=now()
    `,
    [review.space_id, projectionRevision],
  );
}

/** Reconcile Git content first, then rebuild every derived retrieval index. */
async function indexMergedChanges(
  db: Postgres,
  review: Record<string, unknown>,
  revision: string,
): Promise<{
  corpusRevision: string;
  unitCount: number;
  documentCount: number;
}> {
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
  const store = new GitKnowledgeStore(repositoryPath());
  await synchronizeManagedPaths(db, store, {
    spaceId: String(review.space_id),
    revision,
    changes,
    ...(typeof manifest.sourceId === "string"
      ? { sourceId: manifest.sourceId }
      : {}),
  });
  return rebuildSpaceProjections(db, String(review.space_id), revision);
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

function canAccessReview(
  actor: ReturnType<typeof actorOf>,
  review: Record<string, unknown>,
  permission:
    "knowledge:read" | "knowledge:propose" | "knowledge:review" | "admin",
): boolean {
  const spaceId = String(review.space_id);
  return (
    hasValidReviewManifest(review) &&
    hasSpaceAccess(actor, spaceId, permission) &&
    reviewPaths(review).every((reviewPath) =>
      hasPathAccess(actor, spaceId, permission, reviewPath),
    )
  );
}

export function registerReviewRoutes(app: FastifyInstance, db: Postgres): void {
  app.post<{
    Body: {
      spaceId?: string;
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
      const spaceId =
        request.body.spaceId ?? "00000000-0000-0000-0000-000000000003";
      if (!hasSpaceAccess(actorOf(request), spaceId, "knowledge:propose")) {
        return reply.code(403).send({ code: "SPACE_ACCESS_DENIED" });
      }
      const deniedPath = changes.find(
        (change) =>
          !hasPathAccess(
            actorOf(request),
            spaceId,
            "knowledge:propose",
            change.path,
          ),
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
      const reviewId = randomUUID();
      const store = new GitKnowledgeStore(repositoryPath());
      const baseRevision = await store.ensureRepository(
        process.env.AKP_GIT_AUTHOR_NAME ?? "Architecture Knowledge Platform",
        process.env.AKP_GIT_AUTHOR_EMAIL ?? "akp@localhost",
      );
      const branchName = await store.createDraftBranch(reviewId, baseRevision);
      const proposedChanges = await Promise.all(
        changes.map(async (change) => ({
          path: change.path,
          operation: (await store.hasFileAtRevision(baseRevision, change.path))
            ? ("UPDATE" as const)
            : ("CREATE" as const),
          reasons: [change.reason ?? "Direct proposal"],
        })),
      );
      for (const change of changes)
        await store.writeDraftFile(change.path, change.content);
      const headCommit = await store.commitAll(
        request.body.summary ?? "knowledge: direct proposal",
        process.env.AKP_GIT_AUTHOR_NAME ?? "Architecture Knowledge Platform",
        process.env.AKP_GIT_AUTHOR_EMAIL ?? "akp@localhost",
      );
      try {
        await db.pool.query(
          `
          insert into reviews(id,space_id,branch_name,base_commit,head_commit,status,author_id,
                              impact_manifest,validation_report)
          values($1,$2,$3,$4,$5,'PENDING',$6,$7::jsonb,$8::jsonb)
          `,
          [
            reviewId,
            spaceId,
            branchName,
            baseRevision,
            headCommit,
            actorOf(request)?.id ?? null,
            JSON.stringify({
              summary: request.body.summary ?? "",
              proposedChanges,
            }),
            JSON.stringify({ issues, errors: 0 }),
          ],
        );
      } catch (error) {
        await store.cleanupDraft(branchName).catch(() => undefined);
        throw error;
      }
      await audit(
        db,
        request,
        "knowledge.propose",
        "review",
        reviewId,
        {},
        spaceId,
      );
      return reply
        .code(201)
        .send({ reviewId, status: "PENDING", branchName, headCommit });
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
      return {
        reviews: result.rows.filter((review) =>
          canAccessReview(actor, review, "knowledge:read"),
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
      if (!canAccessReview(actor, review.rows[0], "knowledge:propose")) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const result = await db.pool.query(
        `
        update reviews set status='PENDING',updated_at=now()
         where id=$1 and author_id=$2 and space_id=any($3::uuid[])
           and status in ('PENDING','CHANGES_REQUESTED')
         returning id,status,space_id
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
        {},
        String(result.rows[0]?.space_id),
      );
      return result.rows[0];
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
        !canAccessReview(actorOf(request), review, "knowledge:read")
      ) {
        return reply.code(404).send({ code: "REVIEW_NOT_FOUND" });
      }
      const comments = await db.pool.query(
        "select * from review_comments where review_id=$1 order by created_at",
        [request.params.id],
      );
      const store = new GitKnowledgeStore(repositoryPath());
      const diff = await store
        .diff(String(review.base_commit), String(review.head_commit))
        .catch(() => "");
      return { ...review, comments: comments.rows, diff };
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
        !canAccessReview(actorOf(request), review, "knowledge:review")
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
          const claimed = await db.pool.query(
            `
            update reviews set status='PUBLISHING',updated_at=now()
             where id=$1 and space_id=$2 and status in ('PENDING','CHANGES_REQUESTED')
             returning *
            `,
            [request.params.id, review.space_id],
          );
          if (!claimed.rowCount) {
            return reply.code(409).send({
              code: "REVIEW_ALREADY_DECIDED",
              status: review.status,
            });
          }
          await renewPublicationLock(db, publicationKey, lockOwner);
          revision = await store.mergeDraft(
            String(review.branch_name),
            String(review.base_commit),
            String(review.head_commit),
            process.env.AKP_GIT_AUTHOR_NAME ??
              "Architecture Knowledge Platform",
            process.env.AKP_GIT_AUTHOR_EMAIL ?? "akp@localhost",
          );
          await renewPublicationLock(db, publicationKey, lockOwner);
          await indexMergedChanges(db, review, revision);
          await renewPublicationLock(db, publicationKey, lockOwner);
          const lint = await runKnowledgeLint(
            db,
            String(review.space_id),
            "MERGE",
          );
          const evals = await runEvaluation(
            db,
            { name: "post-merge-impacted-regression" },
            String(review.space_id),
          );
          await renewPublicationLock(db, publicationKey, lockOwner);
          await db.pool.query(
            `
            update reviews set status='APPROVED',decision_by=$2,decision_at=now(),
                   decision_reason=$3,merged_commit=$4,updated_at=now()
             where id=$1 and status='PUBLISHING'
            `,
            [
              request.params.id,
              actor?.id ?? null,
              request.body.reason ?? null,
              revision,
            ],
          );
          const jobId = (review.impact_manifest as Record<string, unknown>)
            ?.jobId;
          if (typeof jobId === "string") {
            await db.pool.query(
              `
              update ingest_jobs set state='COMPLETED',updated_at=now(),
                     result=coalesce(result,'{}'::jsonb)||$2::jsonb
               where id=$1
              `,
              [jobId, JSON.stringify({ mergedCommit: revision })],
            );
          }
          await audit(
            db,
            request,
            "review.approve",
            "review",
            request.params.id,
            { revision },
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
            lint,
            evals,
          };
        } catch (error) {
          let compensatingRevision: string | null = null;
          let compensationSucceeded = revision === null;
          if (revision) {
            try {
              compensatingRevision = await store.rollbackMain(revision);
              await indexMergedChanges(db, review, compensatingRevision);
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
          }
          await db.pool.query(
            `
            update reviews
               set status=$2,merged_commit=case when $2='CHANGES_REQUESTED' then null else merged_commit end,
                   decision_reason=$3,updated_at=now()
             where id=$1 and status='PUBLISHING'
            `,
            [
              request.params.id,
              compensationSucceeded
                ? "CHANGES_REQUESTED"
                : "PUBLICATION_RECOVERY_REQUIRED",
              "Publication failed; inspect the Error Book before retrying.",
            ],
          );
          await recordPublicationFailure(
            db,
            String(review.space_id),
            error instanceof Error ? error.message : String(error),
            {
              reviewId: request.params.id,
              mergedRevision: revision,
              compensatingRevision,
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
               decision_reason=$4,updated_at=now()
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
           where id=$1
          `,
          [
            relatedJobId,
            decision === "REJECT" ? "CANCELLED" : "DRAFTED",
            JSON.stringify({
              reviewDecision: decision,
              reason: request.body.reason ?? null,
            }),
          ],
        );
      }
      await audit(
        db,
        request,
        `review.${decision.toLowerCase()}`,
        "review",
        request.params.id,
        {},
        String(review.space_id),
      );
      await new GitKnowledgeStore(repositoryPath())
        .cleanupDraft(String(review.branch_name))
        .catch(async (cleanupError) => {
          await recordPublicationFailure(
            db,
            String(review.space_id),
            "Closed review draft cleanup failed",
            {
              reviewId: request.params.id,
              error:
                cleanupError instanceof Error
                  ? cleanupError.message
                  : String(cleanupError),
            },
          );
        });
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
        !canAccessReview(actorOf(request), review, "admin") ||
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
        revision = await store.rollbackMain(String(review.merged_commit));
        await renewPublicationLock(db, publicationKey, lockOwner);
        const manifest = review.impact_manifest as {
          sourceId?: string;
          proposedChanges?: Array<{
            path: string;
            operation?: "CREATE" | "UPDATE";
          }>;
        };
        await synchronizeManagedPaths(db, store, {
          spaceId: String(review.space_id),
          revision,
          changes: (manifest.proposedChanges ?? []).map((change) => ({
            path: change.path,
            ...(change.operation ? { operation: change.operation } : {}),
          })),
          ...(typeof manifest.sourceId === "string"
            ? { sourceId: manifest.sourceId }
            : {}),
        });
        const projection = await rebuildSpaceProjections(
          db,
          String(review.space_id),
          revision,
        );
        const lint = await runKnowledgeLint(
          db,
          String(review.space_id),
          "INDEX_REBUILD",
        );
        const evals = await runEvaluation(
          db,
          { name: "post-rollback-impacted-regression" },
          String(review.space_id),
        );
        await renewPublicationLock(db, publicationKey, lockOwner);
        const completed = await db.pool.query(
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
        await audit(
          db,
          request,
          "review.rollback",
          "review",
          request.params.id,
          { revision, projection },
          String(review.space_id),
        );
        return {
          id: request.params.id,
          status: "ROLLED_BACK",
          revision,
          projection,
          lint,
          evals,
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
        !canAccessReview(actorOf(request), review.rows[0], "knowledge:review")
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
        { path: request.body.path ?? null, line: request.body.line ?? null },
        String(review.rows[0]?.space_id),
      );
      return reply.code(201).send(result.rows[0]);
    },
  );
}
