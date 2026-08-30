import { createHash } from "node:crypto";
import path from "node:path";
import matter from "gray-matter";
import type { Postgres } from "@akp/postgres";
import {
  GitKnowledgeFileNotFoundError,
  type GitKnowledgeStore,
} from "@akp/git-store";
import { parseWikiLinks } from "@akp/vault-importer";
import {
  DeterministicEmbeddingAdapter,
  parseKnowledgeUnits,
  toPgVector,
} from "@akp/retrieval";

export interface ManagedChange {
  path: string;
  operation?: "CREATE" | "UPDATE";
}

export interface SynchronizeManagedPathsOptions {
  spaceId: string;
  vaultId: string;
  revision: string;
  changes: readonly ManagedChange[];
  sourceId?: string;
  /** Source outbox event used to deduplicate and reconcile this run. */
  eventId?: string;
}

export interface SynchronizeManagedPathsResult {
  indexedPaths: string[];
  tombstonedPaths: string[];
}

export interface IncrementalIndexResult extends SynchronizeManagedPathsResult {
  relationCount: number;
  corpusRevision: string;
  documentsRebuilt: number;
  unitsRebuilt: number;
  embeddingsReused: number;
  embeddingsCreated: number;
}

interface LinkableDocument {
  id: string;
  vault_id: string;
  path: string;
  external_id: string;
  aliases: string[];
  raw_links: string[];
  frontmatter: Record<string, unknown>;
}

interface IncrementalProjectionStats {
  documentsRebuilt: number;
  unitsRebuilt: number;
  embeddingsReused: number;
  embeddingsCreated: number;
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

function assertVaultScope(vaultId: string): void {
  if (!vaultId.trim()) throw new Error("VAULT_SCOPE_REQUIRED");
}

/**
 * Publication paths are untrusted event data.  GitKnowledgeStore normalizes
 * paths for Git itself, so validating only after handing it a path would let
 * `managed/../README.md` resolve to a repository-root file.  Reject traversal
 * segments before the managed prefix is constructed and require the same
 * Markdown-only contract used by the proposal API.
 */
export function normalizeManagedPath(input: string): string {
  if (typeof input !== "string") throw new Error("UNSAFE_MANAGED_PATH");
  const normalized = input.replaceAll("\\", "/");
  const relative = normalized.replace(/^managed\//i, "");
  const segments = relative.split("/");
  if (
    !relative ||
    relative.startsWith("/") ||
    /^[A-Za-z]:/.test(relative) ||
    relative.includes("\0") ||
    segments.some(
      (segment) => !segment || segment === "." || segment === "..",
    ) ||
    !relative.toLowerCase().endsWith(".md")
  ) {
    throw new Error("UNSAFE_MANAGED_PATH");
  }
  return `managed/${relative}`;
}

/**
 * Managed repositories created by the proposal routes historically stored
 * portable proposal paths at repository root, while imported vaults and
 * newer callers use the explicit `managed/` directory. Keep the database
 * projection canonical (`managed/...`) but read either physical layout so an
 * approved revision remains indexable during that migration.
 */
async function readManagedFile(
  store: GitKnowledgeStore,
  revision: string,
  managedPath: string,
): Promise<string | null> {
  try {
    return await store.showFile(revision, managedPath);
  } catch (error) {
    if (!(error instanceof GitKnowledgeFileNotFoundError)) throw error;
    const rootPath = managedPath.slice("managed/".length);
    try {
      return await store.showFile(revision, rootPath);
    } catch (fallbackError) {
      if (!(fallbackError instanceof GitKnowledgeFileNotFoundError))
        throw fallbackError;
      return null;
    }
  }
}

function stableManagedId(relativePath: string): string {
  return `GEN-${createHash("sha256")
    .update(relativePath)
    .digest("hex")
    .slice(0, 12)}`;
}

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
      .replace(/\\/g, "/") ?? ""
  );
}

function normalizedDocumentPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase();
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

/**
 * Applies managed Git changes to one vault only.  The operation deliberately
 * does not rebuild the full projection: callers can acknowledge the durable
 * event after this idempotent document/version update and schedule a scoped
 * projection repair separately.
 */
async function synchronizeManagedPathsCore(
  db: Postgres,
  store: GitKnowledgeStore,
  options: SynchronizeManagedPathsOptions,
): Promise<SynchronizeManagedPathsResult> {
  assertVaultScope(options.vaultId);
  const indexedPaths: string[] = [];
  const tombstonedPaths: string[] = [];
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    for (const change of options.changes) {
      const managedPath = normalizeManagedPath(change.path);
      const raw = await readManagedFile(store, options.revision, managedPath);
      if (raw === null) {
        const tombstoned = await client.query<{ id: string }>(
          `
        update knowledge_documents
           set lifecycle='DELETED_TOMBSTONE',refresh_status='INVALID',
               stale_reason='Path absent from canonical managed Git revision',
               current_revision=$4,body_cache='',updated_at=now()
         where space_id=$1 and vault_id=$2 and path=$3
        returning id
        `,
          [options.spaceId, options.vaultId, managedPath, options.revision],
        );
        const documentId = tombstoned.rows[0]?.id;
        if (documentId) {
          await client.query(
            `
          with recursive downstream(id,trail) as (
            select r.from_document_id,array[$1::uuid,r.from_document_id]
              from knowledge_relations r
              join knowledge_documents f on f.id=r.from_document_id
              join knowledge_documents t on t.id=r.to_document_id
             where r.to_document_id=$1 and r.space_id=$2
               and f.vault_id=$3 and t.vault_id=$3
            union all
            select r.from_document_id,d.trail||r.from_document_id
              from downstream d
              join knowledge_relations r on r.to_document_id=d.id
              join knowledge_documents f on f.id=r.from_document_id
             where r.space_id=$2 and f.vault_id=$3
               and not r.from_document_id=any(d.trail)
          )
          update knowledge_documents k
             set refresh_status='STALE_PENDING_REVIEW',invalidated_by=$1,
                 stale_reason='Dependency removed from managed Git revision',updated_at=now()
            from downstream d where k.id=d.id and k.space_id=$2 and k.vault_id=$3
          `,
            [documentId, options.spaceId, options.vaultId],
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
        space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,current_revision,
        body_cache,frontmatter,aliases,layer,content_hash,token_estimate,raw_links
      ) values($1,$2,$3,$4,$5,$6,'ACTIVE','HUMAN_REVIEWED',$7,$8,$9::jsonb,$10,$11,$12,$13,$14::jsonb)
      on conflict(vault_id,path) where vault_id is not null do update set
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
          options.vaultId,
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
            from knowledge_relations r
            join knowledge_documents f on f.id=r.from_document_id
            join knowledge_documents t on t.id=r.to_document_id
           where r.to_document_id=$1 and r.space_id=$2
             and f.vault_id=$3 and t.vault_id=$3
          union all
          select r.from_document_id,d.trail||r.from_document_id
            from downstream d
            join knowledge_relations r on r.to_document_id=d.id
            join knowledge_documents f on f.id=r.from_document_id
           where r.space_id=$2 and f.vault_id=$3
             and not r.from_document_id=any(d.trail)
        )
        update knowledge_documents k
           set refresh_status='STALE_PENDING_REVIEW',invalidated_by=$1,
               stale_reason='Dependency changed in approved review',updated_at=now()
          from downstream d where k.id=d.id and k.space_id=$2 and k.vault_id=$3
        `,
          [documentId, options.spaceId, options.vaultId],
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
        select $1,e.id from evidence e
         where e.source_id=$2 and e.space_id=$3 and e.vault_id=$4
        on conflict do nothing
        `,
          [documentId, options.sourceId, options.spaceId, options.vaultId],
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
  return { indexedPaths, tombstonedPaths };
}

interface ChangedDocument {
  id: string;
  title: string;
  body_cache: string;
  lifecycle: string;
  trust_tier: string;
  permissions: Record<string, unknown>;
  frontmatter?: Record<string, unknown>;
}

interface CachedEmbedding {
  content_hash: string;
  embedding: string;
}

/**
 * Rebuild only the structural units owned by documents touched by an
 * incremental event.  A document's old units are removed by document id and
 * recreated from the same parser used by the repair-only full rebuild.  Vector
 * rows are reused by content hash whenever a prior generation contains the
 * same atomic unit, so an unchanged paragraph in an edited document does not
 * get a second embedding request.  All reads/deletes/inserts are constrained
 * by both space and vault to prevent same-path cross-vault leakage.
 */
async function rebuildChangedUnits(
  db: Postgres,
  options: SynchronizeManagedPathsOptions,
  result: SynchronizeManagedPathsResult,
  corpusRevision: string,
): Promise<IncrementalProjectionStats> {
  const changedPaths = [
    ...new Set([...result.indexedPaths, ...result.tombstonedPaths]),
  ];
  if (changedPaths.length === 0) {
    return {
      documentsRebuilt: 0,
      unitsRebuilt: 0,
      embeddingsReused: 0,
      embeddingsCreated: 0,
    };
  }

  const documents = await db.pool.query<ChangedDocument>(
    `
    select id,title,body_cache,lifecycle,trust_tier,frontmatter,
           coalesce(frontmatter->'permissions','{}'::jsonb) permissions
      from knowledge_documents
     where space_id=$1 and vault_id=$2 and path = any($3::text[])
    `,
    [options.spaceId, options.vaultId, changedPaths],
  );
  const activeDocuments = documents.rows.filter(
    (document) =>
      !["ARCHIVED", "DELETED_TOMBSTONE", "SUPERSEDED", "INVALID"].includes(
        document.lifecycle,
      ),
  );

  // A delete/tombstone can be the only change in an event.  There is no
  // document left to parse or embed in that case, so creating an embedding
  // generation would leave an empty vector generation behind (and make a
  // tombstone look like a successful vector rebuild).  Context packets still
  // need invalidation; the dedicated ContextPackInvalidationRequested event
  // performs the same operation for normal publication fan-out, while this
  // local invalidation also covers repair/compensation callers that do not
  // emit the fan-out event.
  if (activeDocuments.length === 0) {
    await db.pool.query(
      `delete from context_packets where space_id=$1 and vault_id=$2`,
      [options.spaceId, options.vaultId],
    );
    return {
      documentsRebuilt: documents.rows.length,
      unitsRebuilt: 0,
      embeddingsReused: 0,
      embeddingsCreated: 0,
    };
  }

  const parsed = activeDocuments.map((document) => ({
    document,
    units: parseKnowledgeUnits(document.title, document.body_cache),
  }));
  const contentHashes = [
    ...new Set(
      parsed.flatMap(({ units }) =>
        units
          .filter((unit) => unit.embeddingEligible)
          .map((unit) => unit.contentHash),
      ),
    ),
  ];

  const cached = new Map<string, string>();
  if (contentHashes.length > 0) {
    const existing = await db.pool.query<CachedEmbedding>(
      `
      select distinct on (ku.content_hash)
             ku.content_hash,ue.embedding::text embedding
        from knowledge_units ku
        join unit_embeddings ue on ue.unit_id=ku.id
        join embedding_generations eg on eg.id=ue.generation_id
       where ku.space_id=$1 and ku.vault_id=$2
         and ku.embedding_eligible=true and ku.content_hash=any($3::text[])
       order by ku.content_hash,eg.created_at desc
      `,
      [options.spaceId, options.vaultId, contentHashes],
    );
    for (const row of existing.rows) {
      if (row.embedding) cached.set(row.content_hash, row.embedding);
    }
  }

  const adapter = new DeterministicEmbeddingAdapter();
  const generation = await db.pool.query<{ id: string }>(
    `
    insert into embedding_generations(
      space_id,vault_id,provider,model,model_revision,dimensions,normalization,
      configuration_version,corpus_revision,status,activated_at
    ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
             case when $10='ACTIVE' then now() else null end)
    on conflict(vault_id,provider,model,model_revision,configuration_version,corpus_revision)
      do update set status=excluded.status,activated_at=excluded.activated_at
    returning id
    `,
    [
      options.spaceId,
      options.vaultId,
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
    throw new Error("Could not create incremental embedding generation.");

  const artifactIdsByDocument = new Map<string, string>();
  const frontmatterArtifactIds = [
    ...new Set(
      activeDocuments
        .map((document) => document.frontmatter?.source_artifact_id)
        .filter(
          (value): value is string =>
            typeof value === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              value,
            ),
        ),
    ),
  ];
  if (frontmatterArtifactIds.length > 0) {
    const artifacts = await db.pool.query<{ id: string }>(
      `
      select a.id
        from source_artifacts a
        join sources s on s.id=a.source_id
       where a.id=any($1::uuid[]) and s.space_id=$2 and s.vault_id=$3
      `,
      [frontmatterArtifactIds, options.spaceId, options.vaultId],
    );
    const validArtifactIds = new Set(artifacts.rows.map((row) => row.id));
    for (const document of activeDocuments) {
      const candidate = document.frontmatter?.source_artifact_id;
      if (typeof candidate === "string" && validArtifactIds.has(candidate)) {
        artifactIdsByDocument.set(document.id, candidate);
      }
    }
  }
  let artifactId: string | null = null;
  if (options.sourceId) {
    const artifact = await db.pool.query<{ id: string }>(
      `
      select a.id from source_artifacts a
       join sources s on s.id=a.source_id
       where a.source_id=$1 and s.space_id=$2 and s.vault_id=$3
       order by a.created_at desc
       limit 1
      `,
      [options.sourceId, options.spaceId, options.vaultId],
    );
    artifactId = artifact.rows[0]?.id ?? null;
  }

  const client = await db.pool.connect();
  let unitsRebuilt = 0;
  let embeddingsReused = 0;
  let embeddingsCreated = 0;
  try {
    await client.query("begin");
    for (const document of documents.rows) {
      // `document_id` is globally unique and the documents were selected
      // through the explicit space/vault scope above. Deleting by identity
      // also removes legacy pre-registry units whose `vault_id` is NULL,
      // preventing duplicate unit keys during an incremental rebuild.
      await client.query("delete from knowledge_units where document_id=$1", [
        document.id,
      ]);
    }
    for (const { document, units } of parsed) {
      const unitIds = new Map<string, string>();
      const embeddings = await adapter.embed(
        units
          .filter(
            (unit) => unit.embeddingEligible && !cached.has(unit.contentHash),
          )
          .map((unit) => unit.body),
      );
      let generatedIndex = 0;
      for (const unit of units) {
        const inserted = await client.query<{ id: string }>(
          `
          insert into knowledge_units(
            document_id,space_id,vault_id,unit_key,unit_type,heading_path,body,
            content_hash,corpus_revision,lifecycle,trust_tier,source_ids,
            token_estimate,parent_unit_id,document_revision,permissions,locator,
            structural_order,container_only,embedding_eligible,artifact_id
          ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,
                   $17::jsonb,$18,$19,$20,$21)
          returning id
          `,
          [
            document.id,
            options.spaceId,
            options.vaultId,
            unit.unitKey,
            unit.unitType,
            unit.headingPath,
            unit.body,
            unit.contentHash,
            corpusRevision,
            document.lifecycle,
            document.trust_tier,
            options.sourceId ? [options.sourceId] : [],
            unit.tokenEstimate,
            unit.parentUnitKey
              ? (unitIds.get(unit.parentUnitKey) ?? null)
              : null,
            corpusRevision,
            JSON.stringify(document.permissions ?? {}),
            JSON.stringify(unit.locator),
            unit.structuralOrder,
            unit.containerOnly,
            unit.embeddingEligible,
            artifactIdsByDocument.get(document.id) ?? artifactId,
          ],
        );
        const unitId = inserted.rows[0]?.id;
        if (!unitId) throw new Error(`Could not index unit ${unit.unitKey}.`);
        unitIds.set(unit.unitKey, unitId);
        unitsRebuilt += 1;
        if (!unit.embeddingEligible) continue;
        const reused = cached.get(unit.contentHash);
        if (reused) {
          await client.query(
            `insert into unit_embeddings(unit_id,generation_id,content_hash,embedding)
             values($1,$2,$3,$4::vector)
             on conflict(unit_id,generation_id) do update set
               content_hash=excluded.content_hash,embedding=excluded.embedding`,
            [unitId, generationId, unit.contentHash, reused],
          );
          embeddingsReused += 1;
          continue;
        }
        const embedding = embeddings[generatedIndex++];
        if (!embedding) continue;
        await client.query(
          `insert into unit_embeddings(unit_id,generation_id,content_hash,embedding)
           values($1,$2,$3,$4::vector)
           on conflict(unit_id,generation_id) do update set
             content_hash=excluded.content_hash,embedding=excluded.embedding`,
          [unitId, generationId, unit.contentHash, toPgVector(embedding)],
        );
        embeddingsCreated += 1;
      }
    }
    await client.query(
      `delete from context_packets
         where space_id=$1 and vault_id=$2`,
      [options.spaceId, options.vaultId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return {
    documentsRebuilt: documents.rows.length,
    unitsRebuilt,
    embeddingsReused,
    embeddingsCreated,
  };
}

async function currentCompositeRevision(
  db: Postgres,
  options: SynchronizeManagedPathsOptions,
): Promise<string> {
  const result = await db.pool.query<{ current_revision: string }>(
    "select current_revision from vaults where id=$1 and space_id=$2 and enabled=true",
    [options.vaultId, options.spaceId],
  );
  const vaultRevision = result.rows[0]?.current_revision;
  if (!vaultRevision) throw new Error("VAULT_SCOPE_NOT_FOUND");
  return `composite:${vaultRevision}+managed:${options.revision}`;
}

async function markVaultIndexRevision(
  db: Postgres,
  options: SynchronizeManagedPathsOptions,
  corpusRevision: string,
): Promise<void> {
  const vectorEnabled = process.env.AKP_VECTOR_ENABLED === "true";
  await db.pool.query(
    `
    insert into vault_index_revisions(
      space_id,vault_id,corpus_revision,lexical_revision,vector_revision,
      graph_revision,context_pack_revision,status,warnings
    ) values($1,$2,$3,$3,$4,$3,$3,$5,$6::jsonb)
    on conflict(space_id,vault_id) do update set
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
      options.spaceId,
      options.vaultId,
      corpusRevision,
      vectorEnabled ? corpusRevision : null,
      vectorEnabled ? "CONSISTENT" : "DEGRADED",
      JSON.stringify(
        vectorEnabled ? [] : ["VECTOR_DISABLED_PENDING_BENCHMARK"],
      ),
    ],
  );
}

interface IncrementalRunRow {
  id: string;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  corpus_revision: string;
  documents_rebuilt: number;
  units_rebuilt: number;
  embeddings_reused: number;
  embeddings_created: number;
}

async function startIncrementalRun(
  db: Postgres,
  options: SynchronizeManagedPathsOptions,
): Promise<IncrementalRunRow | null> {
  if (!options.eventId) return null;
  const existing = await db.pool.query<IncrementalRunRow>(
    `select id,status,corpus_revision,documents_rebuilt,units_rebuilt,
            embeddings_reused,embeddings_created
       from incremental_index_runs where event_id=$1`,
    [options.eventId],
  );
  const current = existing.rows[0];
  if (current?.status === "COMPLETED") return current;
  if (current) {
    await db.pool.query(
      `update incremental_index_runs
          set status='RUNNING',error=null,started_at=now(),completed_at=null
        where id=$1`,
      [current.id],
    );
    return { ...current, status: "RUNNING" };
  }
  const inserted = await db.pool.query<IncrementalRunRow>(
    `insert into incremental_index_runs(
       event_id,space_id,vault_id,corpus_revision,changed_paths,status
     ) values($1,$2,$3,$4,$5,'RUNNING')
     on conflict(event_id) where event_id is not null do nothing
     returning id,status,corpus_revision,documents_rebuilt,units_rebuilt,
               embeddings_reused,embeddings_created`,
    [
      options.eventId,
      options.spaceId,
      options.vaultId,
      options.revision,
      options.changes.map((change) => change.path),
    ],
  );
  if (inserted.rows[0]) return inserted.rows[0];
  const raced = await db.pool.query<IncrementalRunRow>(
    `select id,status,corpus_revision,documents_rebuilt,units_rebuilt,
            embeddings_reused,embeddings_created
       from incremental_index_runs where event_id=$1`,
    [options.eventId],
  );
  return raced.rows[0] ?? null;
}

async function completeIncrementalRun(
  db: Postgres,
  options: SynchronizeManagedPathsOptions,
  result: SynchronizeManagedPathsResult,
  corpusRevision: string,
  stats: IncrementalProjectionStats,
): Promise<void> {
  if (!options.eventId) return;
  await db.pool.query(
    `update incremental_index_runs
        set status='COMPLETED',corpus_revision=$2,
            tombstoned_paths=$3,documents_rebuilt=$4,units_rebuilt=$5,
            embeddings_reused=$6,embeddings_created=$7,error=null,
            completed_at=now()
      where event_id=$1`,
    [
      options.eventId,
      corpusRevision,
      result.tombstonedPaths,
      stats.documentsRebuilt,
      stats.unitsRebuilt,
      stats.embeddingsReused,
      stats.embeddingsCreated,
    ],
  );
}

async function failIncrementalRun(
  db: Postgres,
  options: SynchronizeManagedPathsOptions,
  error: unknown,
): Promise<void> {
  if (!options.eventId) return;
  await db.pool.query(
    `update incremental_index_runs
        set status='FAILED',error=$2,completed_at=now()
      where event_id=$1`,
    [options.eventId, error instanceof Error ? error.message : String(error)],
  );
}

async function alreadyProjected(
  db: Postgres,
  options: SynchronizeManagedPathsOptions,
  corpusRevision: string,
): Promise<boolean> {
  const result = await db.pool.query<{ corpus_revision: string }>(
    "select corpus_revision from vault_index_revisions where space_id=$1 and vault_id=$2",
    [options.spaceId, options.vaultId],
  );
  return result.rows[0]?.corpus_revision === corpusRevision;
}

/** Apply managed changes and update the vault-scoped index revision. */
export async function synchronizeManagedPaths(
  db: Postgres,
  store: GitKnowledgeStore,
  options: SynchronizeManagedPathsOptions,
): Promise<SynchronizeManagedPathsResult> {
  assertVaultScope(options.vaultId);
  const result = await incrementalIndex(db, store, options);
  return {
    indexedPaths: result.indexedPaths,
    tombstonedPaths: result.tombstonedPaths,
  };
}

/**
 * Incremental managed index port used by API and event workers. Relations and
 * the revision marker are written only after document synchronization succeeds.
 */
export async function incrementalIndex(
  db: Postgres,
  store: GitKnowledgeStore,
  options: SynchronizeManagedPathsOptions,
): Promise<IncrementalIndexResult> {
  assertVaultScope(options.vaultId);
  const prior = await startIncrementalRun(db, options);
  if (prior?.status === "COMPLETED") {
    return {
      indexedPaths: [],
      tombstonedPaths: [],
      relationCount: 0,
      corpusRevision: prior.corpus_revision,
      documentsRebuilt: prior.documents_rebuilt,
      unitsRebuilt: prior.units_rebuilt,
      embeddingsReused: prior.embeddings_reused,
      embeddingsCreated: prior.embeddings_created,
    };
  }
  const corpusRevision = await currentCompositeRevision(db, options);
  if (await alreadyProjected(db, options, corpusRevision)) {
    const empty = {
      documentsRebuilt: 0,
      unitsRebuilt: 0,
      embeddingsReused: 0,
      embeddingsCreated: 0,
    };
    await completeIncrementalRun(
      db,
      options,
      { indexedPaths: [], tombstonedPaths: [] },
      corpusRevision,
      empty,
    );
    return {
      indexedPaths: [],
      tombstonedPaths: [],
      relationCount: 0,
      corpusRevision,
      documentsRebuilt: 0,
      unitsRebuilt: 0,
      embeddingsReused: 0,
      embeddingsCreated: 0,
    };
  }
  try {
    const result = await synchronizeManagedPathsCore(db, store, options);
    const stats = await rebuildChangedUnits(
      db,
      options,
      result,
      corpusRevision,
    );
    const relationCount = await rebuildManagedRelations(
      db,
      options.spaceId,
      options.vaultId,
    );
    await markVaultIndexRevision(db, options, corpusRevision);
    await completeIncrementalRun(db, options, result, corpusRevision, stats);
    return {
      ...result,
      relationCount,
      corpusRevision,
      ...stats,
    };
  } catch (error) {
    await failIncrementalRun(db, options, error).catch(() => undefined);
    throw error;
  }
}

/** Rebuild managed-document edges inside one vault; never resolves targets across vaults. */
export async function rebuildManagedRelations(
  db: Postgres,
  spaceId: string,
  vaultId: string,
): Promise<number> {
  assertVaultScope(vaultId);
  const result = await db.pool.query<LinkableDocument>(
    `
    select id,vault_id,path,external_id,aliases,raw_links,frontmatter
      from knowledge_documents
     where space_id=$1 and vault_id=$2
       and lifecycle not in ('DELETED_TOMBSTONE','SUPERSEDED','INVALID')
    `,
    [spaceId, vaultId],
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
  const client = await db.pool.connect();
  let count = 0;
  try {
    await client.query("begin");
    await client.query(
      `
      delete from knowledge_relations r
       where r.space_id=$1 and r.provenance='managed-markdown'
         and (
           exists (
             select 1 from knowledge_documents f
              where f.id=r.from_document_id and f.vault_id=$2
           )
           or exists (
             select 1 from knowledge_documents t
              where t.id=r.to_document_id and t.vault_id=$2
           )
         )
      `,
      [spaceId, vaultId],
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
        if (
          !target ||
          target.id === document.id ||
          target.vault_id !== vaultId ||
          document.vault_id !== vaultId
        )
          continue;
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

export interface IncrementalIndexReconciliation {
  running: number;
  failed: number;
  completed: number;
  latestRunRevision: string | null;
  indexRevision: string | null;
  revisionDrift: boolean;
}

/**
 * Read-only drift report used by scheduled reconciliation. It never repairs
 * content or invokes a full rebuild; operators can decide whether a failed
 * run should be requeued or the repair-only endpoint should be used.
 */
export async function reconcileIncrementalIndex(
  db: Postgres,
  spaceId: string,
  vaultId: string,
): Promise<IncrementalIndexReconciliation> {
  assertVaultScope(vaultId);
  const counts = await db.pool.query<{
    running: number;
    failed: number;
    completed: number;
  }>(
    `select count(*) filter (where status='RUNNING')::int running,
            count(*) filter (where status='FAILED')::int failed,
            count(*) filter (where status='COMPLETED')::int completed
       from incremental_index_runs where space_id=$1 and vault_id=$2`,
    [spaceId, vaultId],
  );
  const latest = await db.pool.query<{ corpus_revision: string }>(
    `select corpus_revision from incremental_index_runs
      where space_id=$1 and vault_id=$2 and status='COMPLETED'
      order by completed_at desc nulls last,started_at desc limit 1`,
    [spaceId, vaultId],
  );
  const marker = await db.pool.query<{ corpus_revision: string }>(
    `select corpus_revision from vault_index_revisions
      where space_id=$1 and vault_id=$2`,
    [spaceId, vaultId],
  );
  const latestRunRevision = latest.rows[0]?.corpus_revision ?? null;
  const indexRevision = marker.rows[0]?.corpus_revision ?? null;
  return {
    running: Number(counts.rows[0]?.running ?? 0),
    failed: Number(counts.rows[0]?.failed ?? 0),
    completed: Number(counts.rows[0]?.completed ?? 0),
    latestRunRevision,
    indexRevision,
    revisionDrift:
      latestRunRevision !== null &&
      indexRevision !== null &&
      latestRunRevision !== indexRevision,
  };
}
