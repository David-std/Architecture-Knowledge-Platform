import type { Postgres } from "@akp/postgres";
import type { EmbeddingProvider } from "@akp/retrieval";
import {
  EmbeddingGenerationManager,
  configurationHashForDescriptor,
  serializeEmbeddingRuntime,
  type EmbeddingGeneration,
  type EmbeddingGenerationDescriptor,
} from "./embedding-generation.js";

interface EmbeddableUnitRow {
  id: string;
  content_hash: string;
  body: string;
}

interface CachedEmbeddingRow {
  content_hash: string;
  embedding: string;
}

interface GenerationCoverageRow {
  expected: number;
  matching: number;
  stored: number;
}

export interface BuildEmbeddingIndexOptions {
  spaceId: string;
  vaultId: string;
  corpusRevision: string;
  provider: EmbeddingProvider;
  /** Explicit runtime activation; omitted/false leaves a complete READY generation. */
  activate?: boolean;
  batchSize?: number;
}

export interface BuildEmbeddingIndexResult {
  generation: EmbeddingGeneration;
  unitCount: number;
  embeddingsReused: number;
  embeddingsCreated: number;
  activated: boolean;
}

function descriptorForProvider(
  provider: EmbeddingProvider,
): EmbeddingGenerationDescriptor {
  return {
    provider: provider.descriptor.provider,
    model: provider.descriptor.model,
    modelRevision: provider.descriptor.modelRevision,
    dimensions: provider.descriptor.dimensions,
    normalization: provider.descriptor.normalization,
    inputStrategy: provider.descriptor.inputStrategy,
    configurationVersion: provider.descriptor.configurationVersion,
    runtime: provider.descriptor.runtime,
    ...(provider.descriptor.configurationHash
      ? { configurationHash: provider.descriptor.configurationHash }
      : {}),
  };
}

function validBatchSize(value: number | undefined): number {
  const batchSize = value ?? 64;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error("EMBEDDING_BUILD_BATCH_SIZE_INVALID");
  }
  return batchSize;
}

async function generationCoverage(
  db: Postgres,
  generationId: string,
  options: BuildEmbeddingIndexOptions,
): Promise<GenerationCoverageRow> {
  const result = await db.pool.query<GenerationCoverageRow>(
    `
    select
      (
        select count(*)::int
          from knowledge_units u
          join knowledge_documents d on d.id=u.document_id
         where u.space_id=$2 and u.vault_id=$3 and u.corpus_revision=$4
           and u.embedding_eligible=true
           and u.lifecycle in ('ACTIVE','DISPUTED')
           and d.lifecycle in ('ACTIVE','DISPUTED')
           and d.refresh_status not in ('STALE_BLOCKED','INVALID')
      ) expected,
      (
        select count(*)::int
          from unit_embeddings e
          join embedding_generations g on g.id=e.generation_id
          join knowledge_units u
            on u.id=e.unit_id and u.content_hash=e.content_hash
          join knowledge_documents d on d.id=u.document_id
         where e.generation_id=$1 and u.space_id=$2 and u.vault_id=$3
           and u.corpus_revision=$4
           and e.embedding_dimensions=g.dimensions
           and u.embedding_eligible=true
           and u.lifecycle in ('ACTIVE','DISPUTED')
           and d.lifecycle in ('ACTIVE','DISPUTED')
           and d.refresh_status not in ('STALE_BLOCKED','INVALID')
      ) matching,
      (
        select count(*)::int from unit_embeddings where generation_id=$1
      ) stored
    `,
    [generationId, options.spaceId, options.vaultId, options.corpusRevision],
  );
  return result.rows[0] ?? { expected: 0, matching: -1, stored: -1 };
}

async function deleteInvalidGenerationEmbeddings(
  db: Postgres,
  generationId: string,
  options: BuildEmbeddingIndexOptions,
): Promise<void> {
  await db.pool.query(
    `
    delete from unit_embeddings e
     where e.generation_id=$1
       and not exists (
         select 1
           from embedding_generations g
           join knowledge_units u
             on u.id=e.unit_id and u.content_hash=e.content_hash
           join knowledge_documents d on d.id=u.document_id
          where g.id=e.generation_id
            and u.space_id=$2 and u.vault_id=$3 and u.corpus_revision=$4
            and e.embedding_dimensions=g.dimensions
            and u.embedding_eligible=true
            and u.lifecycle in ('ACTIVE','DISPUTED')
            and d.lifecycle in ('ACTIVE','DISPUTED')
            and d.refresh_status not in ('STALE_BLOCKED','INVALID')
       )
    `,
    [generationId, options.spaceId, options.vaultId, options.corpusRevision],
  );
}

/**
 * Couple generation activation to the revision marker that made the build
 * current. A slower build for R1 must never retire R2 after the structural
 * marker has already advanced to R2.
 */
async function activateCurrentGeneration(
  db: Postgres,
  manager: EmbeddingGenerationManager,
  generationId: string,
  options: BuildEmbeddingIndexOptions,
): Promise<EmbeddingGeneration | null> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const marker = await client.query<{ corpus_revision: string }>(
      `select corpus_revision
         from vault_index_revisions
        where space_id=$1 and vault_id=$2
        for update`,
      [options.spaceId, options.vaultId],
    );
    if (marker.rows[0]?.corpus_revision !== options.corpusRevision) {
      await client.query("rollback");
      return null;
    }
    await client.query(`select * from akp_activate_embedding_generation($1)`, [
      generationId,
    ]);
    const updated = await client.query(
      `
      update vault_index_revisions
         set vector_revision=$3,
             status=case
               when lexical_revision=$3 and graph_revision=$3
                 and context_pack_revision=$3 then 'CONSISTENT'
               else 'DEGRADED'
             end,
             warnings=(
               select coalesce(jsonb_agg(value),'[]'::jsonb)
                 from jsonb_array_elements_text(warnings) value
                where value not in (
                  'VECTOR_BUILD_PENDING','VECTOR_BUILD_FAILED',
                  'VECTOR_DISABLED','VECTOR_DISABLED_PENDING_BENCHMARK',
                  'VECTOR_PROVIDER_UNAVAILABLE',
                  'VECTOR_PROVIDER_NOT_CONFIGURED',
                  'VECTOR_PROVIDER_CONFIGURATION_INVALID'
                )
             ),
             updated_at=now()
       where space_id=$1 and vault_id=$2 and corpus_revision=$3
      `,
      [options.spaceId, options.vaultId, options.corpusRevision],
    );
    if (updated.rowCount !== 1) {
      throw new Error("INDEX_REVISION_MARKER_NOT_CURRENT");
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const generation = await manager.get(generationId, {
    spaceId: options.spaceId,
    vaultId: options.vaultId,
    corpusRevision: options.corpusRevision,
  });
  if (!generation) throw new Error("EMBEDDING_GENERATION_NOT_FOUND");
  return generation;
}

/**
 * Build one complete, provider-homogeneous vector generation for the current
 * vault snapshot. Existing active vectors remain selected until the new
 * generation is READY and the optional activation statement succeeds.
 */
export async function buildEmbeddingIndex(
  db: Postgres,
  options: BuildEmbeddingIndexOptions,
): Promise<BuildEmbeddingIndexResult> {
  if (!options.spaceId.trim()) throw new Error("SPACE_SCOPE_REQUIRED");
  if (!options.vaultId.trim()) throw new Error("VAULT_SCOPE_REQUIRED");
  if (!options.corpusRevision.trim())
    throw new Error("CORPUS_REVISION_REQUIRED");
  const batchSize = validBatchSize(options.batchSize);
  const descriptor = descriptorForProvider(options.provider);
  const configurationHash = configurationHashForDescriptor(descriptor);
  const manager = new EmbeddingGenerationManager(db);

  const units = await db.pool.query<EmbeddableUnitRow>(
    `
    select u.id,u.content_hash,u.body
      from knowledge_units u
      join knowledge_documents d on d.id=u.document_id
     where u.space_id=$1 and u.vault_id=$2 and u.corpus_revision=$3
       and u.embedding_eligible=true
       and u.lifecycle in ('ACTIVE','DISPUTED')
       and d.lifecycle in ('ACTIVE','DISPUTED')
       and d.refresh_status not in ('STALE_BLOCKED','INVALID')
     order by u.document_id,u.structural_order,u.id
    `,
    [options.spaceId, options.vaultId, options.corpusRevision],
  );

  let generation = await manager.request({
    spaceId: options.spaceId,
    vaultId: options.vaultId,
    corpusRevision: options.corpusRevision,
    descriptor,
  });
  const coverage = await generationCoverage(
    db,
    generation.generationId,
    options,
  );
  const generationIsComplete =
    coverage.expected === units.rows.length &&
    coverage.matching === coverage.expected &&
    coverage.stored === coverage.expected;
  if (generation.status === "ACTIVE" && generationIsComplete) {
    // A repair can reset the revision marker while retaining this complete
    // generation. Restore query visibility on an idempotent activation.
    const activated = options.activate
      ? await activateCurrentGeneration(
          db,
          manager,
          generation.generationId,
          options,
        )
      : null;
    if (activated) generation = activated;
    return {
      generation,
      unitCount: units.rows.length,
      embeddingsReused: units.rows.length,
      embeddingsCreated: 0,
      activated: activated?.status === "ACTIVE",
    };
  }
  if (
    (generation.status === "READY" || generation.status === "RETIRED") &&
    generationIsComplete
  ) {
    if (options.activate) {
      const activated = await activateCurrentGeneration(
        db,
        manager,
        generation.generationId,
        options,
      );
      if (activated) generation = activated;
    }
    return {
      generation,
      unitCount: units.rows.length,
      embeddingsReused: units.rows.length,
      embeddingsCreated: 0,
      activated: generation.status === "ACTIVE",
    };
  }

  if (
    !generationIsComplete &&
    (generation.status === "ACTIVE" || generation.status === "READY")
  ) {
    generation = await manager.stale(generation.generationId, {
      spaceId: options.spaceId,
      vaultId: options.vaultId,
      corpusRevision: options.corpusRevision,
    });
  }

  generation = await manager.beginBuild(generation.generationId, {
    spaceId: options.spaceId,
    vaultId: options.vaultId,
    corpusRevision: options.corpusRevision,
  });
  await deleteInvalidGenerationEmbeddings(db, generation.generationId, options);
  let embeddingsReused = 0;
  let embeddingsCreated = 0;
  try {
    const alreadyWritten = await db.pool.query<{ unit_id: string }>(
      `
      select e.unit_id
        from unit_embeddings e
        join knowledge_units u
          on u.id=e.unit_id and u.content_hash=e.content_hash
       where e.generation_id=$1
         and u.space_id=$2 and u.vault_id=$3 and u.corpus_revision=$4
      `,
      [
        generation.generationId,
        options.spaceId,
        options.vaultId,
        options.corpusRevision,
      ],
    );
    const completedUnitIds = new Set(
      alreadyWritten.rows.map((row) => String(row.unit_id)),
    );
    embeddingsReused += completedUnitIds.size;

    const missingUnits = units.rows.filter(
      (unit) => !completedUnitIds.has(unit.id),
    );
    const contentHashes = [
      ...new Set(missingUnits.map((unit) => unit.content_hash)),
    ];
    const cached =
      contentHashes.length === 0
        ? { rows: [] as CachedEmbeddingRow[] }
        : await db.pool.query<CachedEmbeddingRow>(
            `
            select distinct on (e.content_hash)
                   e.content_hash,e.embedding::text embedding
              from unit_embeddings e
              join embedding_generations g on g.id=e.generation_id
             where g.space_id=$1 and g.vault_id=$2
               and g.provider=$3 and g.model=$4 and g.model_revision=$5
               and g.dimensions=$6 and g.normalization=$7
               and g.input_strategy=$8 and g.configuration_version=$9
               and g.runtime=$10 and g.configuration_hash=$11
               and e.embedding_dimensions=$6
               and e.content_hash=any($12::text[])
               and g.id<>$13
             order by e.content_hash,g.created_at desc
            `,
            [
              options.spaceId,
              options.vaultId,
              descriptor.provider,
              descriptor.model,
              descriptor.modelRevision,
              descriptor.dimensions,
              descriptor.normalization,
              descriptor.inputStrategy,
              descriptor.configurationVersion,
              serializeEmbeddingRuntime(descriptor.runtime),
              configurationHash,
              contentHashes,
              generation.generationId,
            ],
          );
    const cachedByHash = new Map(
      cached.rows.map((row) => [row.content_hash, row.embedding]),
    );
    const needsInference: EmbeddableUnitRow[] = [];
    for (const unit of missingUnits) {
      const embedding = cachedByHash.get(unit.content_hash);
      if (!embedding) {
        needsInference.push(unit);
        continue;
      }
      await manager.writeEmbedding({
        generationId: generation.generationId,
        unitId: unit.id,
        contentHash: unit.content_hash,
        embedding,
      });
      embeddingsReused += 1;
    }
    for (let start = 0; start < needsInference.length; start += batchSize) {
      const batch = needsInference.slice(start, start + batchSize);
      const vectors = await options.provider.embed(
        batch.map((unit) => unit.body),
        "passage",
      );
      if (vectors.length !== batch.length) {
        throw new Error("EMBEDDING_PROVIDER_RESULT_COUNT_MISMATCH");
      }
      for (const [index, unit] of batch.entries()) {
        const vector = vectors[index];
        if (!vector) throw new Error("EMBEDDING_PROVIDER_RESULT_MISSING");
        await manager.writeEmbedding({
          generationId: generation.generationId,
          unitId: unit.id,
          contentHash: unit.content_hash,
          embedding: vector,
        });
        embeddingsCreated += 1;
      }
    }
    generation = await manager.markReady(
      generation.generationId,
      units.rows.length,
      {
        spaceId: options.spaceId,
        vaultId: options.vaultId,
        corpusRevision: options.corpusRevision,
      },
    );
    if (options.activate) {
      const activated = await activateCurrentGeneration(
        db,
        manager,
        generation.generationId,
        options,
      );
      if (activated) generation = activated;
    }
    return {
      generation,
      unitCount: units.rows.length,
      embeddingsReused,
      embeddingsCreated,
      activated: generation.status === "ACTIVE",
    };
  } catch (error) {
    await manager
      .fail(generation.generationId, "EMBEDDING_BUILD_FAILED", {
        spaceId: options.spaceId,
        vaultId: options.vaultId,
        corpusRevision: options.corpusRevision,
      })
      .catch(() => undefined);
    throw error;
  }
}
