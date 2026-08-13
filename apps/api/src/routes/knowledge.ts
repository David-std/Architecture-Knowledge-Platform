import type { FastifyInstance } from "fastify";
import path from "node:path";
import { VaultRegistration } from "@akp/contracts";
import {
  registerVault,
  resolveAuthorizedVaultScope,
  type Postgres,
} from "@akp/postgres";
import {
  actorOf,
  audit,
  hasPathAccess,
  hasUnrestrictedPathAccess,
  requirePermission,
  spaceIdsForPermission,
  unrestrictedSpaceIdsForPermission,
} from "../auth.js";

function readableDocument(
  actor: ReturnType<typeof actorOf>,
  row: Record<string, unknown>,
  permission: "knowledge:read" | "source:read",
): boolean {
  return hasPathAccess(
    actor,
    String(row.space_id ?? row.spaceId ?? ""),
    permission,
    String(row.path ?? ""),
  );
}

async function authorizedVaultIds(
  db: Postgres,
  actor: ReturnType<typeof actorOf>,
  permission: "knowledge:read" | "source:read",
  unrestricted: boolean,
): Promise<{ spaces: string[]; vaultIds: string[] }> {
  if (!actor) return { spaces: [], vaultIds: [] };
  const spaces = unrestricted
    ? unrestrictedSpaceIdsForPermission(actor, permission)
    : spaceIdsForPermission(actor, permission);
  const vaultIds: string[] = [];
  for (const spaceId of spaces) {
    try {
      const scope = await resolveAuthorizedVaultScope(db, {
        userId: actor.id,
        spaceId,
        permission,
        federated: true,
      });
      vaultIds.push(...scope.vaultIds);
    } catch {
      // A private vault remains invisible without an explicit membership.
    }
  }
  return { spaces, vaultIds: [...new Set(vaultIds)] };
}

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  db: Postgres,
): void {
  app.get(
    "/v1/status",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const scope = await authorizedVaultIds(
        db,
        actorOf(request),
        "knowledge:read",
        true,
      );
      if (!scope.spaces.length) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      if (!scope.vaultIds.length)
        return reply.code(403).send({ code: "VAULT_ACCESS_DENIED" });
      const [
        documents,
        units,
        relations,
        sources,
        jobs,
        reviews,
        vault,
        indexes,
      ] = await Promise.all([
        db.pool.query(
          "select count(*)::int count from knowledge_documents where space_id=any($1::uuid[]) and vault_id=any($2::uuid[])",
          [scope.spaces, scope.vaultIds],
        ),
        db.pool.query(
          "select count(*)::int count from knowledge_units where space_id=any($1::uuid[]) and vault_id=any($2::uuid[])",
          [scope.spaces, scope.vaultIds],
        ),
        db.pool.query(
          "select count(*)::int count from knowledge_relations r where space_id=any($1::uuid[]) and exists(select 1 from knowledge_documents d where d.id=r.from_document_id and d.vault_id=any($2::uuid[]))",
          [scope.spaces, scope.vaultIds],
        ),
        db.pool.query(
          "select count(*)::int count from sources where space_id=any($1::uuid[]) and vault_id=any($2::uuid[])",
          [scope.spaces, scope.vaultIds],
        ),
        db.pool.query(
          "select state, count(*)::int count from ingest_jobs where space_id=any($1::uuid[]) and vault_id=any($2::uuid[]) group by state order by state",
          [scope.spaces, scope.vaultIds],
        ),
        db.pool.query(
          "select status, count(*)::int count from reviews where space_id=any($1::uuid[]) and vault_id=any($2::uuid[]) group by status order by status",
          [scope.spaces, scope.vaultIds],
        ),
        db.pool.query(
          "select id,vault_key,name,local_path,read_only,current_revision,last_imported_at from vaults where id=any($1::uuid[]) order by vault_key",
          [scope.vaultIds],
        ),
        db.pool.query(
          "select * from vault_index_revisions where vault_id=any($1::uuid[]) order by vault_id",
          [scope.vaultIds],
        ),
      ]);
      return {
        status: "UP",
        capabilities: {
          lexicalSearch: true,
          graphSearch: true,
          vectorSearch: process.env.AKP_VECTOR_ENABLED === "true",
          readOnlyVaultImport: true,
          immutableObjectStore: true,
          reviewWorkflow: true,
          hierarchicalUnits: true,
          freshnessInvalidation: true,
          contradictionClusters: true,
          contextPackets: true,
          webSessions: true,
          schemaDryRun: true,
          scheduledLint: true,
          errorBookRegressions: true,
          docxPptxExtraction: true,
          audioVideoCapabilityDetection: true,
        },
        corpus: {
          documents: documents.rows[0]?.count ?? 0,
          units: units.rows[0]?.count ?? 0,
          relations: relations.rows[0]?.count ?? 0,
          sources: sources.rows[0]?.count ?? 0,
          vaults: vault.rows,
        },
        jobs: jobs.rows,
        reviews: reviews.rows,
        indexes: indexes.rows,
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/context-packs/:id",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const actor = actorOf(request);
      const scope = await authorizedVaultIds(
        db,
        actor,
        "knowledge:read",
        false,
      );
      if (!scope.vaultIds.length) {
        return reply.code(404).send({ code: "CONTEXT_PACK_NOT_FOUND" });
      }
      const result = await db.pool.query(
        `
        select id,space_id,vault_id,external_id,path,title,current_revision,body_cache body,frontmatter,aliases
          from knowledge_documents
         where space_id=any($2::uuid[])
           and vault_id=any($3::uuid[])
           and (layer='context-pack' or type='context-pack')
           and (id::text=$1 or external_id=$1 or lower(title)=lower($1)
                or exists(select 1 from unnest(aliases) a where lower(a)=lower($1)))
         order by updated_at desc limit 1
        `,
        [request.params.id, scope.spaces, scope.vaultIds],
      );
      const accessible = result.rows.filter((row) =>
        readableDocument(actor, row, "knowledge:read"),
      );
      if (!accessible.length)
        return reply.code(404).send({ code: "CONTEXT_PACK_NOT_FOUND" });
      return accessible[0];
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/documents/:id",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const actor = actorOf(request);
      const scope = await authorizedVaultIds(
        db,
        actor,
        "knowledge:read",
        false,
      );
      const result = await db.pool.query(
        `
        select id, space_id, vault_id, external_id, path, title, type, lifecycle, trust_tier, layer,
               current_revision, body_cache body, frontmatter, aliases, content_hash,
               token_estimate, updated_at
          from knowledge_documents
         where (id::text = $1 or external_id = $1)
           and space_id=any($2::uuid[]) and vault_id=any($3::uuid[])
         order by updated_at desc
         limit 2
        `,
        [request.params.id, scope.spaces, scope.vaultIds],
      );
      const accessible = result.rows.filter((row) =>
        readableDocument(actor, row, "knowledge:read"),
      );
      if (!accessible.length)
        return reply.code(404).send({ code: "DOCUMENT_NOT_FOUND" });
      if (accessible.length > 1) {
        return reply.code(409).send({
          code: "AMBIGUOUS_EXTERNAL_ID",
          candidates: accessible.map((row) => ({
            id: row.id,
            path: row.path,
          })),
        });
      }
      const document = accessible[0];
      const relations = await db.pool.query(
        `
        select r.relation_type, r.provenance,
               case when r.from_document_id = $1 then 'outgoing' else 'incoming' end direction,
               other.id, other.external_id, other.path, other.title, other.type
         from knowledge_relations r
          join knowledge_documents other
            on other.id = case when r.from_document_id = $1 then r.to_document_id else r.from_document_id end
         where (r.from_document_id = $1 or r.to_document_id = $1)
           and r.space_id=$2 and other.space_id=$2
           and other.vault_id=$3
         order by r.relation_type, other.path
        `,
        [document.id, document.space_id, document.vault_id],
      );
      return {
        ...document,
        relations: relations.rows.filter((row) =>
          hasPathAccess(
            actor,
            String(document.space_id),
            "knowledge:read",
            String(row.path),
          ),
        ),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/documents/:id/evidence",
    { preHandler: requirePermission("source:read") },
    async (request, reply) => {
      const actor = actorOf(request);
      const scope = await authorizedVaultIds(db, actor, "source:read", true);
      const document = await db.pool.query(
        "select id, space_id, vault_id, external_id, path from knowledge_documents where (id::text = $1 or external_id = $1) and space_id=any($2::uuid[]) and vault_id=any($3::uuid[]) limit 2",
        [request.params.id, scope.spaces, scope.vaultIds],
      );
      const accessible = document.rows.filter((row) =>
        readableDocument(actor, row, "source:read"),
      );
      if (!accessible.length)
        return reply.code(404).send({ code: "DOCUMENT_NOT_FOUND" });
      if (
        !hasUnrestrictedPathAccess(
          actor,
          String(accessible[0].space_id),
          "source:read",
        )
      ) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const result = await db.pool.query(
        `
        select r.relation_type, r.provenance, d.id, d.external_id, d.path, d.title,
               d.type, d.trust_tier, d.current_revision
          from knowledge_relations r
          join knowledge_documents d on d.id = r.to_document_id
         where r.from_document_id = $1
           and r.space_id=$2 and d.space_id=$2 and d.vault_id=$3
           and (d.layer in ('source','resource') or d.type like '%evidence%')
         order by d.path
        `,
        [accessible[0].id, accessible[0].space_id, accessible[0].vault_id],
      );
      const locators = await db.pool.query(
        `
        select e.id,e.locator,e.content_hash,e.excerpt,e.review_status,
               s.id source_id,s.title source_title,s.sha256 source_sha256
          from document_evidence de
          join evidence e on e.id=de.evidence_id
          join sources s on s.id=e.source_id
         where de.document_id=$1
           and e.vault_id=$2 and s.vault_id=$2
         order by e.created_at
        `,
        [accessible[0].id, accessible[0].vault_id],
      );
      return {
        document: accessible[0],
        evidence: result.rows.filter((row) =>
          hasPathAccess(
            actor,
            String(accessible[0].space_id),
            "source:read",
            String(row.path),
          ),
        ),
        locators: locators.rows,
        gaps:
          result.rowCount === 0 && locators.rowCount === 0
            ? [
                "No explicit source/evidence relation is indexed for this document.",
              ]
            : [],
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { depth?: string } }>(
    "/v1/impact/:id",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const actor = actorOf(request);
      const scope = await authorizedVaultIds(
        db,
        actor,
        "knowledge:read",
        false,
      );
      const depth = Math.max(1, Math.min(Number(request.query.depth ?? 2), 5));
      const seed = await db.pool.query(
        "select id, space_id, vault_id, external_id, path, title from knowledge_documents where (id::text = $1 or external_id = $1) and space_id=any($2::uuid[]) and vault_id=any($3::uuid[]) limit 1",
        [request.params.id, scope.spaces, scope.vaultIds],
      );
      const accessibleSeeds = seed.rows.filter((row) =>
        readableDocument(actor, row, "knowledge:read"),
      );
      if (!accessibleSeeds.length)
        return reply.code(404).send({ code: "DOCUMENT_NOT_FOUND" });
      const result = await db.pool.query(
        `
        with recursive impact(depth, from_id, to_id, relation_type, trail) as (
          select 1, r.from_document_id, r.to_document_id, r.relation_type,
                 array[r.from_document_id, r.to_document_id]
            from knowledge_relations r
           where (r.from_document_id = $1 or r.to_document_id = $1)
             and r.space_id=$3
          union all
          select i.depth + 1, r.from_document_id, r.to_document_id, r.relation_type,
                 i.trail || r.to_document_id
            from impact i
            join knowledge_relations r on r.from_document_id = i.to_id
           where r.space_id=$3 and i.depth < $2 and not r.to_document_id = any(i.trail)
        )
        select distinct i.depth, i.relation_type, d.id, d.external_id, d.path, d.title, d.type
          from impact i
          join knowledge_documents d on d.id = i.to_id
         where d.space_id=$3 and d.vault_id=$4
         order by i.depth, d.path
        `,
        [
          accessibleSeeds[0].id,
          depth,
          accessibleSeeds[0].space_id,
          accessibleSeeds[0].vault_id,
        ],
      );
      return {
        seed: accessibleSeeds[0],
        depth,
        impacted: result.rows.filter((row) =>
          hasPathAccess(
            actor,
            String(accessibleSeeds[0].space_id),
            "knowledge:read",
            String(row.path),
          ),
        ),
      };
    },
  );

  app.get(
    "/v1/vaults",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const scope = await authorizedVaultIds(
        db,
        actorOf(request),
        "knowledge:read",
        true,
      );
      if (!scope.spaces.length)
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      const result = await db.pool.query(
        `
        select v.id, v.space_id, v.vault_key, v.name, v.visibility,
               v.git_repository, v.default_branch,
               v.local_path, v.content_roots, v.source_roots, v.schema_profile,
               v.eval_pack, v.retrieval_config, v.permissions, v.enabled,
               v.read_only, v.current_revision, v.last_imported_at,
               r.status import_status, r.metrics
          from vaults v
          left join lateral (
            select status, metrics from vault_import_runs
             where vault_id = v.id order by started_at desc limit 1
          ) r on true
         where v.space_id=any($1::uuid[]) and v.id=any($2::uuid[])
         order by v.created_at
        `,
        [scope.spaces, scope.vaultIds],
      );
      return { vaults: result.rows };
    },
  );

  app.post(
    "/v1/vaults",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      const parsed = VaultRegistration.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_VAULT_REGISTRATION",
          issues: parsed.error.issues,
        });
      }
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      if (!hasUnrestrictedPathAccess(actor, parsed.data.spaceId, "admin")) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const registration = {
        ...parsed.data,
        localPath: path.resolve(parsed.data.localPath),
      };
      try {
        const vault = await registerVault(db, registration, {
          ownerUserId: actor.id,
        });
        await audit(
          db,
          request,
          "vault.register",
          "vault",
          vault.id,
          { vaultKey: vault.vault_key },
          vault.space_id,
        );
        return reply.code(201).send({ vault });
      } catch (error) {
        if ((error as Error).message === "VAULT_KEY_OWNED_BY_DIFFERENT_SPACE") {
          return reply.code(409).send({ code: "VAULT_KEY_CONFLICT" });
        }
        throw error;
      }
    },
  );

  app.get(
    "/v1/graph/summary",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const scope = await authorizedVaultIds(
        db,
        actorOf(request),
        "knowledge:read",
        true,
      );
      if (!scope.spaces.length) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const result = await db.pool.query(
        `
        select r.relation_type, count(*)::int edges
          from knowledge_relations r
          join knowledge_documents d on d.id=r.from_document_id
         where r.space_id=any($1::uuid[]) and d.vault_id=any($2::uuid[])
         group by r.relation_type order by edges desc
        `,
        [scope.spaces, scope.vaultIds],
      );
      const orphans = await db.pool.query(
        `
        select count(*)::int count from knowledge_documents d
         where d.space_id=any($1::uuid[]) and d.vault_id=any($2::uuid[])
           and not exists (
           select 1 from knowledge_relations r
            where r.from_document_id = d.id or r.to_document_id = d.id
         )
        `,
        [scope.spaces, scope.vaultIds],
      );
      return {
        byRelationType: result.rows,
        orphanDocuments: orphans.rows[0]?.count ?? 0,
      };
    },
  );

  app.get(
    "/v1/sources",
    { preHandler: requirePermission("source:read") },
    async (request, reply) => {
      const scope = await authorizedVaultIds(
        db,
        actorOf(request),
        "source:read",
        true,
      );
      if (!scope.spaces.length) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const result = await db.pool.query(
        `
        select id,space_id,vault_id,title,source_uri,media_type,sha256,byte_size,status,metadata,created_at
          from sources where space_id=any($1::uuid[]) and vault_id=any($2::uuid[])
         order by created_at desc limit 100
        `,
        [scope.spaces, scope.vaultIds],
      );
      return { sources: result.rows };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/sources/:id",
    { preHandler: requirePermission("source:read") },
    async (request, reply) => {
      const scope = await authorizedVaultIds(
        db,
        actorOf(request),
        "source:read",
        true,
      );
      if (!scope.spaces.length) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const source = await db.pool.query(
        "select * from sources where id=$1 and space_id=any($2::uuid[]) and vault_id=any($3::uuid[])",
        [request.params.id, scope.spaces, scope.vaultIds],
      );
      if (!source.rowCount)
        return reply.code(404).send({ code: "SOURCE_NOT_FOUND" });
      const artifacts = await db.pool.query(
        "select id,kind,source_hash,extractor,extractor_version,quality,metadata,created_at from source_artifacts where source_id=$1",
        [request.params.id],
      );
      const evidence = await db.pool.query(
        "select id,locator,content_hash,excerpt,review_status,created_at from evidence where source_id=$1",
        [request.params.id],
      );
      return {
        ...source.rows[0],
        artifacts: artifacts.rows,
        evidence: evidence.rows,
      };
    },
  );
}
