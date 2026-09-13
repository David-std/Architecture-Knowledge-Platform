import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Postgres } from "@akp/postgres";
import { importVaultReadOnly } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const spaceId = "00000000-0000-0000-0000-000000000003";
const vaultKey = `p1-importer-${randomUUID().slice(0, 8)}`;

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

let db: Postgres | undefined;
let fixtureRoot: string | undefined;
let vaultId: string | undefined;
let originalIndexRevision: Record<string, unknown> | undefined;

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
  for (const key of environmentKeys.slice(3)) delete process.env[key];
}

function useFailingOpenAIProvider(baseUrl: string): void {
  process.env.NODE_ENV = "test";
  process.env.AKP_VECTOR_ENABLED = "true";
  process.env.AKP_EMBEDDING_PROVIDER = "openai-compatible";
  process.env.AKP_EMBEDDING_BASE_URL = baseUrl;
  process.env.AKP_EMBEDDING_MODEL = "p1-importer-failure-model";
  process.env.AKP_EMBEDDING_MODEL_REVISION = "p1-importer-failure-v1";
  process.env.AKP_EMBEDDING_DIMENSIONS = "64";
  process.env.AKP_EMBEDDING_NORMALIZATION = "provider-defined";
  process.env.AKP_EMBEDDING_INPUT_STRATEGY = "none";
  process.env.AKP_EMBEDDING_CONFIGURATION_VERSION =
    "p1-importer-failure-config-v1";
  process.env.AKP_EMBEDDING_TIMEOUT_MS = "1000";
  process.env.AKP_EMBEDDING_MAX_RETRIES = "0";
}

function useBlockingOpenAIProvider(baseUrl: string): void {
  process.env.NODE_ENV = "test";
  process.env.AKP_VECTOR_ENABLED = "true";
  process.env.AKP_EMBEDDING_PROVIDER = "openai-compatible";
  process.env.AKP_EMBEDDING_BASE_URL = baseUrl;
  process.env.AKP_EMBEDDING_MODEL = "p1-importer-race-model";
  process.env.AKP_EMBEDDING_MODEL_REVISION = "p1-importer-race-v1";
  process.env.AKP_EMBEDDING_DIMENSIONS = "64";
  process.env.AKP_EMBEDDING_NORMALIZATION = "provider-defined";
  process.env.AKP_EMBEDDING_INPUT_STRATEGY = "none";
  process.env.AKP_EMBEDDING_CONFIGURATION_VERSION =
    "p1-importer-race-config-v1";
  process.env.AKP_EMBEDDING_TIMEOUT_MS = "10000";
  process.env.AKP_EMBEDDING_MAX_RETRIES = "0";
}

async function createFailingEmbeddingServer(): Promise<{
  server: Server;
  baseUrl: string;
  setAvailable: (available: boolean) => void;
}> {
  let available = false;
  const server = createServer((_request, response) => {
    if (!available) {
      response.statusCode = 503;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          error: { message: "controlled importer provider failure" },
        }),
      );
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        data: [
          {
            index: 0,
            embedding: [1, ...Array.from({ length: 63 }, () => 0)],
          },
        ],
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
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    setAvailable: (value) => {
      available = value;
    },
  };
}

async function createBlockingEmbeddingServer(): Promise<{
  server: Server;
  baseUrl: string;
  requestStarted: Promise<void>;
  release: () => void;
}> {
  let resolveRequestStarted!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    resolveRequestStarted = resolve;
  });
  let releaseResponse!: () => void;
  const responseReleased = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });

  const server = createServer((request, response) => {
    request.setEncoding("utf8");
    const chunks: string[] = [];
    request.on("data", (chunk: string) => chunks.push(chunk));
    request.on("end", () => {
      resolveRequestStarted();
      void (async () => {
        await responseReleased;
        let count = 1;
        try {
          const body = JSON.parse(chunks.join("")) as {
            input?: unknown;
          };
          if (Array.isArray(body.input) && body.input.length > 0) {
            count = body.input.length;
          }
        } catch {
          // The provider adapter reports malformed responses; this test only
          // needs the response to remain blocked until the race is arranged.
        }
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            data: Array.from({ length: count }, (_, index) => ({
              index,
              embedding: [1, ...Array.from({ length: 63 }, () => 0)],
            })),
          }),
        );
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  if (!address) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Could not determine the blocking provider port.");
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestStarted,
    release: releaseResponse,
  };
}

const integration = describe.skipIf(!databaseUrl);

integration("vault importer semantic generation integration", () => {
  const previousEnvironment = rememberEnvironment();

  beforeAll(async () => {
    if (!databaseUrl) return;
    db = new Postgres(databaseUrl);
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "akp-importer-p1-"));
    await writeFile(
      path.join(fixtureRoot, "semantic-note.md"),
      [
        "---",
        "id: CLM-P1-IMPORT-001",
        "type: claim",
        "layer: claim",
        "status: active",
        "---",
        "# Semantic import fixture",
        "",
        "A durable paragraph is imported as an embedding-eligible unit for the explicit provider test.",
      ].join("\n"),
      "utf8",
    );
    const prior = await db.pool.query(
      `select space_id,corpus_revision,lexical_revision,vector_revision,
              graph_revision,context_pack_revision,retrieval_configuration_version,
              status,warnings,updated_at
         from index_revisions where space_id=$1`,
      [spaceId],
    );
    originalIndexRevision = prior.rows[0] as
      Record<string, unknown> | undefined;
  });

  afterAll(async () => {
    try {
      if (db) {
        const registered = await db.pool.query<{ id: string }>(
          "select id from vaults where vault_key=$1",
          [vaultKey],
        );
        vaultId ??= registered.rows[0]?.id;
        if (vaultId) {
          await db.pool.query(
            `delete from knowledge_relations
              where space_id=$1
                and (from_document_id in (select id from knowledge_documents where vault_id=$2)
                  or to_document_id in (select id from knowledge_documents where vault_id=$2))`,
            [spaceId, vaultId],
          );
          await db.pool.query(
            `delete from knowledge_versions
              where document_id in (select id from knowledge_documents where vault_id=$1)`,
            [vaultId],
          );
          await db.pool.query(
            "delete from unit_embeddings where generation_id in (select id from embedding_generations where vault_id=$1)",
            [vaultId],
          );
          await db.pool.query("delete from knowledge_units where vault_id=$1", [
            vaultId,
          ]);
          await db.pool.query(
            "delete from knowledge_documents where vault_id=$1",
            [vaultId],
          );
          await db.pool.query(
            "delete from vault_import_runs where vault_id=$1",
            [vaultId],
          );
          await db.pool.query(
            "delete from vault_index_revisions where vault_id=$1",
            [vaultId],
          );
          await db.pool.query(
            "delete from embedding_generations where vault_id=$1",
            [vaultId],
          );
          await db.pool.query("delete from vaults where id=$1", [vaultId]);
        }
        if (originalIndexRevision) {
          await db.pool.query(
            `insert into index_revisions(
                space_id,corpus_revision,lexical_revision,vector_revision,
                graph_revision,context_pack_revision,retrieval_configuration_version,
                status,warnings,updated_at
             ) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
             on conflict(space_id) do update set
                corpus_revision=excluded.corpus_revision,
                lexical_revision=excluded.lexical_revision,
                vector_revision=excluded.vector_revision,
                graph_revision=excluded.graph_revision,
                context_pack_revision=excluded.context_pack_revision,
                retrieval_configuration_version=excluded.retrieval_configuration_version,
                status=excluded.status,warnings=excluded.warnings,
                updated_at=excluded.updated_at`,
            [
              originalIndexRevision.space_id,
              originalIndexRevision.corpus_revision,
              originalIndexRevision.lexical_revision,
              originalIndexRevision.vector_revision,
              originalIndexRevision.graph_revision,
              originalIndexRevision.context_pack_revision,
              originalIndexRevision.retrieval_configuration_version,
              originalIndexRevision.status,
              JSON.stringify(originalIndexRevision.warnings ?? []),
              originalIndexRevision.updated_at,
            ],
          );
        } else {
          await db.pool.query("delete from index_revisions where space_id=$1", [
            spaceId,
          ]);
        }
        await db.close();
      }
    } finally {
      restoreEnvironment(previousEnvironment);
      if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("preserves snapshots and active vectors across retries, outages, and vault scopes", async () => {
    if (!db || !fixtureRoot)
      throw new Error("integration fixture was not initialized");

    process.env.NODE_ENV = "test";
    delete process.env.AKP_EMBEDDING_PROVIDER;
    process.env.AKP_VECTOR_ENABLED = "false";
    const disabled = await importVaultReadOnly(db, fixtureRoot, {
      spaceId,
      vaultKey,
    });
    vaultId = disabled.vaultId;

    const noProviderGeneration = await db.pool.query(
      "select id from embedding_generations where vault_id=$1",
      [vaultId],
    );
    expect(noProviderGeneration.rows).toHaveLength(0);
    const disabledRevision = await db.pool.query<{
      vector_revision: string | null;
      status: string;
      warnings: string[];
    }>(
      "select vector_revision,status,warnings from vault_index_revisions where space_id=$1 and vault_id=$2",
      [spaceId, vaultId],
    );
    expect(disabledRevision.rows[0]).toMatchObject({
      vector_revision: null,
      status: "DEGRADED",
    });
    expect(disabledRevision.rows[0]?.warnings).toContain(
      "VECTOR_DISABLED_PENDING_BENCHMARK",
    );

    process.env.AKP_EMBEDDING_PROVIDER = "deterministic-test";
    process.env.AKP_VECTOR_ENABLED = "true";
    const enabled = await importVaultReadOnly(db, fixtureRoot, {
      spaceId,
      vaultKey,
    });
    expect(enabled.vaultId).toBe(vaultId);

    const generation = await db.pool.query<{
      id: string;
      provider: string;
      dimensions: number;
      input_strategy: string;
      runtime: string;
      configuration_hash: string;
      status: string;
      corpus_revision: string;
    }>(
      `select id,provider,dimensions,input_strategy,runtime,configuration_hash,
              status,corpus_revision
         from embedding_generations where vault_id=$1`,
      [vaultId],
    );
    expect(generation.rows).toHaveLength(1);
    expect(generation.rows[0]).toMatchObject({
      provider: "local-deterministic",
      dimensions: 64,
      input_strategy: "deterministic-token-hash-v1",
      runtime: "node:crypto/sha256",
      status: "ACTIVE",
    });
    expect(generation.rows[0]?.configuration_hash).toMatch(/^[a-f0-9]{64}$/);

    const generationId = generation.rows[0]?.id;
    const counts = await db.pool.query<{ expected: number; actual: number }>(
      `select
         (select count(*)::int from knowledge_units
           where space_id=$1 and vault_id=$2 and corpus_revision=$3
             and embedding_eligible=true) expected,
         (select count(*)::int from unit_embeddings where generation_id=$4) actual`,
      [spaceId, vaultId, `vault:${vaultId}:${enabled.revision}`, generationId],
    );
    expect(counts.rows[0]?.expected).toBeGreaterThan(0);
    expect(counts.rows[0]?.actual).toBe(counts.rows[0]?.expected);

    const dimensions = await db.pool.query<{ dimensions: number }>(
      `select distinct embedding_dimensions as dimensions
         from unit_embeddings where generation_id=$1`,
      [generationId],
    );
    expect(dimensions.rows.map((row) => Number(row.dimensions))).toEqual([64]);

    const activeRevision = await db.pool.query<{
      vector_revision: string | null;
      status: string;
      warnings: string[];
    }>(
      "select vector_revision,status,warnings from vault_index_revisions where space_id=$1 and vault_id=$2",
      [spaceId, vaultId],
    );
    expect(activeRevision.rows[0]).toMatchObject({
      vector_revision: `vault:${vaultId}:${enabled.revision}`,
      status: "CONSISTENT",
      warnings: [],
    });

    const firstRevision = enabled.revision;
    const firstUnitCount = await db.pool.query<{ count: number }>(
      "select count(*)::int as count from knowledge_units where space_id=$1 and vault_id=$2",
      [spaceId, vaultId],
    );
    const firstVersionCount = await db.pool.query<{ count: number }>(
      `select count(*)::int as count
         from knowledge_versions v
         join knowledge_documents d on d.id=v.document_id
        where d.space_id=$1 and d.vault_id=$2`,
      [spaceId, vaultId],
    );
    const firstVectorCount = await db.pool.query<{ count: number }>(
      "select count(*)::int as count from unit_embeddings where generation_id=$1",
      [generationId],
    );

    // A byte-for-byte retry must update neither the historical snapshot nor
    // the active generation's vector rows.
    const retried = await importVaultReadOnly(db, fixtureRoot, {
      spaceId,
      vaultKey,
    });
    expect(retried).toMatchObject({ vaultId, status: "COMPLETED" });
    const retryGeneration = await db.pool.query<{
      id: string;
      status: string;
    }>("select id,status from embedding_generations where vault_id=$1", [
      vaultId,
    ]);
    expect(retryGeneration.rows).toEqual([
      expect.objectContaining({ id: generationId, status: "ACTIVE" }),
    ]);
    expect(
      Number(
        (
          await db.pool.query<{ count: number }>(
            "select count(*)::int as count from knowledge_units where space_id=$1 and vault_id=$2",
            [spaceId, vaultId],
          )
        ).rows[0]?.count,
      ),
    ).toBe(Number(firstUnitCount.rows[0]?.count));
    expect(
      Number(
        (
          await db.pool.query<{ count: number }>(
            `select count(*)::int as count
               from knowledge_versions v
               join knowledge_documents d on d.id=v.document_id
              where d.space_id=$1 and d.vault_id=$2`,
            [spaceId, vaultId],
          )
        ).rows[0]?.count,
      ),
    ).toBe(Number(firstVersionCount.rows[0]?.count));
    expect(
      Number(
        (
          await db.pool.query<{ count: number }>(
            "select count(*)::int as count from unit_embeddings where generation_id=$1",
            [generationId],
          )
        ).rows[0]?.count,
      ),
    ).toBe(Number(firstVectorCount.rows[0]?.count));

    // A vault key cannot be used to mutate a vault in another space. The
    // conflict is rejected before a run or document is written there.
    const isolatedOrganizationId = randomUUID();
    const isolatedSpaceId = randomUUID();
    await db.pool.query(
      "insert into organizations(id,slug,name) values($1,$2,$3)",
      [
        isolatedOrganizationId,
        `p1-org-${isolatedOrganizationId.slice(0, 8)}`,
        "P1 importer isolation organization",
      ],
    );
    await db.pool.query(
      `insert into spaces(
         id,organization_id,slug,name,visibility,knowledge_repo_path
       ) values($1,$2,$3,$4,'PRIVATE',$5)`,
      [
        isolatedSpaceId,
        isolatedOrganizationId,
        `p1-space-${isolatedSpaceId.slice(0, 8)}`,
        "P1 importer isolation space",
        fixtureRoot,
      ],
    );
    try {
      await expect(
        importVaultReadOnly(db, fixtureRoot, {
          spaceId: isolatedSpaceId,
          vaultKey,
        }),
      ).rejects.toThrow("VAULT_KEY_SCOPE_CONFLICT");
      const originalVault = await db.pool.query<{
        space_id: string;
        canonical_path: string;
      }>("select space_id,canonical_path from vaults where id=$1", [vaultId]);
      expect(originalVault.rows[0]).toMatchObject({
        space_id: spaceId,
        canonical_path: expect.any(String),
      });
    } finally {
      await db.pool.query("delete from spaces where id=$1", [isolatedSpaceId]);
      await db.pool.query("delete from organizations where id=$1", [
        isolatedOrganizationId,
      ]);
    }

    const semanticPath = path.join(fixtureRoot, "semantic-note.md");
    await writeFile(
      semanticPath,
      [
        "---",
        "id: CLM-P1-IMPORT-001",
        "type: claim",
        "layer: claim",
        "status: active",
        "---",
        "# Semantic import fixture",
        "",
        "A changed paragraph creates a new durable snapshot while the previous active vectors remain usable.",
      ].join("\n"),
      "utf8",
    );
    delete process.env.AKP_EMBEDDING_PROVIDER;
    process.env.AKP_VECTOR_ENABLED = "true";
    const structuralOnly = await importVaultReadOnly(db, fixtureRoot, {
      spaceId,
      vaultKey,
    });
    expect(structuralOnly.revision).not.toBe(firstRevision);
    expect(structuralOnly.status).toBe("COMPLETED_WITH_WARNINGS");
    const afterStructuralOnly = await db.pool.query<{
      unit_count: number;
      version_count: number;
    }>(
      `select
         (select count(*)::int from knowledge_units where space_id=$1 and vault_id=$2) unit_count,
         (select count(*)::int from knowledge_versions v
           join knowledge_documents d on d.id=v.document_id
          where d.space_id=$1 and d.vault_id=$2) version_count`,
      [spaceId, vaultId],
    );
    expect(Number(afterStructuralOnly.rows[0]?.unit_count)).toBeGreaterThan(
      Number(firstUnitCount.rows[0]?.count),
    );
    expect(Number(afterStructuralOnly.rows[0]?.version_count)).toBeGreaterThan(
      Number(firstVersionCount.rows[0]?.count),
    );
    expect(
      Number(
        (
          await db.pool.query<{ count: number }>(
            "select count(*)::int as count from unit_embeddings where generation_id=$1",
            [generationId],
          )
        ).rows[0]?.count,
      ),
    ).toBe(Number(firstVectorCount.rows[0]?.count));
    const structuralMarker = await db.pool.query<{
      vector_revision: string | null;
      status: string;
      warnings: string[];
    }>(
      "select vector_revision,status,warnings from vault_index_revisions where space_id=$1 and vault_id=$2",
      [spaceId, vaultId],
    );
    expect(structuralMarker.rows[0]).toMatchObject({
      vector_revision: `vault:${vaultId}:${firstRevision}`,
      status: "DEGRADED",
    });
    expect(structuralMarker.rows[0]?.warnings).toContain(
      "VECTOR_PROVIDER_NOT_CONFIGURED",
    );
    expect(
      (
        await db.pool.query<{ status: string }>(
          "select status from embedding_generations where id=$1",
          [generationId],
        )
      ).rows[0]?.status,
    ).toBe("ACTIVE");

    const failing = await createFailingEmbeddingServer();
    try {
      useFailingOpenAIProvider(failing.baseUrl);
      const failed = await importVaultReadOnly(db, fixtureRoot, {
        spaceId,
        vaultKey,
      });
      expect(failed.status).toBe("COMPLETED_WITH_WARNINGS");
      const generationsAfterFailure = await db.pool.query<{
        id: string;
        provider: string;
        status: string;
        corpus_revision: string;
      }>(
        `select id,provider,status,corpus_revision
           from embedding_generations where space_id=$1 and vault_id=$2
          order by created_at,id`,
        [spaceId, vaultId],
      );
      expect(
        generationsAfterFailure.rows.find(
          (row) => row.provider === "openai-compatible-http",
        ),
      ).toMatchObject({ status: "FAILED" });
      const failureReason = await db.pool.query<{
        failure_reason: string | null;
      }>(
        `select failure_reason from embedding_generations
          where space_id=$1 and vault_id=$2 and provider='openai-compatible-http'`,
        [spaceId, vaultId],
      );
      expect(failureReason.rows[0]?.failure_reason).toContain("HTTP 503");
      expect(failureReason.rows[0]?.failure_reason).not.toMatch(
        /Bearer|api[_ -]?key|authorization|secret|password|token/i,
      );
      expect(
        generationsAfterFailure.rows.find((row) => row.id === generationId),
      ).toMatchObject({ status: "ACTIVE" });
      const failureMarker = await db.pool.query<{
        vector_revision: string | null;
        status: string;
        warnings: string[];
      }>(
        "select vector_revision,status,warnings from vault_index_revisions where space_id=$1 and vault_id=$2",
        [spaceId, vaultId],
      );
      expect(failureMarker.rows[0]).toMatchObject({
        vector_revision: `vault:${vaultId}:${firstRevision}`,
        status: "DEGRADED",
      });
      expect(failureMarker.rows[0]?.warnings).toContain("VECTOR_BUILD_FAILED");
      const failureIssue = await db.pool.query<{
        severity: string;
        code: string;
      }>(
        `select severity,code from vault_import_issues
          where run_id=$1 and code='VECTOR_BUILD_FAILED'`,
        [failed.runId],
      );
      expect(failureIssue.rows).toEqual([
        { severity: "warning", code: "VECTOR_BUILD_FAILED" },
      ]);
      expect(
        Number(
          (
            await db.pool.query<{ count: number }>(
              "select count(*)::int as count from unit_embeddings where generation_id=$1",
              [generationId],
            )
          ).rows[0]?.count,
        ),
      ).toBe(Number(firstVectorCount.rows[0]?.count));

      // The same descriptor retries the FAILED generation, completes it, and
      // activates it only after the full current snapshot is covered.
      failing.setAvailable(true);
      const recovered = await importVaultReadOnly(db, fixtureRoot, {
        spaceId,
        vaultKey,
      });
      expect(recovered.status).toBe("COMPLETED");
      const recoveredGenerations = await db.pool.query<{
        id: string;
        provider: string;
        status: string;
        corpus_revision: string;
      }>(
        `select id,provider,status,corpus_revision
           from embedding_generations where space_id=$1 and vault_id=$2
          order by created_at,id`,
        [spaceId, vaultId],
      );
      expect(
        recoveredGenerations.rows.filter((row) => row.status === "ACTIVE"),
      ).toHaveLength(1);
      expect(
        recoveredGenerations.rows.find(
          (row) => row.provider === "openai-compatible-http",
        ),
      ).toMatchObject({ status: "ACTIVE" });
      expect(
        recoveredGenerations.rows.find((row) => row.id === generationId),
      ).toMatchObject({ status: "RETIRED" });
      const recoveredMarker = await db.pool.query<{
        vector_revision: string | null;
        status: string;
        warnings: string[];
      }>(
        "select vector_revision,status,warnings from vault_index_revisions where space_id=$1 and vault_id=$2",
        [spaceId, vaultId],
      );
      expect(recoveredMarker.rows[0]).toMatchObject({
        vector_revision: `vault:${vaultId}:${recovered.revision}`,
        status: "CONSISTENT",
        warnings: [],
      });
      const activeGenerationId = recoveredGenerations.rows.find(
        (row) => row.status === "ACTIVE",
      )?.id;
      expect(activeGenerationId).toBeDefined();
      const recoveredCount = await db.pool.query<{
        expected: number;
        actual: number;
      }>(
        `select
           (select count(*)::int from knowledge_units
             where space_id=$1 and vault_id=$2 and corpus_revision=$3
               and embedding_eligible=true and lifecycle in ('ACTIVE','DISPUTED')) expected,
           (select count(*)::int from unit_embeddings where generation_id=$4) actual`,
        [
          spaceId,
          vaultId,
          `vault:${vaultId}:${recovered.revision}`,
          activeGenerationId,
        ],
      );
      expect(Number(recoveredCount.rows[0]?.actual)).toBe(
        Number(recoveredCount.rows[0]?.expected),
      );

      // A slow R1 inference must not retire the active R0 generation or
      // overwrite a marker that a newer structural import (R2) selected
      // while the provider request was in flight.
      const racePath = path.join(fixtureRoot, "semantic-note.md");
      await writeFile(
        racePath,
        [
          "---",
          "id: CLM-P1-IMPORT-001",
          "type: claim",
          "layer: claim",
          "status: active",
          "---",
          "# Semantic import race fixture",
          "",
          "R1 is structurally committed before its provider response is released.",
        ].join("\n"),
        "utf8",
      );
      const blocking = await createBlockingEmbeddingServer();
      try {
        useBlockingOpenAIProvider(blocking.baseUrl);
        const r1Import = importVaultReadOnly(db, fixtureRoot, {
          spaceId,
          vaultKey,
        });
        await blocking.requestStarted;

        const r1Marker = await db.pool.query<{
          corpus_revision: string;
          vector_revision: string | null;
        }>(
          `select corpus_revision,vector_revision
             from vault_index_revisions
            where space_id=$1 and vault_id=$2`,
          [spaceId, vaultId],
        );
        expect(r1Marker.rows[0]).toMatchObject({
          corpus_revision: expect.stringContaining("vault:"),
          vector_revision: recoveredMarker.rows[0]?.vector_revision,
        });
        const r1Revision = r1Marker.rows[0]?.corpus_revision;
        expect(r1Revision).toBeDefined();

        const r1Generation = await db.pool.query<{
          id: string;
          status: string;
          corpus_revision: string;
        }>(
          `select id,status,corpus_revision
             from embedding_generations
            where space_id=$1 and vault_id=$2
              and corpus_revision=$3 and provider='openai-compatible-http'`,
          [spaceId, vaultId, r1Revision],
        );
        expect(r1Generation.rows).toHaveLength(1);
        expect(r1Generation.rows[0]).toMatchObject({ status: "BUILDING" });

        const r2Revision = `${r1Revision}:superseding-${randomUUID()}`;
        const preservedVectorRevision =
          recoveredMarker.rows[0]?.vector_revision;
        await db.pool.query(
          `update vault_index_revisions
              set corpus_revision=$3,
                  lexical_revision=$3,
                  graph_revision=$3,
                  context_pack_revision=$3,
                  vector_revision=$4,
                  status='DEGRADED',
                  warnings='["R2_SELECTED_BY_TEST"]'::jsonb,
                  updated_at=now()
            where space_id=$1 and vault_id=$2`,
          [spaceId, vaultId, r2Revision, preservedVectorRevision],
        );

        blocking.release();
        const r1Result = await r1Import;
        expect(r1Result.status).toBe("COMPLETED");

        const generationsAfterRace = await db.pool.query<{
          id: string;
          status: string;
          corpus_revision: string;
        }>(
          `select id,status,corpus_revision
             from embedding_generations
            where space_id=$1 and vault_id=$2
            order by created_at,id`,
          [spaceId, vaultId],
        );
        expect(
          generationsAfterRace.rows.find(
            (row) => row.corpus_revision === r1Revision,
          ),
        ).toMatchObject({
          id: r1Generation.rows[0]?.id,
          status: "READY",
        });
        expect(
          generationsAfterRace.rows.filter((row) => row.status === "ACTIVE"),
        ).toEqual([
          expect.objectContaining({
            id: activeGenerationId,
            corpus_revision: recoveredMarker.rows[0]?.vector_revision,
          }),
        ]);

        const markerAfterRace = await db.pool.query<{
          corpus_revision: string;
          vector_revision: string | null;
          status: string;
          warnings: string[];
        }>(
          `select corpus_revision,vector_revision,status,warnings
             from vault_index_revisions
            where space_id=$1 and vault_id=$2`,
          [spaceId, vaultId],
        );
        expect(markerAfterRace.rows[0]).toMatchObject({
          corpus_revision: r2Revision,
          vector_revision: preservedVectorRevision,
          status: "DEGRADED",
        });
        expect(markerAfterRace.rows[0]?.warnings).toContain(
          "R2_SELECTED_BY_TEST",
        );
      } finally {
        blocking.release();
        await new Promise<void>((resolve) =>
          blocking.server.close(() => resolve()),
        );
      }
    } finally {
      await new Promise<void>((resolve) =>
        failing.server.close(() => resolve()),
      );
    }
  });
});
