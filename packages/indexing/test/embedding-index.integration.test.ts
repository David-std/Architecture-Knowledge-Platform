import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Postgres } from "@akp/postgres";
import type {
  EmbeddingDescriptor,
  EmbeddingInputRole,
  EmbeddingProvider,
  EmbeddingRequestOptions,
} from "@akp/retrieval";
import { buildEmbeddingIndex } from "../src/embedding-index.js";
import {
  EmbeddingGenerationManager,
  configurationHashForDescriptor,
} from "../src/embedding-generation.js";

const databaseUrl = process.env.DATABASE_URL;

interface Fixture {
  db: Postgres;
  organizationId: string;
  spaceId: string;
  vaultId: string;
  documentId: string;
  unitIds: string[];
  unitHashes: string[];
}

interface StubProvider extends EmbeddingProvider {
  readonly calls: number;
  readonly roles: EmbeddingInputRole[];
  readonly started: Promise<void>;
  release(): void;
}

interface StubProviderOptions {
  descriptor: EmbeddingDescriptor;
  outputDimensions?: number;
  failure?: Error;
  blockUntilReleased?: boolean;
}

function vector(dimensions: number, value: number): number[] {
  const values = Array.from({ length: dimensions }, (_, index) =>
    index === 0 ? value : value / (index + 1),
  );
  const norm = Math.hypot(...values);
  return values.map((component) => component / norm);
}

/**
 * A deliberately small provider double. It records the role supplied by the
 * indexer and can pause/fail inference so the database lifecycle is observable
 * while a new generation is still BUILDING.
 */
function stubProvider(options: StubProviderOptions): StubProvider {
  let callCount = 0;
  const roles: EmbeddingInputRole[] = [];
  let resolveStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let resolveRelease: () => void = () => undefined;
  const releaseSignal = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });

  return {
    descriptor: options.descriptor,
    get calls() {
      return callCount;
    },
    roles,
    started,
    release: resolveRelease,
    async embed(
      texts: readonly string[],
      request?: EmbeddingInputRole | EmbeddingRequestOptions,
    ): Promise<number[][]> {
      callCount += 1;
      const role =
        typeof request === "string" ? request : (request?.role ?? "passage");
      roles.push(role);
      resolveStarted();
      if (options.blockUntilReleased) await releaseSignal;
      if (options.failure) throw options.failure;
      const outputDimensions =
        options.outputDimensions ?? options.descriptor.dimensions;
      return texts.map((_, index) =>
        vector(outputDimensions, (index + 1) / 10),
      );
    },
  };
}

function descriptor(
  overrides: Partial<EmbeddingDescriptor> = {},
): EmbeddingDescriptor {
  return {
    provider: "integration-test-provider",
    model: "integration-test-model",
    modelRevision: "integration-test-revision-1",
    dimensions: 4,
    normalization: "l2",
    inputStrategy: "passage-prefix-v1",
    configurationVersion: "integration-test-config-v1",
    runtime: { backend: "integration-test", device: "cpu" },
    ...overrides,
  };
}

async function createFixture(databaseUrlValue: string): Promise<Fixture> {
  const db = new Postgres(databaseUrlValue);
  const organizationId = randomUUID();
  const spaceId = randomUUID();
  const vaultId = randomUUID();
  const documentId = randomUUID();
  const unitIds = [randomUUID(), randomUUID()];
  const unitHashes = ["a".repeat(64), "b".repeat(64)];
  const corpusRevision = "embedding-index-revision-1";

  await db.pool.query(
    `insert into organizations(id,slug,name) values($1,$2,$3)`,
    [
      organizationId,
      `ei-${organizationId.slice(0, 8)}`,
      "Embedding index test",
    ],
  );
  await db.pool.query(
    `insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values($1,$2,$3,$4,'PRIVATE',$5)`,
    [
      spaceId,
      organizationId,
      `ei-${spaceId.slice(0, 8)}`,
      "Embedding index test space",
      "C:/akp/embedding-index-test",
    ],
  );
  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,
       vault_key,local_path,visibility,enabled
     ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)`,
    [
      vaultId,
      spaceId,
      "C:/akp/embedding-index-test",
      "Embedding index test vault",
      corpusRevision,
      `ei-${vaultId.slice(0, 8)}`,
    ],
  );
  await db.pool.query(
    `insert into knowledge_documents(
       id,space_id,vault_id,path,external_id,title,type,lifecycle,
       trust_tier,current_revision,body_cache,frontmatter,aliases,layer,
       content_hash,token_estimate,raw_links
     ) values($1,$2,$3,'managed/embedding-index.md','EI-DOC',
       'Embedding index fixture','note','ACTIVE','CURATED',$4,$5,$6,'{}',
       'test',$7,8,'[]'::jsonb)`,
    [
      documentId,
      spaceId,
      vaultId,
      corpusRevision,
      "Two units used to verify generation construction and cache reuse.",
      JSON.stringify({ id: "EI-DOC", type: "note" }),
      "c".repeat(64),
    ],
  );
  for (const [index, unitId] of unitIds.entries()) {
    await db.pool.query(
      `insert into knowledge_units(
         id,document_id,space_id,vault_id,unit_key,unit_type,heading_path,
         body,content_hash,corpus_revision,lifecycle,trust_tier,source_ids,
         token_estimate,document_revision,permissions,locator,structural_order,
         container_only,embedding_eligible
       ) values($1,$2,$3,$4,$5,'PARAGRAPH','{}',$6,$7,$8,'ACTIVE','CURATED',
         '{}',4,$8,'{}'::jsonb,'{}'::jsonb,$9,false,true)`,
      [
        unitId,
        documentId,
        spaceId,
        vaultId,
        `paragraph-${index + 1}`,
        index === 0
          ? "A unit about publishing content."
          : "A unit about enrolment rules.",
        unitHashes[index],
        corpusRevision,
        index,
      ],
    );
  }

  return {
    db,
    organizationId,
    spaceId,
    vaultId,
    documentId,
    unitIds,
    unitHashes,
  };
}

async function prepareRevision(
  fixture: Fixture,
  corpusRevision: string,
): Promise<void> {
  await fixture.db.pool.query(
    `update vaults set current_revision=$1 where id=$2`,
    [corpusRevision, fixture.vaultId],
  );
  await fixture.db.pool.query(
    `update knowledge_documents set current_revision=$1 where id=$2`,
    [corpusRevision, fixture.documentId],
  );
  // Structural indexing owns revisioned unit snapshots. Clone the stable test
  // content into the requested revision instead of mutating the prior rows,
  // because ACTIVE generations must retain their FK targets during a rebuild.
  await fixture.db.pool.query(
    `insert into knowledge_units(
       document_id,space_id,vault_id,unit_key,unit_type,heading_path,body,
       content_hash,corpus_revision,lifecycle,trust_tier,source_ids,
       token_estimate,document_revision,permissions,locator,structural_order,
       container_only,embedding_eligible
     )
     select document_id,space_id,vault_id,unit_key,unit_type,heading_path,body,
            content_hash,$1,lifecycle,trust_tier,source_ids,token_estimate,$1,
            permissions,locator,structural_order,container_only,embedding_eligible
       from knowledge_units
      where document_id=$2 and corpus_revision='embedding-index-revision-1'
     on conflict(document_id,unit_key,corpus_revision) do nothing`,
    [corpusRevision, fixture.documentId],
  );
  await fixture.db.pool.query(
    `insert into vault_index_revisions(
       space_id,vault_id,corpus_revision,lexical_revision,graph_revision,
       context_pack_revision,status,warnings
     ) values($1,$2,$3,$3,$3,$3,'DEGRADED','[]'::jsonb)
     on conflict(space_id,vault_id) do update set
       corpus_revision=excluded.corpus_revision,
       lexical_revision=excluded.lexical_revision,
       vector_revision=null,
       graph_revision=excluded.graph_revision,
       context_pack_revision=excluded.context_pack_revision,
       status=excluded.status,
       warnings=excluded.warnings,
       updated_at=now()`,
    [fixture.spaceId, fixture.vaultId, corpusRevision],
  );
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await fixture.db.pool.query(
    `delete from vault_index_revisions where vault_id=$1`,
    [fixture.vaultId],
  );
  await fixture.db.pool.query(
    `delete from embedding_generations where vault_id=$1`,
    [fixture.vaultId],
  );
  await fixture.db.pool.query(`delete from knowledge_documents where id=$1`, [
    fixture.documentId,
  ]);
  await fixture.db.pool.query(`delete from vaults where id=$1`, [
    fixture.vaultId,
  ]);
  await fixture.db.pool.query(`delete from spaces where id=$1`, [
    fixture.spaceId,
  ]);
  await fixture.db.pool.query(`delete from organizations where id=$1`, [
    fixture.organizationId,
  ]);
  await fixture.db.pool.end();
}

describe("buildEmbeddingIndex PostgreSQL integration", () => {
  it.skipIf(!databaseUrl)(
    "builds a complete READY generation, keeps READY unactivated, and reuses content hashes",
    async () => {
      if (!databaseUrl) return;
      const fixture = await createFixture(databaseUrl);
      const provider = stubProvider({ descriptor: descriptor() });
      const revision1 = "embedding-index-revision-1";
      const revision2 = "embedding-index-revision-2";
      try {
        await prepareRevision(fixture, revision1);
        const first = await buildEmbeddingIndex(fixture.db, {
          spaceId: fixture.spaceId,
          vaultId: fixture.vaultId,
          corpusRevision: revision1,
          provider,
          activate: false,
        });

        expect(first.generation.status).toBe("READY");
        expect(first.activated).toBe(false);
        expect(first.unitCount).toBe(2);
        expect(first.embeddingsCreated).toBe(2);
        expect(first.embeddingsReused).toBe(0);
        expect(provider.calls).toBe(1);
        expect(provider.roles).toEqual(["passage"]);
        expect(
          (
            await fixture.db.pool.query(
              `select count(*)::int as count from embedding_generations
                where vault_id=$1 and status='ACTIVE'`,
              [fixture.vaultId],
            )
          ).rows[0]?.count,
        ).toBe(0);

        const persistedFirst = await fixture.db.pool.query<{
          dimensions: number;
          input_strategy: string;
          configuration_version: string;
          runtime: string;
          configuration_hash: string;
        }>(
          `select dimensions,input_strategy,configuration_version,runtime,
                  configuration_hash
             from embedding_generations where id=$1`,
          [first.generation.generationId],
        );
        expect(persistedFirst.rows[0]).toMatchObject({
          dimensions: 4,
          input_strategy: "passage-prefix-v1",
          configuration_version: "integration-test-config-v1",
          runtime: '{"backend":"integration-test","device":"cpu"}',
          configuration_hash: configurationHashForDescriptor(
            provider.descriptor,
          ),
        });

        const vectorsFirst = await fixture.db.pool.query<{
          count: number;
          dimensions: number;
        }>(
          `select count(*)::int as count,
                  min(embedding_dimensions)::int as dimensions
             from unit_embeddings where generation_id=$1`,
          [first.generation.generationId],
        );
        expect(vectorsFirst.rows[0]).toEqual({ count: 2, dimensions: 4 });

        // Calling the same revision is idempotent and does not infer again.
        const repeated = await buildEmbeddingIndex(fixture.db, {
          spaceId: fixture.spaceId,
          vaultId: fixture.vaultId,
          corpusRevision: revision1,
          provider,
          activate: false,
        });
        expect(repeated.generation.generationId).toBe(
          first.generation.generationId,
        );
        expect(repeated.generation.status).toBe("READY");
        expect(repeated.embeddingsReused).toBe(2);
        expect(repeated.embeddingsCreated).toBe(0);
        expect(provider.calls).toBe(1);

        // READY remains inactive until activation is explicitly requested.
        await prepareRevision(fixture, revision1);
        const activatedFirst = await buildEmbeddingIndex(fixture.db, {
          spaceId: fixture.spaceId,
          vaultId: fixture.vaultId,
          corpusRevision: revision1,
          provider,
          activate: true,
        });
        expect(activatedFirst.generation.status).toBe("ACTIVE");
        expect(activatedFirst.activated).toBe(true);

        // A new corpus revision creates a distinct generation, but identical
        // content_hash values are copied from the compatible prior generation.
        await prepareRevision(fixture, revision2);
        const reused = await buildEmbeddingIndex(fixture.db, {
          spaceId: fixture.spaceId,
          vaultId: fixture.vaultId,
          corpusRevision: revision2,
          provider,
          activate: false,
        });
        expect(reused.generation.generationId).not.toBe(
          first.generation.generationId,
        );
        expect(reused.generation.status).toBe("READY");
        expect(reused.embeddingsReused).toBe(2);
        expect(reused.embeddingsCreated).toBe(0);
        expect(provider.calls).toBe(1);
        expect(
          (
            await fixture.db.pool.query(
              `select count(*)::int as count from unit_embeddings
                where generation_id=$1`,
              [reused.generation.generationId],
            )
          ).rows[0]?.count,
        ).toBe(2);

        // A completed R2 build that finishes after the structural marker has
        // advanced to R3 must remain READY. It must not retire the still
        // selected R1 generation or advertise a stale vector revision.
        const revision3 = "embedding-index-revision-3";
        await prepareRevision(fixture, revision3);
        const superseded = await buildEmbeddingIndex(fixture.db, {
          spaceId: fixture.spaceId,
          vaultId: fixture.vaultId,
          corpusRevision: revision2,
          provider,
          activate: true,
        });
        expect(superseded.generation.status).toBe("READY");
        expect(superseded.activated).toBe(false);
        const activeAfterSupersededBuild = await fixture.db.pool.query<{
          id: string;
        }>(
          `select id from embedding_generations
            where vault_id=$1 and status='ACTIVE'`,
          [fixture.vaultId],
        );
        expect(activeAfterSupersededBuild.rows).toEqual([
          { id: first.generation.generationId },
        ]);
        const markerAfterSupersededBuild = await fixture.db.pool.query<{
          corpus_revision: string;
          vector_revision: string | null;
        }>(
          `select corpus_revision,vector_revision
             from vault_index_revisions
            where space_id=$1 and vault_id=$2`,
          [fixture.spaceId, fixture.vaultId],
        );
        expect(markerAfterSupersededBuild.rows[0]).toEqual({
          corpus_revision: revision3,
          vector_revision: null,
        });
      } finally {
        await cleanupFixture(fixture);
      }
    },
  );

  it.skipIf(!databaseUrl)(
    "keeps the previous ACTIVE generation during build, activates atomically, and fails safely",
    async () => {
      if (!databaseUrl) return;
      const fixture = await createFixture(databaseUrl);
      const initialProvider = stubProvider({ descriptor: descriptor() });
      const nextDescriptor = descriptor({
        dimensions: 8,
        inputStrategy: "passage-prefix-v2",
        configurationVersion: "integration-test-config-v2",
      });
      const blockingProvider = stubProvider({
        descriptor: nextDescriptor,
        blockUntilReleased: true,
      });
      const failedProvider = stubProvider({
        descriptor: descriptor({
          dimensions: 8,
          inputStrategy: "passage-prefix-v3",
          configurationVersion: "integration-test-config-failed",
        }),
        failure: new Error("TEST_PROVIDER_FAILURE"),
      });
      const wrongDimensionProvider = stubProvider({
        descriptor: descriptor({
          dimensions: 8,
          inputStrategy: "passage-prefix-v4",
          configurationVersion: "integration-test-config-wrong-dimension",
        }),
        outputDimensions: 4,
      });
      const revision1 = "embedding-index-revision-1";
      const revision2 = "embedding-index-revision-2";
      const revision3 = "embedding-index-revision-3";
      const revision4 = "embedding-index-revision-4";
      try {
        await prepareRevision(fixture, revision1);
        const initial = await buildEmbeddingIndex(fixture.db, {
          spaceId: fixture.spaceId,
          vaultId: fixture.vaultId,
          corpusRevision: revision1,
          provider: initialProvider,
          activate: true,
        });
        expect(initial.generation.status).toBe("ACTIVE");

        await prepareRevision(fixture, revision2);
        const buildingPromise = buildEmbeddingIndex(fixture.db, {
          spaceId: fixture.spaceId,
          vaultId: fixture.vaultId,
          corpusRevision: revision2,
          provider: blockingProvider,
          activate: true,
        });
        await blockingProvider.started;

        const duringBuild = await fixture.db.pool.query<{
          id: string;
          status: string;
        }>(
          `select id,status from embedding_generations
             where vault_id=$1 order by created_at asc`,
          [fixture.vaultId],
        );
        expect(duringBuild.rows).toEqual([
          { id: initial.generation.generationId, status: "ACTIVE" },
          { id: expect.any(String), status: "BUILDING" },
        ]);
        expect(
          duringBuild.rows.some(
            (row) =>
              row.id === initial.generation.generationId &&
              row.status === "ACTIVE",
          ),
        ).toBe(true);
        expect(
          (
            await fixture.db.pool.query(
              `select count(*)::int as count from embedding_generations
                where vault_id=$1 and status='ACTIVE'`,
              [fixture.vaultId],
            )
          ).rows[0]?.count,
        ).toBe(1);

        blockingProvider.release();
        const activated = await buildingPromise;
        expect(activated.generation.status).toBe("ACTIVE");
        expect(activated.generation.dimensions).toBe(8);
        expect(activated.generation.inputStrategy).toBe("passage-prefix-v2");
        expect(activated.generation.configurationVersion).toBe(
          "integration-test-config-v2",
        );
        expect(activated.generation.configurationHash).toBe(
          configurationHashForDescriptor(nextDescriptor),
        );
        expect(blockingProvider.calls).toBe(1);
        expect(blockingProvider.roles).toEqual(["passage"]);
        expect(
          (
            await fixture.db.pool.query(
              `select status from embedding_generations where id=$1`,
              [initial.generation.generationId],
            )
          ).rows[0]?.status,
        ).toBe("RETIRED");
        expect(
          (
            await fixture.db.pool.query(
              `select count(*)::int as count,
                      min(embedding_dimensions)::int as dimensions
                 from unit_embeddings where generation_id=$1`,
              [activated.generation.generationId],
            )
          ).rows[0],
        ).toEqual({ count: 2, dimensions: 8 });

        await prepareRevision(fixture, revision3);
        await expect(
          buildEmbeddingIndex(fixture.db, {
            spaceId: fixture.spaceId,
            vaultId: fixture.vaultId,
            corpusRevision: revision3,
            provider: failedProvider,
            activate: true,
          }),
        ).rejects.toThrow("TEST_PROVIDER_FAILURE");
        const failedGeneration = await fixture.db.pool.query<{
          status: string;
          failure_reason: string;
          dimensions: number;
          configuration_version: string;
        }>(
          `select status,failure_reason,dimensions,configuration_version
             from embedding_generations
            where vault_id=$1 and corpus_revision=$2`,
          [fixture.vaultId, revision3],
        );
        expect(failedGeneration.rows[0]).toMatchObject({
          status: "FAILED",
          failure_reason: "EMBEDDING_BUILD_FAILED",
          dimensions: 8,
          configuration_version: "integration-test-config-failed",
        });
        expect(
          (
            await fixture.db.pool.query(
              `select id,status from embedding_generations
                where vault_id=$1 and status='ACTIVE'`,
              [fixture.vaultId],
            )
          ).rows,
        ).toEqual([
          { id: activated.generation.generationId, status: "ACTIVE" },
        ]);

        // Provider output must match the persisted descriptor dimension. A
        // malformed generation is FAILED and cannot replace the active one.
        await prepareRevision(fixture, revision4);
        await expect(
          buildEmbeddingIndex(fixture.db, {
            spaceId: fixture.spaceId,
            vaultId: fixture.vaultId,
            corpusRevision: revision4,
            provider: wrongDimensionProvider,
            activate: true,
          }),
        ).rejects.toThrow("EMBEDDING_DIMENSION_MISMATCH");
        expect(
          (
            await fixture.db.pool.query(
              `select status from embedding_generations
                where vault_id=$1 and corpus_revision=$2`,
              [fixture.vaultId, revision4],
            )
          ).rows[0]?.status,
        ).toBe("FAILED");
        expect(
          (
            await fixture.db.pool.query(
              `select count(*)::int as count from embedding_generations
                where vault_id=$1 and status='ACTIVE'`,
              [fixture.vaultId],
            )
          ).rows[0]?.count,
        ).toBe(1);

        // Rolling the structural marker back to R1 reuses and reactivates the
        // complete matching generation; no knowledge or derived vector rows
        // need to be fabricated again.
        await prepareRevision(fixture, revision1);
        const rollback = await buildEmbeddingIndex(fixture.db, {
          spaceId: fixture.spaceId,
          vaultId: fixture.vaultId,
          corpusRevision: revision1,
          provider: initialProvider,
          activate: true,
        });
        expect(rollback.generation.generationId).toBe(
          initial.generation.generationId,
        );
        expect(rollback.generation.status).toBe("ACTIVE");
        expect(rollback.activated).toBe(true);
        expect(rollback.embeddingsCreated).toBe(0);
        expect(rollback.embeddingsReused).toBe(2);
        expect(initialProvider.calls).toBe(1);
        expect(
          (
            await fixture.db.pool.query(
              `select status from embedding_generations where id=$1`,
              [activated.generation.generationId],
            )
          ).rows[0]?.status,
        ).toBe("RETIRED");
      } finally {
        blockingProvider.release();
        await cleanupFixture(fixture);
      }
    },
  );

  it.skipIf(!databaseUrl)(
    "rejects an incomplete ACTIVE generation and rebuilds deleted derived vectors",
    async () => {
      if (!databaseUrl) return;
      const fixture = await createFixture(databaseUrl);
      const provider = stubProvider({ descriptor: descriptor() });
      const revision = "embedding-index-revision-1";
      try {
        await prepareRevision(fixture, revision);
        const initial = await buildEmbeddingIndex(fixture.db, {
          spaceId: fixture.spaceId,
          vaultId: fixture.vaultId,
          corpusRevision: revision,
          provider,
          activate: true,
        });
        expect(initial.generation.status).toBe("ACTIVE");
        expect(provider.calls).toBe(1);

        await fixture.db.pool.query(
          `delete from unit_embeddings
            where generation_id=$1 and unit_id=$2`,
          [initial.generation.generationId, fixture.unitIds[0]],
        );

        const manager = new EmbeddingGenerationManager(fixture.db);
        await expect(
          manager.markReady(initial.generation.generationId, 2, {
            spaceId: fixture.spaceId,
            vaultId: fixture.vaultId,
            corpusRevision: revision,
          }),
        ).rejects.toThrow("EMBEDDING_GENERATION_INCOMPLETE");
        await expect(
          manager.activate(initial.generation.generationId, {
            spaceId: fixture.spaceId,
            vaultId: fixture.vaultId,
            corpusRevision: revision,
          }),
        ).rejects.toThrow("EMBEDDING_GENERATION_INCOMPLETE");

        const repaired = await buildEmbeddingIndex(fixture.db, {
          spaceId: fixture.spaceId,
          vaultId: fixture.vaultId,
          corpusRevision: revision,
          provider,
          activate: true,
        });
        expect(repaired.generation.generationId).toBe(
          initial.generation.generationId,
        );
        expect(repaired.generation.status).toBe("ACTIVE");
        expect(repaired.embeddingsReused).toBe(1);
        expect(repaired.embeddingsCreated).toBe(1);
        expect(provider.calls).toBe(2);
        expect(
          (
            await fixture.db.pool.query(
              `select count(*)::int count from unit_embeddings
                where generation_id=$1`,
              [initial.generation.generationId],
            )
          ).rows[0]?.count,
        ).toBe(2);

        const partial = await manager.request({
          spaceId: fixture.spaceId,
          vaultId: fixture.vaultId,
          corpusRevision: revision,
          descriptor: descriptor({
            configurationVersion: "integration-test-partial-v1",
          }),
        });
        await manager.beginBuild(partial.generationId);
        await manager.writeEmbedding({
          generationId: partial.generationId,
          unitId: fixture.unitIds[0] as string,
          contentHash: fixture.unitHashes[0] as string,
          embedding: vector(4, 0.5),
        });
        await expect(manager.markReady(partial.generationId)).rejects.toThrow(
          "EMBEDDING_GENERATION_INCOMPLETE",
        );
      } finally {
        await cleanupFixture(fixture);
      }
    },
  );
});
