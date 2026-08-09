import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { runKnowledgeLint, type Postgres } from "@akp/postgres";
import { importVaultReadOnly } from "@akp/vault-importer";
import { GitKnowledgeStore } from "@akp/git-store";
import {
  actorOf,
  audit,
  hasPathAccess,
  hasSpaceAccess,
  hasUnrestrictedPathAccess,
  requirePermission,
  spaceIdsForPermission,
  unrestrictedSpaceIdsForPermission,
} from "../auth.js";
import {
  rebuildManagedRelations,
  rebuildSpaceProjections,
} from "../projections.js";
import { queryKnowledge } from "./search.js";

const DEFAULT_SPACE = "00000000-0000-0000-0000-000000000003";

function managedRepositoryPath(): string {
  return (
    process.env.AKP_MANAGED_REPO ?? path.join(tmpdir(), "akp-managed-knowledge")
  );
}

async function resolveDocument(
  db: Postgres,
  id: string,
  spaceIds: string[],
): Promise<Record<string, unknown> | null> {
  const result = await db.pool.query(
    `
    select id,space_id,external_id,path,title,current_revision,refresh_status
      from knowledge_documents
     where (id::text=$1 or external_id=$1) and space_id=any($2::uuid[])
     order by updated_at desc limit 1
    `,
    [id, spaceIds],
  );
  return result.rows[0] ?? null;
}

export function registerGovernanceRoutes(
  app: FastifyInstance,
  db: Postgres,
): void {
  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/v1/sources/:id/retire",
    { preHandler: requirePermission("source:write") },
    async (request, reply) => {
      const actor = actorOf(request);
      const candidate = await db.pool.query<{ id: string; space_id: string }>(
        "select id,space_id from sources where id=$1 and space_id=any($2::uuid[])",
        [request.params.id, spaceIdsForPermission(actor, "source:write")],
      );
      const candidateSource = candidate.rows[0];
      if (!candidateSource) {
        return reply.code(404).send({ code: "SOURCE_NOT_FOUND" });
      }
      if (
        !hasUnrestrictedPathAccess(
          actor,
          candidateSource.space_id,
          "source:write",
        )
      ) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const source = await db.pool.query(
        `
        update sources set status='RETIRED',
               metadata=metadata||$3::jsonb
         where id=$1 and space_id=any($2::uuid[])
         returning id,space_id,sha256,status
        `,
        [
          request.params.id,
          spaceIdsForPermission(actor, "source:write"),
          JSON.stringify({
            retiredAt: new Date().toISOString(),
            reason: request.body?.reason ?? "Source retired",
          }),
        ],
      );
      if (!source.rowCount)
        return reply.code(404).send({ code: "SOURCE_NOT_FOUND" });
      const row = source.rows[0];
      const impacted = await db.pool.query(
        `
        with recursive seeds(id) as (
          select id from knowledge_documents
           where space_id=$1 and (
             frontmatter->>'source_sha256'=$2 or
             external_id=$3
           )
        ), downstream(id,trail) as (
          select id,array[id] from seeds
          union all
          select r.from_document_id,d.trail||r.from_document_id
            from downstream d
            join knowledge_relations r on r.to_document_id=d.id
           where r.space_id=$1 and not r.from_document_id=any(d.trail)
        )
        update knowledge_documents k
           set refresh_status='STALE_BLOCKED',
               stale_reason='Supporting source was retired',
               updated_at=now()
          from downstream d where k.id=d.id and k.space_id=$1
        returning k.id,k.external_id,k.path
        `,
        [
          row.space_id,
          row.sha256,
          `SRC-INGEST-${String(row.sha256).slice(0, 12).toUpperCase()}`,
        ],
      );
      await audit(
        db,
        request,
        "source.retire",
        "source",
        request.params.id,
        {
          impacted: impacted.rowCount ?? 0,
        },
        String(row.space_id),
      );
      const lint = await runKnowledgeLint(
        db,
        String(row.space_id),
        "SOURCE_UPDATE",
      );
      return { source: row, impacted: impacted.rows, lint };
    },
  );

  app.post<{
    Params: { id: string };
    Body: { severity?: string; reason?: string };
  }>(
    "/v1/knowledge/:id/invalidate",
    { preHandler: requirePermission("knowledge:review") },
    async (request, reply) => {
      const actor = actorOf(request);
      const seed = await resolveDocument(
        db,
        request.params.id,
        spaceIdsForPermission(actor, "knowledge:review"),
      );
      if (!seed) return reply.code(404).send({ code: "DOCUMENT_NOT_FOUND" });
      const spaceId = String(seed.space_id);
      if (
        !hasSpaceAccess(actor, spaceId, "knowledge:review") ||
        !hasPathAccess(actor, spaceId, "knowledge:review", String(seed.path)) ||
        !hasUnrestrictedPathAccess(actor, spaceId, "knowledge:review")
      ) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const blocked =
        String(request.body?.severity ?? "WARN").toUpperCase() === "BLOCK";
      const reason =
        request.body?.reason?.trim() || "Upstream knowledge changed.";
      const impacted = await db.pool.query(
        `
        with recursive downstream(id,depth,trail) as (
          select $1::uuid,0,array[$1::uuid]
          union all
          select r.from_document_id,d.depth+1,d.trail||r.from_document_id
            from downstream d
            join knowledge_relations r on r.to_document_id=d.id
           where r.space_id=$4 and d.depth < 12 and not r.from_document_id=any(d.trail)
        )
        update knowledge_documents k
           set refresh_status=$2,
               invalidated_by=$1,
               stale_reason=$3,
               updated_at=now()
          from downstream d
         where k.id=d.id and k.space_id=$4
         returning k.id,k.external_id,k.path,d.depth
        `,
        [
          seed.id,
          blocked ? "STALE_BLOCKED" : "STALE_PENDING_REVIEW",
          reason,
          spaceId,
        ],
      );
      await db.pool.query(
        `
        insert into error_book(space_id,error_type,status,root_cause,metadata)
        values($1,'STALE_CLAIM','OPEN',$2,$3::jsonb)
        `,
        [
          spaceId,
          reason,
          JSON.stringify({
            seedDocumentId: seed.id,
            impactedDocumentIds: impacted.rows.map((row) => row.id),
          }),
        ],
      );
      await audit(
        db,
        request,
        "knowledge.invalidate",
        "knowledge_document",
        String(seed.id),
        {
          severity: blocked ? "BLOCK" : "WARN",
          impacted: impacted.rowCount ?? 0,
        },
        spaceId,
      );
      return {
        seed,
        impacted: impacted.rows,
        refreshStatus: blocked ? "STALE_BLOCKED" : "STALE_PENDING_REVIEW",
      };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/v1/knowledge/:id/verify",
    { preHandler: requirePermission("knowledge:review") },
    async (request, reply) => {
      const actor = actorOf(request);
      const seed = await resolveDocument(
        db,
        request.params.id,
        spaceIdsForPermission(actor, "knowledge:review"),
      );
      if (!seed) return reply.code(404).send({ code: "DOCUMENT_NOT_FOUND" });
      if (
        !hasPathAccess(
          actor,
          String(seed.space_id),
          "knowledge:review",
          String(seed.path),
        )
      ) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const result = await db.pool.query(
        `
        update knowledge_documents
           set refresh_status='CURRENT',invalidated_by=null,stale_reason=null,
               last_verified_at=now(),verified_against_revision=current_revision,updated_at=now()
         where id=$1 returning id,external_id,refresh_status,last_verified_at
        `,
        [seed.id],
      );
      await audit(
        db,
        request,
        "knowledge.verify",
        "knowledge_document",
        String(seed.id),
        {
          reason: request.body?.reason ?? null,
        },
        String(seed.space_id),
      );
      return result.rows[0];
    },
  );

  app.post<{
    Body: {
      topic: string;
      documentIds: string[];
      authority?: string;
      scope?: string;
    };
  }>(
    "/v1/contradictions",
    { preHandler: requirePermission("knowledge:review") },
    async (request, reply) => {
      if (
        !request.body?.topic?.trim() ||
        (request.body.documentIds?.length ?? 0) < 2
      ) {
        return reply
          .code(400)
          .send({ code: "CONTRADICTION_REQUIRES_TWO_DOCUMENTS" });
      }
      const actor = actorOf(request);
      const documents = await db.pool.query(
        `
        select id,space_id,path from knowledge_documents
         where id=any($1::uuid[]) and space_id=any($2::uuid[])
        `,
        [
          request.body.documentIds,
          spaceIdsForPermission(actor, "knowledge:review"),
        ],
      );
      if (documents.rowCount !== request.body.documentIds.length) {
        return reply.code(403).send({ code: "DOCUMENT_SCOPE_MISMATCH" });
      }
      if (
        documents.rows.some(
          (document) =>
            !hasPathAccess(
              actor,
              String(document.space_id),
              "knowledge:review",
              String(document.path),
            ),
        )
      ) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const spaces = new Set(documents.rows.map((row) => String(row.space_id)));
      if (spaces.size !== 1)
        return reply.code(400).send({ code: "CROSS_SPACE_CONTRADICTION" });
      const spaceId = [...spaces][0] ?? DEFAULT_SPACE;
      const id = randomUUID();
      const client = await db.pool.connect();
      try {
        await client.query("begin");
        await client.query(
          "insert into contradiction_clusters(id,space_id,topic) values($1,$2,$3)",
          [id, spaceId, request.body.topic.trim()],
        );
        for (const documentId of request.body.documentIds) {
          await client.query(
            `
            insert into contradiction_members(cluster_id,document_id,authority,scope)
            values($1,$2,$3,$4)
            `,
            [
              id,
              documentId,
              request.body.authority ?? null,
              request.body.scope ?? null,
            ],
          );
          await client.query(
            "update knowledge_documents set lifecycle='DISPUTED' where id=$1",
            [documentId],
          );
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      await audit(
        db,
        request,
        "contradiction.create",
        "contradiction_cluster",
        id,
        {},
        spaceId,
      );
      return reply.code(201).send({ id, status: "OPEN" });
    },
  );

  app.get(
    "/v1/contradictions",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const actor = actorOf(request);
      const spaceIds = unrestrictedSpaceIdsForPermission(
        actor,
        "knowledge:read",
      );
      if (!spaceIds.length) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const result = await db.pool.query(
        `
        select c.*,coalesce(jsonb_agg(jsonb_build_object(
          'documentId',d.id,'externalId',d.external_id,'title',d.title,'authority',m.authority,
          'scope',m.scope
        )) filter(where d.id is not null),'[]'::jsonb) members
          from contradiction_clusters c
          left join contradiction_members m on m.cluster_id=c.id
          left join knowledge_documents d on d.id=m.document_id
         where c.space_id=any($1::uuid[])
         group by c.id order by c.created_at desc
        `,
        [spaceIds],
      );
      return { contradictions: result.rows };
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      resolution?: string;
      documentOutcomes?: Array<{
        documentId: string;
        lifecycle: "ACTIVE" | "SUPERSEDED";
      }>;
    };
  }>(
    "/v1/contradictions/:id/resolve",
    { preHandler: requirePermission("knowledge:review") },
    async (request, reply) => {
      const resolution = request.body?.resolution?.trim();
      if (!resolution) {
        return reply
          .code(400)
          .send({ code: "CONTRADICTION_RESOLUTION_REQUIRED" });
      }
      const actor = actorOf(request);
      const cluster = await db.pool.query(
        `
        select id,space_id,status from contradiction_clusters
         where id=$1 and space_id=any($2::uuid[])
        `,
        [request.params.id, spaceIdsForPermission(actor, "knowledge:review")],
      );
      if (!cluster.rowCount) {
        return reply.code(404).send({ code: "CONTRADICTION_NOT_FOUND" });
      }
      if (
        !hasUnrestrictedPathAccess(
          actor,
          String(cluster.rows[0]?.space_id),
          "knowledge:review",
        )
      ) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      if (String(cluster.rows[0]?.status) === "RESOLVED") {
        return reply.code(409).send({ code: "CONTRADICTION_ALREADY_RESOLVED" });
      }
      const outcomes = request.body.documentOutcomes ?? [];
      const memberIds = outcomes.map((outcome) => outcome.documentId);
      if (memberIds.length !== new Set(memberIds).size) {
        return reply.code(400).send({ code: "DUPLICATE_DOCUMENT_OUTCOME" });
      }
      if (memberIds.length) {
        const membership = await db.pool.query(
          `
          select m.document_id,d.path,d.space_id
            from contradiction_members m
            join knowledge_documents d on d.id=m.document_id
           where m.cluster_id=$1 and m.document_id=any($2::uuid[])
          `,
          [request.params.id, memberIds],
        );
        if (membership.rowCount !== memberIds.length) {
          return reply
            .code(400)
            .send({ code: "OUTCOME_DOCUMENT_NOT_IN_CLUSTER" });
        }
        if (
          membership.rows.some(
            (member) =>
              !hasPathAccess(
                actor,
                String(member.space_id),
                "knowledge:review",
                String(member.path),
              ),
          )
        ) {
          return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
        }
      }
      const client = await db.pool.connect();
      try {
        await client.query("begin");
        for (const outcome of outcomes) {
          await client.query(
            `
            update knowledge_documents
               set lifecycle=$2,
                   refresh_status=case when $2='ACTIVE' then 'CURRENT' else 'INVALID' end,
                   stale_reason=case when $2='ACTIVE' then null else $3 end,
                   updated_at=now()
             where id=$1
            `,
            [outcome.documentId, outcome.lifecycle, resolution],
          );
        }
        await client.query(
          `
          update contradiction_clusters
             set status='RESOLVED',resolution=$2,reviewer_id=$3,updated_at=now()
           where id=$1
          `,
          [request.params.id, resolution, actor?.id ?? null],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      await audit(
        db,
        request,
        "contradiction.resolve",
        "contradiction_cluster",
        request.params.id,
        {
          outcomeCount: outcomes.length,
        },
        String(cluster.rows[0]?.space_id),
      );
      return {
        id: request.params.id,
        status: "RESOLVED",
        resolution,
        documentOutcomes: outcomes,
      };
    },
  );

  app.post<{ Body: { query: string; spaceId?: string } }>(
    "/v1/identity/check",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const query = request.body?.query?.trim();
      const spaceId = request.body?.spaceId ?? DEFAULT_SPACE;
      if (!query)
        return reply.code(400).send({ code: "IDENTITY_QUERY_REQUIRED" });
      if (!hasSpaceAccess(actorOf(request), spaceId, "knowledge:read")) {
        return reply.code(403).send({ code: "SPACE_ACCESS_DENIED" });
      }
      const hits = await queryKnowledge(
        db,
        {
          query,
          spaceId,
          types: [],
          minimumTrust: "UNVERIFIED",
          mode: "COMPILED_ONLY",
          limit: 10,
        },
        {
          pathAuthorizer: (knowledgePath) =>
            hasPathAccess(
              actorOf(request),
              spaceId,
              "knowledge:read",
              knowledgePath,
            ),
        },
      );
      const exact = hits.filter((hit) =>
        hit.reasons.includes("exact-or-alias"),
      );
      return {
        classification:
          exact.length === 1
            ? "SAME_IDENTITY"
            : exact.length > 1
              ? "UNRESOLVED"
              : hits.length
                ? "POSSIBLE_DUPLICATE"
                : "DISTINCT_CONCEPT",
        candidates: hits,
        requiresReview:
          exact.length > 1 || (exact.length === 0 && hits.length > 0),
      };
    },
  );

  app.post<{ Body: { trigger?: string } }>(
    "/v1/lint/run",
    { preHandler: requirePermission("eval:run") },
    async (request, reply) => {
      const actor = actorOf(request);
      const trigger = String(request.body?.trigger ?? "MANUAL").toUpperCase();
      if (trigger !== "MANUAL" && trigger !== "SCHEDULED") {
        return {
          code: "LINT_TRIGGER_RESERVED",
          allowed: ["MANUAL", "SCHEDULED"],
        };
      }
      const results = [];
      const spaceIds = unrestrictedSpaceIdsForPermission(actor, "eval:run");
      if (!spaceIds.length) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      for (const spaceId of spaceIds) {
        results.push(
          await runKnowledgeLint(
            db,
            spaceId,
            trigger as "MANUAL" | "SCHEDULED",
          ),
        );
      }
      await audit(
        db,
        request,
        "knowledge.lint",
        "knowledge_lint_run",
        results.map((result) => result.id).join(","),
      );
      return { status: "COMPLETED", results };
    },
  );

  app.get(
    "/v1/error-book",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const spaceIds = unrestrictedSpaceIdsForPermission(
        actorOf(request),
        "knowledge:read",
      );
      if (!spaceIds.length) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const result = await db.pool.query(
        "select * from error_book where space_id=any($1::uuid[]) order by created_at desc",
        [spaceIds],
      );
      return { errors: result.rows };
    },
  );

  app.get(
    "/v1/indexes",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const spaceIds = unrestrictedSpaceIdsForPermission(
        actorOf(request),
        "knowledge:read",
      );
      if (!spaceIds.length) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const result = await db.pool.query(
        "select * from index_revisions where space_id=any($1::uuid[]) order by updated_at desc",
        [spaceIds],
      );
      return { indexes: result.rows };
    },
  );

  app.post<{
    Body: {
      spaceId?: string;
      confirm?: string;
      reimportVault?: boolean;
    };
  }>(
    "/v1/reindex",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      const actor = actorOf(request);
      const spaceId = request.body?.spaceId;
      if (!spaceId) {
        return reply.code(400).send({ code: "REINDEX_SPACE_REQUIRED" });
      }
      if (!hasUnrestrictedPathAccess(actor, spaceId, "admin")) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const requiredConfirmation = request.body?.reimportVault
        ? "REIMPORT_AND_REBUILD"
        : "REBUILD_DERIVED_PROJECTIONS";
      if (request.body?.confirm !== requiredConfirmation) {
        return reply.code(409).send({
          code: "REINDEX_CONFIRMATION_REQUIRED",
          confirmation: requiredConfirmation,
        });
      }
      const imports: unknown[] = [];
      if (request.body.reimportVault) {
        const vault = await db.pool.query<{
          canonical_path: string;
          space_id: string;
        }>(
          "select canonical_path,space_id from vaults where space_id=$1 order by last_imported_at desc nulls last limit 1",
          [spaceId],
        );
        const canonical = vault.rows[0];
        if (!canonical) {
          return reply.code(404).send({ code: "VAULT_NOT_FOUND" });
        }
        imports.push(
          await importVaultReadOnly(db, canonical.canonical_path, { spaceId }),
        );
      }
      const store = new GitKnowledgeStore(managedRepositoryPath());
      const managedRevision = await store.revision().catch(() => null);
      const relationCount = await rebuildManagedRelations(db, spaceId);
      const projection = await rebuildSpaceProjections(
        db,
        spaceId,
        managedRevision,
      );
      const lint = await runKnowledgeLint(db, spaceId, "INDEX_REBUILD");
      await audit(
        db,
        request,
        "index.rebuild",
        "index_revision",
        spaceId,
        {
          relationCount,
          reimportVault: Boolean(request.body.reimportVault),
          projection,
        },
        spaceId,
      );
      return {
        status: "REBUILT_FROM_CURRENT_CANONICAL_REVISION",
        imports,
        relationCount,
        projection,
        lint,
      };
    },
  );
}
