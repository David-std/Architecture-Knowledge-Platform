import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { Postgres } from "@akp/postgres";
import {
  DeterministicEmbeddingAdapter,
  parseKnowledgeUnits,
  toPgVector,
} from "@akp/retrieval";
import { parseWikiLinks } from "@akp/vault-importer";
import {
  GitKnowledgeFileNotFoundError,
  type GitKnowledgeStore,
} from "@akp/git-store";

export interface ManagedChange {
  path: string;
  operation?: "CREATE" | "UPDATE";
}

interface IndexedDocument {
  id: string;
  path: string;
  external_id: string;
  title: string;
  lifecycle: string;
  trust_tier: string;
  body_cache: string;
  content_hash: string;
}

interface LinkableDocument {
  id: string;
  path: string;
  external_id: string;
  aliases: string[];
  raw_links: string[];
  frontmatter: Record<string, unknown>;
}

const typedRelationFields: Readonly<Record<string, string>> = {
  supports: "supports",
  contradicts: "contradicts",
  requires: "requires",
  implements: "implements",
  example_of: "example_of",
  counterexample_of: "counterexample_of",
  validated_by: "validated_by",
  produces: "produces",
  consumed_by: "consumed_by",
  supersedes: "supersedes",
  derives_from: "derives_from",
  derived_from: "derives_from",
  source: "derives_from",
  sources: "derives_from",
  evidence: "derives_from",
  claim: "requires",
  claims: "requires",
  rule: "requires",
  rules: "requires",
  context_pack: "requires",
};

function asStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizedTarget(value: string): string {
  return (
    value
      .trim()
      .replace(/^!?\[\[/, "")
      .replace(/\]\]$/, "")
      .split(/[|#]/)[0]
      ?.trim()
      .replace(/\\/g, "/")
      .replace(/\.md$/i, "") ?? ""
  );
}

function normalizedDocumentPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase();
}

function stableManagedId(relativePath: string): string {
  return `GEN-${createHash("sha256")
    .update(relativePath)
    .digest("hex")
    .slice(0, 12)}`;
}

export function repositoryPublicationKey(repositoryPath: string): string {
  const resolved = canonicalLocalPath(repositoryPath);
  return createHash("sha256").update(resolved).digest("hex");
}

function canonicalLocalPath(candidate: string): string {
  let resolved: string;
  try {
    resolved = realpathSync.native(candidate);
  } catch {
    resolved = path.resolve(candidate);
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathsOverlap(left: string, right: string): boolean {
  const relativeLeft = path.relative(left, right);
  const relativeRight = path.relative(right, left);
  return (
    relativeLeft === "" ||
    relativeRight === "" ||
    (!relativeLeft.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeLeft)) ||
    (!relativeRight.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeRight))
  );
}

/** The managed publication repository must be separate from the read-only
 * canonical vault. Resolve existing symlinks before checking so aliases cannot
 * silently turn a Git publication into a vault write. */
export function assertManagedRepositoryBoundary(
  repositoryPath: string,
  vaultPath = process.env.AKP_VAULT_PATH,
): void {
  if (!vaultPath) return;
  const repository = canonicalLocalPath(repositoryPath);
  const vault = canonicalLocalPath(vaultPath);
  if (pathsOverlap(repository, vault)) {
    throw new Error(
      "MANAGED_REPOSITORY_OVERLAPS_READ_ONLY_VAULT: configure AKP_MANAGED_REPO outside AKP_VAULT_PATH.",
    );
  }
}

export async function compositeRevision(
  db: Postgres,
  spaceId: string,
  managedRevision?: string | null,
): Promise<string> {
  const vault = await db.pool.query<{ current_revision: string }>(
    `
    select current_revision from vaults where space_id=$1
     order by last_imported_at desc nulls last limit 1
    `,
    [spaceId],
  );
  const managed = managedRevision
    ? { current_revision: managedRevision }
    : (
        await db.pool.query<{ current_revision: string }>(
          `
          select current_revision from knowledge_documents
           where space_id=$1 and path like 'managed/%'
             and lifecycle not in ('DELETED_TOMBSTONE','SUPERSEDED','INVALID')
           order by updated_at desc limit 1
          `,
          [spaceId],
        )
      ).rows[0];
  const vaultRevision = vault.rows[0]?.current_revision ?? "no-vault";
  return managed?.current_revision
    ? `composite:${vaultRevision}+managed:${managed.current_revision}`
    : vaultRevision;
}

/**
 * Rebuilds every derived retrieval projection for one space from the current
 * document representation.  It intentionally does not change source content
 * or source revisions; importing a vault and Git reconciliation are separate
 * canonical-content operations.
 */
export async function rebuildSpaceProjections(
  db: Postgres,
  spaceId: string,
  managedRevision?: string | null,
): Promise<{
  corpusRevision: string;
  unitCount: number;
  documentCount: number;
}> {
  const corpusRevision = await compositeRevision(db, spaceId, managedRevision);
  const documents = await db.pool.query<IndexedDocument>(
    `
    select id,path,external_id,title,lifecycle,trust_tier,body_cache,content_hash
      from knowledge_documents
     where space_id=$1
       and lifecycle not in ('ARCHIVED','DELETED_TOMBSTONE','SUPERSEDED','INVALID')
     order by path
    `,
    [spaceId],
  );
  const adapter = new DeterministicEmbeddingAdapter();
  const client = await db.pool.connect();
  let unitCount = 0;
  try {
    await client.query("begin");
    const generation = await client.query<{ id: string }>(
      `
      insert into embedding_generations(
        space_id,provider,model,model_revision,dimensions,normalization,
        configuration_version,corpus_revision,status,activated_at
      ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,
               case when $9='ACTIVE' then now() else null end)
      on conflict(
        space_id,provider,model,model_revision,configuration_version,corpus_revision
      ) do update set status=excluded.status,activated_at=excluded.activated_at
      returning id
      `,
      [
        spaceId,
        adapter.descriptor.provider,
        adapter.descriptor.model,
        adapter.descriptor.modelRevision,
        adapter.descriptor.dimensions,
        adapter.descriptor.normalization,
        adapter.descriptor.configurationVersion,
        corpusRevision,
        process.env.AKP_VECTOR_ENABLED === "true" ? "ACTIVE" : "READY",
      ],
    );
    const generationId = generation.rows[0]?.id;
    if (!generationId)
      throw new Error("Could not create embedding generation.");

    await client.query("delete from knowledge_units where space_id=$1", [
      spaceId,
    ]);
    for (const document of documents.rows) {
      const units = parseKnowledgeUnits(document.title, document.body_cache);
      const embeddings = await adapter.embed(units.map((unit) => unit.body));
      for (let index = 0; index < units.length; index += 1) {
        const unit = units[index];
        const embedding = embeddings[index];
        if (!unit || !embedding) continue;
        const inserted = await client.query<{ id: string }>(
          `
          insert into knowledge_units(
            document_id,space_id,unit_key,unit_type,heading_path,body,content_hash,
            corpus_revision,lifecycle,trust_tier,source_ids,token_estimate
          ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}',$11)
          returning id
          `,
          [
            document.id,
            spaceId,
            unit.unitKey,
            unit.unitType,
            unit.headingPath,
            unit.body,
            unit.contentHash,
            corpusRevision,
            document.lifecycle,
            document.trust_tier,
            unit.tokenEstimate,
          ],
        );
        await client.query(
          `
          insert into unit_embeddings(unit_id,generation_id,content_hash,embedding)
          values($1,$2,$3,$4::vector)
          `,
          [
            inserted.rows[0]?.id,
            generationId,
            unit.contentHash,
            toPgVector(embedding),
          ],
        );
        unitCount += 1;
      }
    }
    await client.query("delete from context_packets where space_id=$1", [
      spaceId,
    ]);
    await client.query(
      `
      insert into index_revisions(
        space_id,corpus_revision,lexical_revision,vector_revision,graph_revision,
        context_pack_revision,status,warnings
      ) values($1,$2,$2,$3,$2,$2,$4,$5::jsonb)
      on conflict(space_id) do update set
        corpus_revision=excluded.corpus_revision,
        lexical_revision=excluded.lexical_revision,
        vector_revision=excluded.vector_revision,
        graph_revision=excluded.graph_revision,
        context_pack_revision=excluded.context_pack_revision,
        status=excluded.status,
        warnings=excluded.warnings,
        updated_at=now()
      `,
      [
        spaceId,
        corpusRevision,
        process.env.AKP_VECTOR_ENABLED === "true" ? corpusRevision : null,
        process.env.AKP_VECTOR_ENABLED === "true" ? "CONSISTENT" : "DEGRADED",
        JSON.stringify(
          process.env.AKP_VECTOR_ENABLED === "true"
            ? []
            : ["VECTOR_DISABLED_PENDING_BENCHMARK"],
        ),
      ],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return {
    corpusRevision,
    unitCount,
    documentCount: documents.rowCount ?? documents.rows.length,
  };
}

function candidateKeys(sourcePath: string, target: string): string[] {
  const normalized = normalizedTarget(target);
  if (!normalized) return [];
  const sourceDirectory = path.posix.dirname(
    sourcePath.replace(/^managed\//, ""),
  );
  const relative = path.posix.normalize(
    path.posix.join(sourceDirectory, normalized),
  );
  return [
    ...new Set([
      normalized,
      relative,
      `managed/${normalized}`,
      `managed/${relative}`,
    ]),
  ].map(normalizedDocumentPath);
}

function resolveTarget(
  sourcePath: string,
  target: string,
  byKey: ReadonlyMap<string, LinkableDocument[]>,
): LinkableDocument | null {
  for (const key of candidateKeys(sourcePath, target)) {
    const matches = byKey.get(key) ?? [];
    if (matches.length === 1) return matches[0] ?? null;
  }
  return null;
}

/** Recreates managed-document edges from canonical Git Markdown/frontmatter. */
export async function rebuildManagedRelations(
  db: Postgres,
  spaceId: string,
): Promise<number> {
  const result = await db.pool.query<LinkableDocument>(
    `
    select id,path,external_id,aliases,raw_links,frontmatter
      from knowledge_documents
     where space_id=$1 and lifecycle not in ('DELETED_TOMBSTONE','SUPERSEDED','INVALID')
    `,
    [spaceId],
  );
  const byKey = new Map<string, LinkableDocument[]>();
  const put = (key: string, document: LinkableDocument): void => {
    const normalized = normalizedDocumentPath(key);
    if (!normalized) return;
    byKey.set(normalized, [...(byKey.get(normalized) ?? []), document]);
  };
  for (const document of result.rows) {
    put(document.path, document);
    put(document.external_id, document);
    put(path.posix.basename(normalizedDocumentPath(document.path)), document);
    for (const alias of document.aliases ?? []) put(alias, document);
  }
  const managedRows = await db.pool.query<{ id: string }>(
    "select id from knowledge_documents where space_id=$1 and path like 'managed/%'",
    [spaceId],
  );
  const managedIds = managedRows.rows.map((document) => document.id);
  if (!managedIds.length) return 0;
  const client = await db.pool.connect();
  let count = 0;
  try {
    await client.query("begin");
    await client.query(
      `delete from knowledge_relations
        where space_id=$1 and provenance='managed-markdown'
          and from_document_id=any($2::uuid[])`,
      [spaceId, managedIds],
    );
    for (const document of result.rows.filter((row) =>
      row.path.startsWith("managed/"),
    )) {
      const edges: Array<{ target: string; relationType: string }> = [];
      for (const link of document.raw_links ?? []) {
        edges.push({ target: link, relationType: "related_to" });
      }
      for (const [field, relationType] of Object.entries(typedRelationFields)) {
        for (const target of asStrings(document.frontmatter?.[field])) {
          edges.push({ target, relationType });
        }
      }
      const seen = new Set<string>();
      for (const edge of edges) {
        const target = resolveTarget(document.path, edge.target, byKey);
        if (!target || target.id === document.id) continue;
        const key = `${target.id}:${edge.relationType}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await client.query(
          `
          insert into knowledge_relations(
            space_id,from_document_id,to_document_id,relation_type,provenance,metadata
          ) values($1,$2,$3,$4,'managed-markdown',$5::jsonb)
          on conflict do nothing
          `,
          [
            spaceId,
            document.id,
            target.id,
            edge.relationType,
            JSON.stringify({ target: normalizedTarget(edge.target) }),
          ],
        );
        count += 1;
      }
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return count;
}

/**
 * Reconciles changed managed paths with a specific Git revision.  Missing
 * paths become tombstones; restored paths are parsed again from that revision.
 */
export async function synchronizeManagedPaths(
  db: Postgres,
  store: GitKnowledgeStore,
  options: {
    spaceId: string;
    revision: string;
    changes: readonly ManagedChange[];
    sourceId?: string;
  },
): Promise<{ indexedPaths: string[]; tombstonedPaths: string[] }> {
  const indexedPaths: string[] = [];
  const tombstonedPaths: string[] = [];
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    for (const change of options.changes) {
      const managedPath = `managed/${change.path.replaceAll("\\", "/")}`;
      let raw: string;
      try {
        raw = await store.showFile(options.revision, change.path);
      } catch (error) {
        if (!(error instanceof GitKnowledgeFileNotFoundError)) {
          throw error;
        }
        const tombstoned = await client.query<{ id: string }>(
          `
        update knowledge_documents
           set lifecycle='DELETED_TOMBSTONE',refresh_status='INVALID',
               stale_reason='Path absent from canonical managed Git revision',
               current_revision=$3,body_cache='',updated_at=now()
         where space_id=$1 and path=$2
        returning id
        `,
          [options.spaceId, managedPath, options.revision],
        );
        const documentId = tombstoned.rows[0]?.id;
        if (documentId) {
          await client.query(
            `
          with recursive downstream(id,trail) as (
            select r.from_document_id,array[$1::uuid,r.from_document_id]
              from knowledge_relations r where r.to_document_id=$1 and r.space_id=$2
            union all
            select r.from_document_id,d.trail||r.from_document_id
              from downstream d join knowledge_relations r on r.to_document_id=d.id
             where r.space_id=$2 and not r.from_document_id=any(d.trail)
          )
          update knowledge_documents k
             set refresh_status='STALE_PENDING_REVIEW',invalidated_by=$1,
                 stale_reason='Dependency removed from managed Git revision',updated_at=now()
            from downstream d where k.id=d.id and k.space_id=$2
          `,
            [documentId, options.spaceId],
          );
        }
        tombstonedPaths.push(managedPath);
        continue;
      }
      const parsed = matter(raw);
      const data = parsed.data as Record<string, unknown>;
      const externalId = String(data.id ?? stableManagedId(change.path));
      const contentHash = createHash("sha256").update(raw).digest("hex");
      const indexed = await client.query<{ id: string }>(
        `
      insert into knowledge_documents(
        space_id,path,external_id,title,type,lifecycle,trust_tier,current_revision,
        body_cache,frontmatter,aliases,layer,content_hash,token_estimate,raw_links
      ) values($1,$2,$3,$4,$5,'ACTIVE','HUMAN_REVIEWED',$6,$7,$8::jsonb,$9,$10,$11,$12,$13::jsonb)
      on conflict(space_id,path) do update set
        external_id=excluded.external_id,title=excluded.title,type=excluded.type,
        lifecycle=excluded.lifecycle,trust_tier=excluded.trust_tier,
        current_revision=excluded.current_revision,body_cache=excluded.body_cache,
        frontmatter=excluded.frontmatter,aliases=excluded.aliases,layer=excluded.layer,
        content_hash=excluded.content_hash,token_estimate=excluded.token_estimate,
        raw_links=excluded.raw_links,refresh_status='CURRENT',
        invalidated_by=null,stale_reason=null,updated_at=now()
      returning id
      `,
        [
          options.spaceId,
          managedPath,
          externalId,
          String(data.title ?? path.posix.basename(change.path, ".md")),
          String(data.type ?? "source-summary"),
          options.revision,
          parsed.content,
          JSON.stringify(data),
          Array.isArray(data.aliases) ? data.aliases.map(String) : [],
          String(data.knowledge_layer ?? "source"),
          contentHash,
          Math.ceil(raw.length / 4),
          JSON.stringify(parseWikiLinks(parsed.content)),
        ],
      );
      const documentId = indexed.rows[0]?.id;
      if (!documentId) throw new Error(`Could not index ${change.path}.`);
      if (change.operation === "UPDATE") {
        await client.query(
          `
        with recursive downstream(id,trail) as (
          select r.from_document_id,array[$1::uuid,r.from_document_id]
            from knowledge_relations r where r.to_document_id=$1 and r.space_id=$2
          union all
          select r.from_document_id,d.trail||r.from_document_id
            from downstream d join knowledge_relations r on r.to_document_id=d.id
           where r.space_id=$2 and not r.from_document_id=any(d.trail)
        )
        update knowledge_documents k
           set refresh_status='STALE_PENDING_REVIEW',invalidated_by=$1,
               stale_reason='Dependency changed in approved review',updated_at=now()
          from downstream d where k.id=d.id and k.space_id=$2
        `,
          [documentId, options.spaceId],
        );
      }
      await client.query(
        `
      insert into knowledge_versions(document_id,git_commit,content_hash,body,frontmatter)
      values($1,$2,$3,$4,$5::jsonb)
      on conflict(document_id,git_commit) do nothing
      `,
        [
          documentId,
          options.revision,
          contentHash,
          parsed.content,
          JSON.stringify(data),
        ],
      );
      if (options.sourceId) {
        await client.query(
          `
        insert into document_evidence(document_id,evidence_id)
        select $1,e.id from evidence e where e.source_id=$2 and e.space_id=$3
        on conflict do nothing
        `,
          [documentId, options.sourceId, options.spaceId],
        );
      }
      indexedPaths.push(managedPath);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  await rebuildManagedRelations(db, options.spaceId);
  return { indexedPaths, tombstonedPaths };
}
