import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { Postgres } from "@akp/postgres";
import type {
  ManagedChange as IncrementalManagedChange,
  SynchronizeManagedPathsOptions,
} from "@akp/indexing";
import {
  DeterministicEmbeddingAdapter,
  parseKnowledgeUnits,
  toPgVector,
} from "@akp/retrieval";
import type { GitKnowledgeStore } from "@akp/git-store";

export type ManagedChange = IncrementalManagedChange;

type SharedIndexingModule = typeof import("@akp/indexing");
let sharedIndexingPromise: Promise<SharedIndexingModule> | undefined;

function sharedIndexing(): Promise<SharedIndexingModule> {
  sharedIndexingPromise ??= import("@akp/indexing");
  return sharedIndexingPromise;
}

interface IndexedDocument {
  id: string;
  path: string;
  vault_id: string;
  external_id: string;
  title: string;
  lifecycle: string;
  trust_tier: string;
  body_cache: string;
  content_hash: string;
  permissions: Record<string, unknown>;
}

function assertVaultScope(vaultId: string): void {
  if (!vaultId.trim()) throw new Error("VAULT_SCOPE_REQUIRED");
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
  vaultId: string,
  managedRevision?: string | null,
): Promise<string> {
  assertVaultScope(vaultId);
  const vault = await db.pool.query<{ current_revision: string }>(
    `
    select current_revision from vaults where space_id=$1 and id=$2
    `,
    [spaceId, vaultId],
  );
  const managed = managedRevision
    ? { current_revision: managedRevision }
    : (
        await db.pool.query<{ current_revision: string }>(
          `
          select current_revision from knowledge_documents
           where space_id=$1 and vault_id=$2 and path like 'managed/%'
             and lifecycle not in ('DELETED_TOMBSTONE','SUPERSEDED','INVALID')
           order by updated_at desc limit 1
          `,
          [spaceId, vaultId],
        )
      ).rows[0];
  const vaultRevision = vault.rows[0]?.current_revision;
  if (!vaultRevision) throw new Error("VAULT_SCOPE_NOT_FOUND");
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
  vaultId: string,
  managedRevision?: string | null,
): Promise<{
  corpusRevision: string;
  unitCount: number;
  documentCount: number;
}> {
  assertVaultScope(vaultId);
  const corpusRevision = await compositeRevision(
    db,
    spaceId,
    vaultId,
    managedRevision,
  );
  const documents = await db.pool.query<IndexedDocument>(
    `
    select id,path,vault_id,external_id,title,lifecycle,trust_tier,body_cache,
           content_hash,coalesce(frontmatter->'permissions','{}'::jsonb) permissions
      from knowledge_documents
     where space_id=$1 and vault_id=$2
       and lifecycle not in ('ARCHIVED','DELETED_TOMBSTONE','SUPERSEDED','INVALID')
     order by path
    `,
    [spaceId, vaultId],
  );
  const adapter = new DeterministicEmbeddingAdapter();
  const client = await db.pool.connect();
  let unitCount = 0;
  try {
    await client.query("begin");
    const generation = await client.query<{ id: string }>(
      `
      insert into embedding_generations(
        space_id,vault_id,provider,model,model_revision,dimensions,normalization,
        configuration_version,corpus_revision,status,activated_at
      ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
               case when $10='ACTIVE' then now() else null end)
      on conflict(
        vault_id,provider,model,model_revision,configuration_version,corpus_revision
      ) do update set status=excluded.status,activated_at=excluded.activated_at
      returning id
      `,
      [
        spaceId,
        vaultId,
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

    await client.query(
      `delete from knowledge_units u
         using knowledge_documents d
         where u.document_id=d.id and d.space_id=$1 and d.vault_id=$2`,
      [spaceId, vaultId],
    );
    for (const document of documents.rows) {
      const units = parseKnowledgeUnits(document.title, document.body_cache);
      const unitIds = new Map<string, string>();
      const eligibleUnits = units.filter((unit) => unit.embeddingEligible);
      const embeddings = await adapter.embed(
        eligibleUnits.map((unit) => unit.body),
      );
      for (const unit of units) {
        if (!unit) continue;
        const inserted = await client.query<{ id: string }>(
          `
          insert into knowledge_units(
            document_id,space_id,vault_id,unit_key,unit_type,heading_path,body,
            content_hash,corpus_revision,lifecycle,trust_tier,source_ids,
            token_estimate,parent_unit_id,document_revision,permissions,locator,
            structural_order,container_only,embedding_eligible
          ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'{}',$12,$13,$14,$15::jsonb,$16::jsonb,$17,$18,$19)
          returning id
          `,
          [
            document.id,
            spaceId,
            vaultId,
            unit.unitKey,
            unit.unitType,
            unit.headingPath,
            unit.body,
            unit.contentHash,
            corpusRevision,
            document.lifecycle,
            document.trust_tier,
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
          ],
        );
        const unitId = inserted.rows[0]?.id;
        if (!unitId) throw new Error(`Could not index unit ${unit.unitKey}.`);
        unitIds.set(unit.unitKey, unitId);
        if (unit.embeddingEligible) {
          const eligibleIndex = eligibleUnits.findIndex(
            (candidate) => candidate.unitKey === unit.unitKey,
          );
          const embedding = embeddings[eligibleIndex];
          if (!embedding) continue;
          await client.query(
            `
            insert into unit_embeddings(unit_id,generation_id,content_hash,embedding)
            values($1,$2,$3,$4::vector)
            `,
            [unitId, generationId, unit.contentHash, toPgVector(embedding)],
          );
        }
        unitCount += 1;
      }
    }
    await client.query(
      "delete from context_packets where space_id=$1 and vault_id=$2",
      [spaceId, vaultId],
    );
    await client.query(
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
        spaceId,
        vaultId,
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

/** Recreates managed-document edges from canonical Git Markdown/frontmatter. */
export async function rebuildManagedRelations(
  db: Postgres,
  spaceId: string,
  vaultId: string,
): Promise<number> {
  const { rebuildManagedRelations: rebuild } = await sharedIndexing();
  return rebuild(db, spaceId, vaultId);
}

/**
 * Reconciles managed Git changes through the shared incremental indexer.  API
 * callers and workers use the same relation/revision-aware operation.
 */
export async function synchronizeManagedPaths(
  db: Postgres,
  store: GitKnowledgeStore,
  options: SynchronizeManagedPathsOptions,
): Promise<{ indexedPaths: string[]; tombstonedPaths: string[] }> {
  const { incrementalIndex } = await sharedIndexing();
  const result = await incrementalIndex(db, store, options);
  return {
    indexedPaths: result.indexedPaths,
    tombstonedPaths: result.tombstonedPaths,
  };
}
