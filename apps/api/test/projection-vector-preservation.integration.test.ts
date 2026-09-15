import { createServer, type AddressInfo, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Postgres } from "@akp/postgres";
import { rebuildSpaceProjections } from "../src/projections.js";

const databaseUrl = process.env.DATABASE_URL;

interface Fixture {
  db: Postgres;
  organizationId: string;
  spaceId: string;
  vaultId: string;
  documentId: string;
}

interface GenerationRow {
  id: string;
  corpus_revision: string;
  provider: string;
  status: string;
}

interface VectorRow {
  id: string;
  unit_id: string;
  content_hash: string;
  embedding: string;
  embedding_dimensions: number;
}

const environmentKeys = [
  "NODE_ENV",
  "AKP_VECTOR_ENABLED",
  "AKP_EMBEDDING_PROVIDER",
  "AKP_EMBEDDING_BASE_URL",
  "AKP_EMBEDDING_MODEL",
  "AKP_EMBEDDING_MODEL_REVISION",
  "AKP_EMBEDDING_DIMENSIONS",
  "AKP_EMBEDDING_NORMALIZATION",
  "AKP_EMBEDDING_INPUT_STRATEGY",
  "AKP_EMBEDDING_CONFIGURATION_VERSION",
  "AKP_EMBEDDING_TIMEOUT_MS",
  "AKP_EMBEDDING_MAX_RETRIES",
] as const;

type EnvironmentKey = (typeof environmentKeys)[number];

function rememberEnvironment(): Map<EnvironmentKey, string | undefined> {
  return new Map(
    environmentKeys.map((key) => [key, process.env[key]] as const),
  );
}

function restoreEnvironment(
  previous: Map<EnvironmentKey, string | undefined>,
): void {
  for (const key of environmentKeys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function useDeterministicProvider(): void {
  process.env.NODE_ENV = "test";
  process.env.AKP_VECTOR_ENABLED = "true";
  process.env.AKP_EMBEDDING_PROVIDER = "deterministic-test";
  delete process.env.AKP_EMBEDDING_BASE_URL;
  delete process.env.AKP_EMBEDDING_MODEL;
  delete process.env.AKP_EMBEDDING_MODEL_REVISION;
  delete process.env.AKP_EMBEDDING_DIMENSIONS;
  delete process.env.AKP_EMBEDDING_NORMALIZATION;
  delete process.env.AKP_EMBEDDING_INPUT_STRATEGY;
  delete process.env.AKP_EMBEDDING_CONFIGURATION_VERSION;
  delete process.env.AKP_EMBEDDING_TIMEOUT_MS;
  delete process.env.AKP_EMBEDDING_MAX_RETRIES;
}

function useFailingOpenAIProvider(baseUrl: string): void {
  process.env.NODE_ENV = "test";
  process.env.AKP_VECTOR_ENABLED = "true";
  process.env.AKP_EMBEDDING_PROVIDER = "openai-compatible";
  process.env.AKP_EMBEDDING_BASE_URL = baseUrl;
  process.env.AKP_EMBEDDING_MODEL = "projection-preservation-failure-model";
  process.env.AKP_EMBEDDING_MODEL_REVISION =
    "projection-preservation-failure-v1";
  process.env.AKP_EMBEDDING_DIMENSIONS = "64";
  process.env.AKP_EMBEDDING_NORMALIZATION = "provider-defined";
  process.env.AKP_EMBEDDING_INPUT_STRATEGY = "none";
  process.env.AKP_EMBEDDING_CONFIGURATION_VERSION =
    "projection-preservation-failure-config-v1";
  process.env.AKP_EMBEDDING_TIMEOUT_MS = "1000";
  process.env.AKP_EMBEDDING_MAX_RETRIES = "0";
}

async function createFixture(databaseUrlValue: string): Promise<Fixture> {
  const db = new Postgres(databaseUrlValue);
  const organizationId = randomUUID();
  const spaceId = randomUUID();
  const vaultId = randomUUID();
  const documentId = randomUUID();
  const canonicalPath = `C:/akp/projection-preservation-${vaultId}`;

  await db.pool.query(
    `insert into organizations(id,slug,name) values($1,$2,$3)`,
    [
      organizationId,
      `pv-${organizationId.slice(0, 8)}`,
      "Projection preservation test",
    ],
  );
  await db.pool.query(
    `insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values($1,$2,$3,$4,'PRIVATE',$5)`,
    [
      spaceId,
      organizationId,
      `pv-${spaceId.slice(0, 8)}`,
      "Projection preservation test space",
      canonicalPath,
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
      canonicalPath,
      "Projection preservation test vault",
      "projection-vault-revision-1",
      `pv-${vaultId.slice(0, 8)}`,
    ],
  );
  await db.pool.query(
    `insert into knowledge_documents(
       id,space_id,vault_id,path,external_id,title,type,lifecycle,
       trust_tier,current_revision,body_cache,frontmatter,aliases,layer,
       content_hash,token_estimate,raw_links
     ) values($1,$2,$3,$4,$5,$6,'note','ACTIVE','CURATED',$7,$8,$9,'{}',$10,$11,32,'[]'::jsonb)`,
    [
      documentId,
      spaceId,
      vaultId,
      "managed/projection-preservation.md",
      "PROJECTION-PRESERVATION",
      "Projection preservation fixture",
      "projection-vault-revision-1",
      "# Projection preservation fixture\n\nThis durable paragraph proves that a failed projection rebuild leaves the active semantic generation and its vectors queryable.\n\nA second paragraph gives the successful rebuild a complete corpus to activate.",
      JSON.stringify({ id: "PROJECTION-PRESERVATION", type: "note" }),
      "reference",
      "a".repeat(64),
    ],
  );

  return { db, organizationId, spaceId, vaultId, documentId };
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await fixture.db.pool.query(
    "delete from vault_index_revisions where vault_id=$1",
    [fixture.vaultId],
  );
  await fixture.db.pool.query(
    "delete from embedding_generations where vault_id=$1",
    [fixture.vaultId],
  );
  await fixture.db.pool.query("delete from knowledge_documents where id=$1", [
    fixture.documentId,
  ]);
  await fixture.db.pool.query("delete from vaults where id=$1", [
    fixture.vaultId,
  ]);
  await fixture.db.pool.query("delete from spaces where id=$1", [
    fixture.spaceId,
  ]);
  await fixture.db.pool.query("delete from organizations where id=$1", [
    fixture.organizationId,
  ]);
  await fixture.db.pool.end();
}

async function createFailingEmbeddingServer(): Promise<{
  server: Server;
  baseUrl: string;
}> {
  const server = createServer((_request, response) => {
    response.statusCode = 503;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        error: { message: "controlled projection provider failure" },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  if (!address) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Could not determine the controlled provider port.");
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function readGenerations(fixture: Fixture): Promise<GenerationRow[]> {
  return (
    await fixture.db.pool.query<GenerationRow>(
      `select id,corpus_revision,provider,status
         from embedding_generations
        where space_id=$1 and vault_id=$2
        order by created_at,id`,
      [fixture.spaceId, fixture.vaultId],
    )
  ).rows;
}

async function readVectors(
  fixture: Fixture,
  generationId: string,
): Promise<VectorRow[]> {
  return (
    await fixture.db.pool.query<VectorRow>(
      `select id,unit_id,content_hash,embedding::text embedding,embedding_dimensions
         from unit_embeddings
        where generation_id=$1
        order by id`,
      [generationId],
    )
  ).rows;
}

describe("rebuildSpaceProjections vector generation preservation", () => {
  it.skipIf(!databaseUrl)(
    "keeps the active vectors on provider failure and atomically switches on a later success",
    async () => {
      if (!databaseUrl) return;
      const previousEnvironment = rememberEnvironment();
      const fixture = await createFixture(databaseUrl);
      let failingServer: Server | undefined;
      try {
        useDeterministicProvider();
        const first = await rebuildSpaceProjections(
          fixture.db,
          fixture.spaceId,
          fixture.vaultId,
          "managed-projection-revision-1",
        );
        expect(first.unitCount).toBeGreaterThan(0);

        const firstGenerations = await readGenerations(fixture);
        expect(firstGenerations).toHaveLength(1);
        const previousActive = firstGenerations[0];
        expect(previousActive).toMatchObject({
          provider: "local-deterministic",
          status: "ACTIVE",
        });
        if (!previousActive)
          throw new Error("Missing initial active generation");
        const vectorsBeforeFailure = await readVectors(
          fixture,
          previousActive.id,
        );
        expect(vectorsBeforeFailure.length).toBeGreaterThan(0);

        const failure = await createFailingEmbeddingServer();
        failingServer = failure.server;
        useFailingOpenAIProvider(failure.baseUrl);

        const failed = await rebuildSpaceProjections(
          fixture.db,
          fixture.spaceId,
          fixture.vaultId,
          "managed-projection-revision-2",
        );
        expect(failed.unitCount).toBe(first.unitCount);

        const afterFailure = await readGenerations(fixture);
        const failedGeneration = afterFailure.find(
          (generation) => generation.provider === "openai-compatible-http",
        );
        expect(failedGeneration).toMatchObject({ status: "FAILED" });
        expect(afterFailure).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: previousActive.id,
              status: "ACTIVE",
            }),
          ]),
        );
        expect(
          afterFailure.filter((generation) => generation.status === "ACTIVE"),
        ).toHaveLength(1);
        expect(await readVectors(fixture, previousActive.id)).toEqual(
          vectorsBeforeFailure,
        );
        const markerAfterFailure = await fixture.db.pool.query<{
          corpus_revision: string;
          vector_revision: string | null;
          status: string;
          warnings: string[];
        }>(
          `select corpus_revision,vector_revision,status,warnings
             from vault_index_revisions
            where space_id=$1 and vault_id=$2`,
          [fixture.spaceId, fixture.vaultId],
        );
        expect(markerAfterFailure.rows[0]).toEqual({
          corpus_revision: failed.corpusRevision,
          vector_revision: first.corpusRevision,
          status: "DEGRADED",
          warnings: ["VECTOR_BUILD_FAILED"],
        });

        useDeterministicProvider();
        const successful = await rebuildSpaceProjections(
          fixture.db,
          fixture.spaceId,
          fixture.vaultId,
          "managed-projection-revision-3",
        );
        expect(successful.unitCount).toBe(first.unitCount);

        const afterSuccess = await readGenerations(fixture);
        const activeGenerations = afterSuccess.filter(
          (generation) => generation.status === "ACTIVE",
        );
        expect(activeGenerations).toHaveLength(1);
        const nextActive = activeGenerations[0];
        expect(nextActive).toMatchObject({
          provider: "local-deterministic",
          status: "ACTIVE",
        });
        expect(nextActive?.id).not.toBe(previousActive.id);
        expect(
          afterSuccess.find(
            (generation) => generation.id === previousActive.id,
          ),
        ).toMatchObject({ status: "RETIRED" });
        expect(
          afterSuccess.find(
            (generation) => generation.provider === "openai-compatible-http",
          ),
        ).toMatchObject({ status: "FAILED" });
        expect(nextActive).toBeDefined();
        if (!nextActive)
          throw new Error("Missing replacement active generation");
        expect(await readVectors(fixture, nextActive.id)).toHaveLength(
          vectorsBeforeFailure.length,
        );

        // Retiring a generation is a selection change, not data deletion: the
        // previous vectors remain available for rollback/audit after success.
        expect(await readVectors(fixture, previousActive.id)).toEqual(
          vectorsBeforeFailure,
        );
        const revision = await fixture.db.pool.query<{
          vector_revision: string | null;
          status: string;
        }>(
          `select vector_revision,status from vault_index_revisions
            where space_id=$1 and vault_id=$2`,
          [fixture.spaceId, fixture.vaultId],
        );
        expect(revision.rows[0]?.vector_revision).toBe(
          successful.corpusRevision,
        );
        expect(revision.rows[0]?.status).toBe("CONSISTENT");
      } finally {
        restoreEnvironment(previousEnvironment);
        if (failingServer) {
          await new Promise<void>((resolve) =>
            failingServer?.close(() => resolve()),
          );
        }
        await cleanupFixture(fixture);
      }
    },
  );
});
