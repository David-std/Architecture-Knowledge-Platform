import type { Postgres } from "@akp/postgres";
import {
  configurationHashForEmbeddingDescriptor,
  serializeEmbeddingRuntime as serializeProviderRuntime,
  toPgVector,
} from "@akp/retrieval";

/** States persisted by migration 019. */
export type EmbeddingGenerationStatus =
  | "REQUESTED"
  | "BUILDING"
  | "READY"
  | "ACTIVE"
  | "RETIRED"
  | "STALE"
  | "FAILED";

/** Runtime metadata may be a compact name or a structured, provider-owned descriptor. */
export type EmbeddingRuntime = string | object;

/**
 * Provider metadata that changes the meaning of a vector.  A generation is
 * immutable with respect to every field in this descriptor; changing one
 * creates a new generation instead of mixing vectors in an existing one.
 */
export interface EmbeddingGenerationDescriptor {
  provider: string;
  model: string;
  modelRevision: string;
  dimensions: number;
  normalization: string;
  inputStrategy: string;
  configurationVersion: string;
  runtime: EmbeddingRuntime;
  /** SHA-256 of the redacted, canonical provider configuration. */
  configurationHash?: string;
}

export interface EmbeddingGenerationScope {
  spaceId: string;
  vaultId: string;
  corpusRevision: string;
}

export interface RequestEmbeddingGeneration extends EmbeddingGenerationScope {
  descriptor: EmbeddingGenerationDescriptor;
}

export interface EmbeddingGeneration extends EmbeddingGenerationScope {
  generationId: string;
  provider: string;
  model: string;
  modelRevision: string;
  dimensions: number;
  normalization: string;
  inputStrategy: string;
  configurationVersion: string;
  /** Canonical serialized runtime metadata; secrets are never persisted. */
  runtime: string;
  configurationHash: string;
  status: EmbeddingGenerationStatus;
  createdAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
  failureReason: string | null;
  updatedAt: string;
}

export interface WriteEmbeddingInput {
  generationId: string;
  unitId: string;
  contentHash: string;
  embedding: readonly number[] | string;
}

export interface UnitEmbedding {
  id: string;
  generationId: string;
  unitId: string;
  contentHash: string;
  embedding: string;
  embeddingDimensions: number;
  createdAt: string;
}

interface DatabaseGenerationRow {
  id: string;
  space_id: string;
  vault_id: string | null;
  corpus_revision: string;
  provider: string;
  model: string;
  model_revision: string;
  dimensions: number;
  normalization: string;
  input_strategy: string;
  configuration_version: string;
  runtime: string;
  configuration_hash: string;
  status: EmbeddingGenerationStatus;
  created_at: Date | string;
  activated_at: Date | string | null;
  retired_at: Date | string | null;
  failure_reason: string | null;
  updated_at: Date | string;
}

interface DatabaseUnitEmbeddingRow {
  id: string;
  generation_id: string;
  unit_id: string;
  content_hash: string;
  embedding: string;
  embedding_dimensions: number;
  created_at: Date | string;
}

function requiredScope(scope: EmbeddingGenerationScope): void {
  if (!scope.spaceId.trim()) throw new Error("SPACE_SCOPE_REQUIRED");
  if (!scope.vaultId.trim()) throw new Error("VAULT_SCOPE_REQUIRED");
  if (!scope.corpusRevision.trim()) throw new Error("CORPUS_REVISION_REQUIRED");
}

function requiredDescriptor(descriptor: EmbeddingGenerationDescriptor): void {
  const stringFields = [
    descriptor.provider,
    descriptor.model,
    descriptor.modelRevision,
    descriptor.normalization,
    descriptor.inputStrategy,
    descriptor.configurationVersion,
  ];
  if (stringFields.some((field) => !field.trim()))
    throw new Error("EMBEDDING_DESCRIPTOR_REQUIRED");
  if (!Number.isInteger(descriptor.dimensions) || descriptor.dimensions < 1)
    throw new Error("EMBEDDING_DIMENSIONS_INVALID");
  if (descriptor.dimensions > 2000)
    throw new Error("EMBEDDING_DIMENSIONS_UNSUPPORTED");
  if (
    (typeof descriptor.runtime === "string" && !descriptor.runtime.trim()) ||
    (typeof descriptor.runtime !== "string" &&
      (descriptor.runtime === null ||
        Array.isArray(descriptor.runtime) ||
        typeof descriptor.runtime !== "object"))
  ) {
    throw new Error("EMBEDDING_RUNTIME_REQUIRED");
  }
  if (
    descriptor.configurationHash !== undefined &&
    !/^[a-f0-9]{64}$/.test(descriptor.configurationHash)
  ) {
    throw new Error("EMBEDDING_CONFIGURATION_HASH_INVALID");
  }
}

/**
 * Serialize runtime metadata deterministically before writing it to Postgres.
 * Runtime objects are intentionally treated as metadata, not as a transport
 * for credentials. Secret-shaped keys are redacted so an accidentally passed
 * token cannot enter the generation descriptor or its configuration hash.
 */
export function serializeEmbeddingRuntime(runtime: EmbeddingRuntime): string {
  const serialized = serializeProviderRuntime(runtime);
  if (!serialized) throw new Error("EMBEDDING_RUNTIME_REQUIRED");
  return serialized;
}

/**
 * Derive a stable fallback configuration hash when a provider does not expose
 * one.  Providers with secret/path-bearing configuration should pass the
 * already redacted hash explicitly; no secret is accepted or persisted here.
 */
export function configurationHashForDescriptor(
  descriptor: EmbeddingGenerationDescriptor,
): string {
  return configurationHashForEmbeddingDescriptor(descriptor);
}

function asIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function generationFromRow(row: DatabaseGenerationRow): EmbeddingGeneration {
  if (!row.vault_id) throw new Error("VAULT_SCOPE_REQUIRED");
  return {
    generationId: row.id,
    spaceId: row.space_id,
    vaultId: row.vault_id,
    corpusRevision: row.corpus_revision,
    provider: row.provider,
    model: row.model,
    modelRevision: row.model_revision,
    dimensions: Number(row.dimensions),
    normalization: row.normalization,
    inputStrategy: row.input_strategy,
    configurationVersion: row.configuration_version,
    runtime: row.runtime,
    configurationHash: row.configuration_hash,
    status: row.status,
    createdAt: asIso(row.created_at) as string,
    activatedAt: asIso(row.activated_at),
    retiredAt: asIso(row.retired_at),
    failureReason: row.failure_reason,
    updatedAt: asIso(row.updated_at) as string,
  };
}

function embeddingFromRow(row: DatabaseUnitEmbeddingRow): UnitEmbedding {
  return {
    id: row.id,
    generationId: row.generation_id,
    unitId: row.unit_id,
    contentHash: row.content_hash,
    embedding: row.embedding,
    embeddingDimensions: Number(row.embedding_dimensions),
    createdAt: asIso(row.created_at) as string,
  };
}

function vectorValues(embedding: readonly number[] | string): number[] {
  if (typeof embedding !== "string") {
    if (
      embedding.length < 1 ||
      embedding.some((value) => !Number.isFinite(value))
    )
      throw new Error("EMBEDDING_VECTOR_INVALID");
    return [...embedding];
  }
  const trimmed = embedding.trim();
  if (!/^\[[^\]]*\]$/.test(trimmed))
    throw new Error("EMBEDDING_VECTOR_INVALID");
  const body = trimmed.slice(1, -1).trim();
  if (!body) throw new Error("EMBEDDING_VECTOR_INVALID");
  const values = body.split(",");
  if (
    values.some(
      (value) => value.trim() === "" || !Number.isFinite(Number(value)),
    )
  ) {
    throw new Error("EMBEDDING_VECTOR_INVALID");
  }
  return values.map((value) => Number(value));
}

const generationColumns = `
  id,space_id,vault_id,corpus_revision,provider,model,model_revision,
  dimensions,normalization,input_strategy,configuration_version,runtime,
  configuration_hash,status,created_at,activated_at,retired_at,
  failure_reason,updated_at
`;

/**
 * Durable lifecycle manager. It owns generation identity and state only;
 * embedding providers remain outside this package and write vectors through
 * `writeEmbedding`.
 */
export class EmbeddingGenerationManager {
  public constructor(private readonly db: Postgres) {}

  async request(
    input: RequestEmbeddingGeneration,
  ): Promise<EmbeddingGeneration> {
    requiredScope(input);
    requiredDescriptor(input.descriptor);
    const configurationHash = configurationHashForDescriptor(input.descriptor);

    const vault = await this.db.pool.query(
      `select 1 from vaults where id=$1 and space_id=$2`,
      [input.vaultId, input.spaceId],
    );
    if (vault.rowCount !== 1) throw new Error("VAULT_SCOPE_MISMATCH");

    const inserted = await this.db.pool.query<DatabaseGenerationRow>(
      `
      insert into embedding_generations(
        space_id,vault_id,provider,model,model_revision,dimensions,
        normalization,input_strategy,configuration_version,runtime,
        configuration_hash,corpus_revision,status
      ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'REQUESTED')
      on conflict do nothing
      returning ${generationColumns}
      `,
      [
        input.spaceId,
        input.vaultId,
        input.descriptor.provider,
        input.descriptor.model,
        input.descriptor.modelRevision,
        input.descriptor.dimensions,
        input.descriptor.normalization,
        input.descriptor.inputStrategy,
        input.descriptor.configurationVersion,
        serializeEmbeddingRuntime(input.descriptor.runtime),
        configurationHash,
        input.corpusRevision,
      ],
    );
    if (inserted.rows[0]) return generationFromRow(inserted.rows[0]);

    const existing = await this.db.pool.query<DatabaseGenerationRow>(
      `
      select ${generationColumns}
        from embedding_generations
       where space_id=$1 and vault_id=$2 and provider=$3 and model=$4
         and model_revision=$5 and dimensions=$6 and normalization=$7
         and input_strategy=$8 and configuration_version=$9 and runtime=$10
         and configuration_hash=$11 and corpus_revision=$12
      `,
      [
        input.spaceId,
        input.vaultId,
        input.descriptor.provider,
        input.descriptor.model,
        input.descriptor.modelRevision,
        input.descriptor.dimensions,
        input.descriptor.normalization,
        input.descriptor.inputStrategy,
        input.descriptor.configurationVersion,
        serializeEmbeddingRuntime(input.descriptor.runtime),
        configurationHash,
        input.corpusRevision,
      ],
    );
    const row = existing.rows[0];
    if (!row) throw new Error("EMBEDDING_GENERATION_REQUEST_RACE");
    return generationFromRow(row);
  }

  /** Move a requested/retryable generation into the build phase. */
  async build(
    generationId: string,
    scope?: Partial<EmbeddingGenerationScope>,
  ): Promise<EmbeddingGeneration> {
    return this.transition(generationId, "BUILDING", scope, [
      "REQUESTED",
      "FAILED",
      "STALE",
      "RETIRED",
    ]);
  }

  async beginBuild(
    generationId: string,
    scope?: Partial<EmbeddingGenerationScope>,
  ): Promise<EmbeddingGeneration> {
    return this.build(generationId, scope);
  }

  /** Mark a complete provider build as available for atomic activation. */
  async ready(
    generationId: string,
    expectedEmbeddingCount?: number,
    scope?: Partial<EmbeddingGenerationScope>,
  ): Promise<EmbeddingGeneration> {
    if (
      expectedEmbeddingCount !== undefined &&
      (!Number.isInteger(expectedEmbeddingCount) || expectedEmbeddingCount < 0)
    ) {
      throw new Error("EMBEDDING_COUNT_INVALID");
    }
    const where = this.scopePredicate(scope, 1);
    const args: unknown[] = [generationId, ...where.args];
    if (expectedEmbeddingCount !== undefined) {
      args.push(expectedEmbeddingCount);
    }
    const expectedClause =
      expectedEmbeddingCount === undefined
        ? ""
        : `and (select count(*) from unit_embeddings e where e.generation_id=g.id)=$${args.length}`;
    const changed = await this.db.pool.query<DatabaseGenerationRow>(
      `
      update embedding_generations g
         set status='READY',updated_at=now()
       where g.id=$1 ${where.sql}
         and g.status='BUILDING'
         ${expectedClause}
      returning ${generationColumns}
      `,
      args,
    );
    if (changed.rows[0]) return generationFromRow(changed.rows[0]);
    const current = await this.get(generationId, scope);
    if (current?.status === "READY" || current?.status === "ACTIVE") {
      const completeness = await this.db.pool.query<{ complete: boolean }>(
        `select akp_embedding_generation_is_complete($1) complete`,
        [generationId],
      );
      if (completeness.rows[0]?.complete !== true) {
        throw new Error("EMBEDDING_GENERATION_INCOMPLETE");
      }
      return current;
    }
    if (expectedEmbeddingCount !== undefined && current?.status === "BUILDING")
      throw new Error("EMBEDDING_GENERATION_INCOMPLETE");
    throw new Error("INVALID_EMBEDDING_GENERATION_TRANSITION");
  }

  async markReady(
    generationId: string,
    expectedEmbeddingCount?: number,
    scope?: Partial<EmbeddingGenerationScope>,
  ): Promise<EmbeddingGeneration> {
    return this.ready(generationId, expectedEmbeddingCount, scope);
  }

  /**
   * Atomically retires the previous active generation and activates this one.
   * The database function serializes concurrent switches per vault.
   */
  async activate(
    generationId: string,
    scope?: Partial<EmbeddingGenerationScope>,
  ): Promise<EmbeddingGeneration> {
    const current = await this.get(generationId, scope);
    if (!current) throw new Error("EMBEDDING_GENERATION_NOT_FOUND");
    const activated = await this.db.pool.query<DatabaseGenerationRow>(
      `select * from akp_activate_embedding_generation($1)`,
      [generationId],
    );
    const row = activated.rows[0];
    if (!row) throw new Error("EMBEDDING_GENERATION_NOT_FOUND");
    return generationFromRow(row);
  }

  async retire(
    generationId: string,
    scope?: Partial<EmbeddingGenerationScope>,
  ): Promise<EmbeddingGeneration> {
    return this.transition(generationId, "RETIRED", scope, ["ACTIVE", "READY"]);
  }

  /**
   * Remove an incomplete generation from normal selection before repairing
   * it. ACTIVE and READY are accepted because derived vector rows may have
   * been deleted or corrupted independently of the immutable descriptor.
   */
  async stale(
    generationId: string,
    scope?: Partial<EmbeddingGenerationScope>,
  ): Promise<EmbeddingGeneration> {
    return this.transition(generationId, "STALE", scope, [
      "REQUESTED",
      "BUILDING",
      "READY",
      "ACTIVE",
    ]);
  }

  async fail(
    generationId: string,
    reason: string,
    scope?: Partial<EmbeddingGenerationScope>,
  ): Promise<EmbeddingGeneration> {
    if (!reason.trim()) throw new Error("EMBEDDING_FAILURE_REASON_REQUIRED");
    const where = this.scopePredicate(scope, 1);
    const changed = await this.db.pool.query<DatabaseGenerationRow>(
      `
      update embedding_generations g
         set status='FAILED',failure_reason=$${where.args.length + 2},updated_at=now()
       where g.id=$1 ${where.sql}
         and g.status in ('REQUESTED','BUILDING')
      returning ${generationColumns}
      `,
      [generationId, ...where.args, reason],
    );
    if (changed.rows[0]) return generationFromRow(changed.rows[0]);
    const current = await this.get(generationId, scope);
    if (current?.status === "FAILED") return current;
    throw new Error("INVALID_EMBEDDING_GENERATION_TRANSITION");
  }

  async writeEmbedding(input: WriteEmbeddingInput): Promise<UnitEmbedding> {
    if (!input.generationId.trim()) throw new Error("GENERATION_ID_REQUIRED");
    if (!input.unitId.trim()) throw new Error("UNIT_ID_REQUIRED");
    if (!input.contentHash.trim()) throw new Error("CONTENT_HASH_REQUIRED");
    const values = vectorValues(input.embedding);
    const dimensions = values.length;
    const generation = await this.db.pool.query<{
      dimensions: number;
      normalization: string;
      status: EmbeddingGenerationStatus;
    }>(
      `select dimensions,normalization,status
         from embedding_generations where id=$1`,
      [input.generationId],
    );
    const descriptor = generation.rows[0];
    if (!descriptor) throw new Error("EMBEDDING_GENERATION_NOT_FOUND");
    if (descriptor.status !== "BUILDING")
      throw new Error("GENERATION_NOT_BUILDING");
    if (Number(descriptor.dimensions) !== dimensions)
      throw new Error("EMBEDDING_DIMENSION_MISMATCH");
    if (descriptor.normalization.toLowerCase() === "l2") {
      const norm = Math.hypot(...values);
      if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-4) {
        throw new Error("EMBEDDING_NORMALIZATION_MISMATCH");
      }
    }

    const vector =
      typeof input.embedding !== "string"
        ? toPgVector(input.embedding)
        : input.embedding;
    const inserted = await this.db.pool.query<DatabaseUnitEmbeddingRow>(
      `
      insert into unit_embeddings(
        unit_id,generation_id,content_hash,embedding,embedding_dimensions
      ) values($1,$2,$3,$4::vector,$5)
      on conflict(unit_id,generation_id) do nothing
      returning id,generation_id,unit_id,content_hash,embedding::text embedding,
                embedding_dimensions,created_at
      `,
      [input.unitId, input.generationId, input.contentHash, vector, dimensions],
    );
    if (inserted.rows[0]) return embeddingFromRow(inserted.rows[0]);

    const existing = await this.db.pool.query<DatabaseUnitEmbeddingRow>(
      `
      select id,generation_id,unit_id,content_hash,embedding::text embedding,
             embedding_dimensions,created_at
        from unit_embeddings
       where unit_id=$1 and generation_id=$2
      `,
      [input.unitId, input.generationId],
    );
    const row = existing.rows[0];
    if (!row) throw new Error("EMBEDDING_WRITE_RACE");
    if (row.content_hash !== input.contentHash)
      throw new Error("EMBEDDING_CONTENT_HASH_MISMATCH");
    return embeddingFromRow(row);
  }

  async addEmbedding(input: WriteEmbeddingInput): Promise<UnitEmbedding> {
    return this.writeEmbedding(input);
  }

  async get(
    generationId: string,
    scope?: Partial<EmbeddingGenerationScope>,
  ): Promise<EmbeddingGeneration | null> {
    const where = this.scopePredicate(scope, 1);
    const result = await this.db.pool.query<DatabaseGenerationRow>(
      `select ${generationColumns}
         from embedding_generations g
        where g.id=$1 ${where.sql}`,
      [generationId, ...where.args],
    );
    const row = result.rows[0];
    return row ? generationFromRow(row) : null;
  }

  async getActive(
    spaceId: string,
    vaultId: string,
  ): Promise<EmbeddingGeneration | null> {
    if (!spaceId.trim()) throw new Error("SPACE_SCOPE_REQUIRED");
    if (!vaultId.trim()) throw new Error("VAULT_SCOPE_REQUIRED");
    const result = await this.db.pool.query<DatabaseGenerationRow>(
      `select ${generationColumns}
         from embedding_generations g
        where g.space_id=$1 and g.vault_id=$2 and g.status='ACTIVE'
        order by g.activated_at desc nulls last,g.created_at desc
        limit 1`,
      [spaceId, vaultId],
    );
    const row = result.rows[0];
    return row ? generationFromRow(row) : null;
  }

  async queryActive(
    spaceId: string,
    vaultId: string,
  ): Promise<EmbeddingGeneration | null> {
    return this.getActive(spaceId, vaultId);
  }

  private scopePredicate(
    scope: Partial<EmbeddingGenerationScope> | undefined,
    firstParameter: number,
  ): { sql: string; args: unknown[] } {
    const clauses: string[] = [];
    const args: unknown[] = [];
    let parameter = firstParameter + 1;
    if (scope?.spaceId !== undefined) {
      if (!scope.spaceId.trim()) throw new Error("SPACE_SCOPE_REQUIRED");
      clauses.push(`and g.space_id=$${parameter}`);
      args.push(scope.spaceId);
      parameter += 1;
    }
    if (scope?.vaultId !== undefined) {
      if (!scope.vaultId.trim()) throw new Error("VAULT_SCOPE_REQUIRED");
      clauses.push(`and g.vault_id=$${parameter}`);
      args.push(scope.vaultId);
      parameter += 1;
    }
    if (scope?.corpusRevision !== undefined) {
      if (!scope.corpusRevision.trim())
        throw new Error("CORPUS_REVISION_REQUIRED");
      clauses.push(`and g.corpus_revision=$${parameter}`);
      args.push(scope.corpusRevision);
    }
    return { sql: clauses.join(" "), args };
  }

  private async transition(
    generationId: string,
    status: "BUILDING" | "RETIRED" | "STALE",
    scope: Partial<EmbeddingGenerationScope> | undefined,
    allowed: readonly EmbeddingGenerationStatus[],
  ): Promise<EmbeddingGeneration> {
    const where = this.scopePredicate(scope, 1);
    const changed = await this.db.pool.query<DatabaseGenerationRow>(
      `
      update embedding_generations g
         set status=$${where.args.length + 2},updated_at=now()
       where g.id=$1 ${where.sql}
         and g.status=any($${where.args.length + 3}::text[])
      returning ${generationColumns}
      `,
      [generationId, ...where.args, status, [...allowed]],
    );
    if (changed.rows[0]) return generationFromRow(changed.rows[0]);
    const current = await this.get(generationId, scope);
    if (current?.status === status) return current;
    throw new Error("INVALID_EMBEDDING_GENERATION_TRANSITION");
  }
}

/** Provider-independent port used by indexing implementations to switch the
 * queryable vector generation without knowing how the state is persisted. */
export class EmbeddingIndexActivator {
  public constructor(private readonly manager: EmbeddingGenerationManager) {}

  async activate(
    generationId: string,
    scope?: Partial<EmbeddingGenerationScope>,
  ): Promise<EmbeddingGeneration> {
    return this.manager.activate(generationId, scope);
  }

  async activateGeneration(
    generationId: string,
    scope?: Partial<EmbeddingGenerationScope>,
  ): Promise<EmbeddingGeneration> {
    return this.activate(generationId, scope);
  }
}

export function createEmbeddingIndexActivator(
  manager: EmbeddingGenerationManager,
): EmbeddingIndexActivator {
  return new EmbeddingIndexActivator(manager);
}

export async function requestEmbeddingGeneration(
  db: Postgres,
  input: RequestEmbeddingGeneration,
): Promise<EmbeddingGeneration> {
  return new EmbeddingGenerationManager(db).request(input);
}
