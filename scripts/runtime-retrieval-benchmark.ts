import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  aggregateBenchmarkRun,
  RETRIEVAL_BENCHMARK_MATRIX,
  V03_RETRIEVAL_BASELINE,
  type BenchmarkConfiguration,
  type BenchmarkObservation,
} from "../packages/evaluation/src/index.js";
import {
  buildEmbeddingIndex,
  rebuildCommunityIndex,
} from "../packages/indexing/src/index.js";
import { Postgres } from "../packages/postgres/src/index.js";
import {
  DeterministicQueryDecomposer,
  LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR,
  LocalSemanticEmbeddingAdapter,
  MULTILINGUAL_E5_SMALL_DIMENSIONS,
  QueryEmbeddingService,
  type ActiveEmbeddingGenerationDescriptor,
} from "../packages/retrieval/src/index.js";
import { queryKnowledge } from "../apps/api/src/routes/search.js";

type ManifestDocument = {
  id: string;
  title: string;
  aliases: string[];
  body: string;
  related: string[];
  evidence: string[];
  citations: string[];
};

type ManifestVault = {
  id: string;
  kind: string;
  documents: ManifestDocument[];
};

type CuratedManifest = {
  schemaVersion: number;
  evidenceLevel: string;
  name: string;
  vaults: ManifestVault[];
};

type GoldCase = {
  id: string;
  category: string;
  query: string;
  gold_documents: string[];
  gold_evidence?: string[];
  gold_citations?: string[];
  must_not_include?: string[];
  expect_no_answer?: boolean;
  vault: string;
  critical?: boolean;
  slice?: string;
};

type Fixture = {
  organizationId: string;
  spaceId: string;
  corpusRevision: string;
  vaultIds: Map<string, string>;
  documentIds: Map<string, string>;
  unitIds: Map<string, string>;
};

type RuntimeObservation = BenchmarkObservation & {
  warnings: string[];
  availableChannels: string[];
  rankedVaultIds: string[];
  fusionReasons: Record<string, string[]>;
};

type MemorySnapshot = {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
};

type StorageSnapshot = {
  databaseBytes: number;
  documentsBytes: number;
  unitsBytes: number;
  relationsBytes: number;
  communityBytes: number;
  embeddingsBytes: number;
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const fixtureRoot = path.resolve("evals/fixtures");
const manifestPath = path.join(fixtureRoot, "curated-level-b-manifest.json");
const casePaths = [
  path.join(fixtureRoot, "curated-level-b-vault-a-software.jsonl"),
  path.join(fixtureRoot, "curated-level-b-vault-b-handbook.jsonl"),
  path.join(fixtureRoot, "curated-level-b-vault-c-neutral.jsonl"),
];
const outputPath = path.resolve(
  process.env.AKP_RUNTIME_RETRIEVAL_REPORT ??
    "reports/ci/runtime-retrieval-benchmark.json",
);
const filteredAnnPath = path.resolve(
  process.env.AKP_FILTERED_ANN_REPORT_INPUT ??
    "reports/ci/filtered-ann-baseline.json",
);

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function memorySnapshot(): MemorySnapshot {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
  };
}

function memoryDelta(after: MemorySnapshot, before: MemorySnapshot) {
  return {
    rssBytes: after.rssBytes - before.rssBytes,
    heapUsedBytes: after.heapUsedBytes - before.heapUsedBytes,
    heapTotalBytes: after.heapTotalBytes - before.heapTotalBytes,
    externalBytes: after.externalBytes - before.externalBytes,
  };
}

function numeric(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected finite numeric value, received ${String(value)}`);
  }
  return parsed;
}

async function storageSnapshot(db: Postgres): Promise<StorageSnapshot> {
  const result = await db.pool.query(
    `
    select
      pg_database_size(current_database())::bigint database_bytes,
      pg_total_relation_size('public.knowledge_documents'::regclass)::bigint documents_bytes,
      pg_total_relation_size('public.knowledge_units'::regclass)::bigint units_bytes,
      pg_total_relation_size('public.knowledge_relations'::regclass)::bigint relations_bytes,
      (
        pg_total_relation_size('public.community_index_revisions'::regclass) +
        pg_total_relation_size('public.community_index_communities'::regclass) +
        pg_total_relation_size('public.community_index_memberships'::regclass)
      )::bigint community_bytes,
      pg_total_relation_size('public.unit_embeddings'::regclass)::bigint embeddings_bytes
    `,
  );
  const row = result.rows[0];
  if (!row) throw new Error("PostgreSQL did not return storage evidence");
  return {
    databaseBytes: numeric(row.database_bytes),
    documentsBytes: numeric(row.documents_bytes),
    unitsBytes: numeric(row.units_bytes),
    relationsBytes: numeric(row.relations_bytes),
    communityBytes: numeric(row.community_bytes),
    embeddingsBytes: numeric(row.embeddings_bytes),
  };
}

function storageDelta(after: StorageSnapshot, before: StorageSnapshot) {
  return {
    databaseBytes: after.databaseBytes - before.databaseBytes,
    documentsBytes: after.documentsBytes - before.documentsBytes,
    unitsBytes: after.unitsBytes - before.unitsBytes,
    relationsBytes: after.relationsBytes - before.relationsBytes,
    communityBytes: after.communityBytes - before.communityBytes,
    embeddingsBytes: after.embeddingsBytes - before.embeddingsBytes,
  };
}

function resourceRequirements(configuration: BenchmarkConfiguration) {
  return {
    lexical: configuration.channels.includes("lexical"),
    vector: configuration.channels.includes("vector"),
    typedGraph: configuration.channels.includes("graph"),
    contextPack: configuration.channels.includes("context-pack"),
    rerank: Boolean(configuration.deterministicRerank),
    associativePpr: Boolean(configuration.associativePpr),
    communityGlobal: Boolean(configuration.communityGlobal),
    queryDecomposition: Boolean(configuration.queryDecomposition),
  };
}

async function loadFilteredAnnEvidence(): Promise<
  | {
      measured: true;
      path: string;
      sha256: string;
      status: string;
      measurements: unknown[];
    }
  | { measured: false; path: string; reason: string }
> {
  try {
    const raw = await readFile(filteredAnnPath, "utf8");
    const parsed = JSON.parse(raw) as {
      status?: unknown;
      measurements?: unknown;
    };
    const measurements = Array.isArray(parsed.measurements)
      ? parsed.measurements
      : [];
    if (parsed.status !== "PROVEN" || measurements.length === 0) {
      return {
        measured: false,
        path: filteredAnnPath,
        reason:
          "Filtered ANN report exists but is not PROVEN with measurements.",
      };
    }
    return {
      measured: true,
      path: filteredAnnPath,
      sha256: sha256(raw),
      status: String(parsed.status),
      measurements,
    };
  } catch (error) {
    return {
      measured: false,
      path: filteredAnnPath,
      reason:
        error instanceof Error
          ? `Filtered ANN evidence unavailable: ${error.message}`
          : "Filtered ANN evidence unavailable.",
    };
  }
}

async function loadDataset(): Promise<{
  manifest: CuratedManifest;
  cases: GoldCase[];
  hashes: Record<string, string>;
}> {
  const manifestRaw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw) as CuratedManifest;
  const hashes: Record<string, string> = {
    [path.relative(process.cwd(), manifestPath)]: sha256(manifestRaw),
  };
  const cases: GoldCase[] = [];
  for (const casePath of casePaths) {
    const raw = await readFile(casePath, "utf8");
    hashes[path.relative(process.cwd(), casePath)] = sha256(raw);
    for (const line of raw.split(/\r?\n/u).filter(Boolean)) {
      cases.push(JSON.parse(line) as GoldCase);
    }
  }

  // Cross-language quality belongs in the final matrix but the reusable Level
  // B fixture predates that slice. Keep the additional case local to this
  // runtime benchmark so the checked-in curated gold set retains its meaning.
  cases.push({
    id: "runtime-cross-language-retry",
    category: "cross-language",
    query:
      "¿Qué regla limita los reintentos de llamadas transitorias mediante retroceso exponencial?",
    gold_documents: ["software-retry-policy"],
    vault: "vault-a-software",
    critical: false,
    slice: "cross-language",
  });
  cases.push({
    id: "runtime-code-symbol-ingress",
    category: "code-symbol",
    query: "ingress validation service",
    gold_documents: ["software-api-boundary"],
    vault: "vault-a-software",
    critical: false,
    slice: "code-symbol",
  });
  return { manifest, cases, hashes };
}

function createFixture(manifest: CuratedManifest): Fixture {
  return {
    organizationId: randomUUID(),
    spaceId: randomUUID(),
    corpusRevision: `runtime-benchmark-${randomUUID()}`,
    vaultIds: new Map(manifest.vaults.map((vault) => [vault.id, randomUUID()])),
    documentIds: new Map(
      manifest.vaults.flatMap((vault) =>
        vault.documents.map((document) => [document.id, randomUUID()] as const),
      ),
    ),
    unitIds: new Map(
      manifest.vaults.flatMap((vault) =>
        vault.documents.map((document) => [document.id, randomUUID()] as const),
      ),
    ),
  };
}

async function seedFixture(
  db: Postgres,
  manifest: CuratedManifest,
  fixture: Fixture,
): Promise<void> {
  await db.pool.query(
    `insert into organizations(id,slug,name) values($1,$2,$3)`,
    [
      fixture.organizationId,
      `runtime-benchmark-${fixture.organizationId.slice(0, 8)}`,
      "Runtime retrieval benchmark",
    ],
  );
  await db.pool.query(
    `insert into spaces(id,organization_id,slug,name,visibility,knowledge_repo_path)
     values($1,$2,$3,$4,'PRIVATE',$5)`,
    [
      fixture.spaceId,
      fixture.organizationId,
      `runtime-benchmark-${fixture.spaceId.slice(0, 8)}`,
      "Runtime retrieval benchmark",
      `benchmark/runtime/${fixture.spaceId}`,
    ],
  );

  for (const vault of manifest.vaults) {
    const vaultId = fixture.vaultIds.get(vault.id);
    if (!vaultId)
      throw new Error(`Missing runtime vault mapping for ${vault.id}`);
    await db.pool.query(
      `insert into vaults(
         id,space_id,canonical_path,name,read_only,current_revision,
         vault_key,local_path,visibility,enabled
       ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)`,
      [
        vaultId,
        fixture.spaceId,
        `benchmark/vault/${vault.id}`,
        `Benchmark ${vault.kind}`,
        fixture.corpusRevision,
        `runtime-${vault.id}-${vaultId.slice(0, 8)}`,
      ],
    );
    await db.pool.query(
      `insert into vault_index_revisions(
         space_id,vault_id,corpus_revision,lexical_revision,vector_revision,
         graph_revision,context_pack_revision,status,warnings
       ) values($1,$2,$3,$3,$3,$3,$3,'CONSISTENT','[]'::jsonb)`,
      [fixture.spaceId, vaultId, fixture.corpusRevision],
    );

    for (const document of vault.documents) {
      const documentId = fixture.documentIds.get(document.id);
      const unitId = fixture.unitIds.get(document.id);
      if (!documentId || !unitId) {
        throw new Error(`Missing document mapping for ${document.id}`);
      }
      const contentHash = sha256(document.body);
      await db.pool.query(
        `insert into knowledge_documents(
           id,space_id,vault_id,path,external_id,title,type,lifecycle,
           trust_tier,current_revision,body_cache,frontmatter,aliases,layer,
           content_hash,token_estimate,raw_links
         ) values($1,$2,$3,$4,$5,$6,'concept','ACTIVE','HUMAN_REVIEWED',
                  $7,$8,$9::jsonb,$10,'concept',$11,$12,'[]'::jsonb)`,
        [
          documentId,
          fixture.spaceId,
          vaultId,
          `${vault.id}/${document.id}.md`,
          document.id,
          document.title,
          fixture.corpusRevision,
          document.body,
          JSON.stringify({
            id: document.id,
            title: document.title,
            knowledge_layer: "concept",
            benchmark_fixture: manifest.name,
          }),
          document.aliases,
          contentHash,
          Math.max(1, document.body.split(/\s+/u).length),
        ],
      );
      await db.pool.query(
        `insert into knowledge_units(
           id,document_id,space_id,vault_id,unit_key,unit_type,heading_path,body,
           content_hash,corpus_revision,document_revision,lifecycle,trust_tier,
           source_ids,token_estimate,parent_unit_id,permissions,locator,
           structural_order,container_only,embedding_eligible
         ) values($1,$2,$3,$4,$5,'PARAGRAPH',$6,$7,$8,$9,$9,'ACTIVE',
                  'HUMAN_REVIEWED',$10,$11,null,'{}'::jsonb,$12::jsonb,1,false,true)`,
        [
          unitId,
          documentId,
          fixture.spaceId,
          vaultId,
          `paragraph-${document.id}`,
          [document.title],
          document.body,
          contentHash,
          fixture.corpusRevision,
          document.evidence,
          Math.max(1, document.body.split(/\s+/u).length),
          JSON.stringify({
            fixture: manifest.name,
            logical_document_id: document.id,
          }),
        ],
      );
    }
  }

  for (const vault of manifest.vaults) {
    for (const document of vault.documents) {
      for (const related of document.related) {
        const from = fixture.documentIds.get(document.id);
        const to = fixture.documentIds.get(related);
        if (!from || !to) continue;
        await db.pool.query(
          `insert into knowledge_relations(
             space_id,from_document_id,to_document_id,relation_type,weight,provenance
           ) values($1,$2,$3,'related_to',1,'runtime-retrieval-benchmark')
           on conflict do nothing`,
          [fixture.spaceId, from, to],
        );
      }
    }
  }
}

async function buildCommunityIndexes(
  db: Postgres,
  manifest: CuratedManifest,
  fixture: Fixture,
): Promise<void> {
  for (const vault of manifest.vaults) {
    const vaultId = fixture.vaultIds.get(vault.id);
    if (!vaultId) {
      throw new Error(`Missing runtime vault mapping for ${vault.id}`);
    }
    await rebuildCommunityIndex(db, {
      spaceId: fixture.spaceId,
      vaultId,
      graphRevision: fixture.corpusRevision,
    });
  }
}

async function cleanupFixture(db: Postgres, fixture: Fixture): Promise<void> {
  const vaultIds = [...fixture.vaultIds.values()];
  await db.pool.query("delete from knowledge_relations where space_id=$1", [
    fixture.spaceId,
  ]);
  await db.pool.query(
    `delete from unit_embeddings
      where generation_id in (
        select id from embedding_generations where vault_id=any($1::uuid[])
      )`,
    [vaultIds],
  );
  await db.pool.query(
    "delete from embedding_generations where vault_id=any($1::uuid[])",
    [vaultIds],
  );
  await db.pool.query("delete from knowledge_units where space_id=$1", [
    fixture.spaceId,
  ]);
  await db.pool.query("delete from knowledge_documents where space_id=$1", [
    fixture.spaceId,
  ]);
  await db.pool.query(
    "delete from vault_index_revisions where vault_id=any($1::uuid[])",
    [vaultIds],
  );
  await db.pool.query("delete from vaults where id=any($1::uuid[])", [
    vaultIds,
  ]);
  await db.pool.query("delete from spaces where id=$1", [fixture.spaceId]);
  await db.pool.query("delete from organizations where id=$1", [
    fixture.organizationId,
  ]);
}

function benchmarkConfigurations(): BenchmarkConfiguration[] {
  const required = new Set([
    "exact+lexical",
    "vector-only",
    "graph-only",
    "lexical+vector",
    "lexical+graph",
    "vector+graph",
    "context-pack+lexical+graph",
    "full-hybrid-rrf",
    "full-hybrid+rerank",
    "lexical+vector+graph+ppr",
    "lexical+vector+graph+community-global",
    "lexical+vector+query-decomposition",
  ]);
  return RETRIEVAL_BENCHMARK_MATRIX.filter((configuration) =>
    required.has(configuration.name),
  ).map((configuration) => ({
    ...configuration,
    channels: [...configuration.channels],
  }));
}

async function buildRealEmbeddings(
  db: Postgres,
  manifest: CuratedManifest,
  fixture: Fixture,
  adapter: LocalSemanticEmbeddingAdapter,
): Promise<ActiveEmbeddingGenerationDescriptor[]> {
  const generations: ActiveEmbeddingGenerationDescriptor[] = [];
  for (const vault of manifest.vaults) {
    const vaultId = fixture.vaultIds.get(vault.id);
    if (!vaultId)
      throw new Error(`Missing runtime vault mapping for ${vault.id}`);
    const built = await buildEmbeddingIndex(db, {
      spaceId: fixture.spaceId,
      vaultId,
      corpusRevision: fixture.corpusRevision,
      provider: adapter,
      activate: true,
      batchSize: 8,
    });
    if (!built.activated || built.generation.status !== "ACTIVE") {
      throw new Error(`Embedding generation did not activate for ${vault.id}`);
    }
    generations.push({
      generationId: built.generation.generationId,
      spaceId: built.generation.spaceId,
      vaultId: built.generation.vaultId,
      corpusRevision: built.generation.corpusRevision,
      provider: built.generation.provider,
      model: built.generation.model,
      modelRevision: built.generation.modelRevision,
      dimensions: built.generation.dimensions,
      normalization: built.generation.normalization,
      inputStrategy: built.generation.inputStrategy,
      configurationVersion: built.generation.configurationVersion,
      runtime: built.generation.runtime,
      configurationHash: built.generation.configurationHash,
    });
  }
  return generations;
}

async function executeCase(
  db: Postgres,
  fixture: Fixture,
  testCase: GoldCase,
  configuration: BenchmarkConfiguration,
  queryEmbeddingService: QueryEmbeddingService,
): Promise<RuntimeObservation> {
  const vaultId = fixture.vaultIds.get(testCase.vault);
  if (!vaultId) throw new Error(`Unknown case vault ${testCase.vault}`);
  const warnings: string[] = [];
  const availableChannels = new Set<
    "context-pack" | "exact" | "lexical" | "vector" | "graph" | "raw" | "code"
  >();
  const started = performance.now();
  const hits = await queryKnowledge(
    db,
    {
      query: testCase.query,
      spaceId: fixture.spaceId,
      vaultId,
      vaultIds: [],
      federated: false,
      types: [],
      minimumTrust: "MACHINE_SUPPORTED",
      mode: "SOURCE_BACKED",
      limit: 10,
    },
    {
      vaultIds: [vaultId],
      channels: [...configuration.channels],
      allowVectorForBenchmark: Boolean(configuration.allowVectorForBenchmark),
      deterministicRerank: Boolean(configuration.deterministicRerank),
      ...(configuration.associativePpr
        ? {
            retrievalPolicy: {
              graphMode: "ASSOCIATIVE" as const,
              channels: {
                GRAPH_PPR: { enabled: true, weight: 1.1 },
              },
            },
          }
        : configuration.communityGlobal
          ? {
              retrievalPolicy: {
                graphMode: "GLOBAL" as const,
                channels: {
                  COMMUNITY: { enabled: true, weight: 1.1 },
                },
              },
            }
          : {}),
      ...(configuration.queryDecomposition
        ? { queryTransformer: new DeterministicQueryDecomposer() }
        : {}),
      queryEmbeddingService,
      warningSink: warnings,
      availableChannelSink: availableChannels,
      graphScopes: [{ vaultId, pathPrefix: null }],
      graphPolicy: { maxHops: 3, directionPolicy: "both" },
    },
  );
  const latencyMs = performance.now() - started;
  const rankedDocumentIds = hits.flatMap((hit) =>
    hit.document.externalId ? [hit.document.externalId] : [],
  );
  const fusionReasons = Object.fromEntries(
    hits.map((hit) => [
      hit.document.externalId ?? hit.documentId,
      [...hit.reasons],
    ]),
  );
  const retrievedCitations = hits.flatMap((hit) => hit.citations);
  return {
    configurationName: configuration.name,
    caseId: testCase.id,
    slice: testCase.slice ?? testCase.category,
    rankedDocumentIds,
    goldDocumentIds: [...testCase.gold_documents],
    ...(testCase.must_not_include
      ? { mustNotInclude: [...testCase.must_not_include] }
      : {}),
    ...(testCase.expect_no_answer !== undefined
      ? { expectNoAnswer: testCase.expect_no_answer }
      : {}),
    ...(testCase.gold_citations
      ? { goldCitationIds: [...testCase.gold_citations] }
      : {}),
    retrievedCitationIds: retrievedCitations,
    returnedAnswer: hits.length > 0,
    latencyMs,
    estimatedTokens: hits.reduce(
      (sum, hit) => sum + Math.ceil(hit.excerpt.length / 4),
      0,
    ),
    critical: testCase.critical,
    warnings: [...new Set(warnings)],
    availableChannels: [...availableChannels].sort(),
    rankedVaultIds: [...new Set(hits.map((hit) => hit.vaultId))],
    fusionReasons,
  };
}

async function main(): Promise<void> {
  const previousVectorEnabled = process.env.AKP_VECTOR_ENABLED;
  process.env.AKP_VECTOR_ENABLED = "true";
  const db = new Postgres(databaseUrl);
  const dataset = await loadDataset();
  const fixture = createFixture(dataset.manifest);
  const adapter = new LocalSemanticEmbeddingAdapter({
    ...(process.env.AKP_MODEL_CACHE_DIR?.trim()
      ? { cacheDir: process.env.AKP_MODEL_CACHE_DIR }
      : {}),
    localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
    maxBatchSize: 8,
  });

  try {
    const memoryBeforeFixture = memorySnapshot();
    const storageBeforeFixture = await storageSnapshot(db);
    const seedStarted = performance.now();
    await seedFixture(db, dataset.manifest, fixture);
    const fixtureSeedMs = performance.now() - seedStarted;
    const memoryAfterFixture = memorySnapshot();
    const storageAfterFixture = await storageSnapshot(db);

    const communityBuildStarted = performance.now();
    await buildCommunityIndexes(db, dataset.manifest, fixture);
    const communityBuildMs = performance.now() - communityBuildStarted;
    const memoryAfterCommunities = memorySnapshot();
    const storageAfterCommunities = await storageSnapshot(db);

    await adapter.load();
    const embeddingBuildStarted = performance.now();
    const generations = await buildRealEmbeddings(
      db,
      dataset.manifest,
      fixture,
      adapter,
    );
    const embeddingBuildMs = performance.now() - embeddingBuildStarted;
    const memoryAfterEmbeddings = memorySnapshot();
    const storageAfterEmbeddings = await storageSnapshot(db);
    const queryEmbeddingService = new QueryEmbeddingService(
      async () => adapter,
    );
    const configurations = benchmarkConfigurations();
    const filteredAnnEvidence = await loadFilteredAnnEvidence();
    const runs = [];
    for (const configuration of configurations) {
      const observations: RuntimeObservation[] = [];
      for (const testCase of dataset.cases) {
        observations.push(
          await executeCase(
            db,
            fixture,
            testCase,
            configuration,
            queryEmbeddingService,
          ),
        );
      }
      runs.push(aggregateBenchmarkRun(configuration, observations));
    }

    const baselineRun = runs.find(
      (run) => run.configurationName === "exact+lexical",
    );
    if (!baselineRun) {
      throw new Error("Runtime benchmark requires exact+lexical baseline");
    }
    const reportRuns = runs.map((run) => {
      const configuration = configurations.find(
        (candidate) => candidate.name === run.configurationName,
      );
      if (!configuration) {
        throw new Error(`Missing configuration for ${run.configurationName}`);
      }
      const warnings = run.results.flatMap((result) =>
        "warnings" in result && Array.isArray(result.warnings)
          ? result.warnings.map(String)
          : [],
      );
      return {
        ...run,
        qualityDelta: {
          recallAt10: run.meanRecallAt10 - baselineRun.meanRecallAt10,
          mrr: run.meanReciprocalRank - baselineRun.meanReciprocalRank,
          ndcgAt10: run.meanNdcgAt10 - baselineRun.meanNdcgAt10,
          citationPrecision:
            run.meanCitationPrecision - baselineRun.meanCitationPrecision,
        },
        resourceRequirements: resourceRequirements(configuration),
        indexBuildUpdate: {
          buildEvidence:
            configuration.channels.includes("vector") ||
            configuration.communityGlobal
              ? {
                  measured: true,
                  sharedEmbeddingBuildMs: configuration.channels.includes(
                    "vector",
                  )
                    ? embeddingBuildMs
                    : null,
                  sharedCommunityBuildMs: configuration.communityGlobal
                    ? communityBuildMs
                    : null,
                  attribution:
                    "Shared fixture component build evidence; not isolated per query.",
                }
              : {
                  measured: false,
                  sharedEmbeddingBuildMs: null,
                  sharedCommunityBuildMs: null,
                  reason:
                    "This harness seeds lexical/graph fixture projections directly; no isolated build timer exists for this option.",
                },
          updateEvidence: {
            measured: false,
            milliseconds: null,
            reason:
              "Incremental index update cost is not exercised by this harness.",
          },
        },
        storageRam: {
          measured: true,
          sharedProjectionStorageBytes: {
            fixture: storageDelta(storageAfterFixture, storageBeforeFixture),
            communities: storageDelta(
              storageAfterCommunities,
              storageAfterFixture,
            ),
            embeddings: storageDelta(
              storageAfterEmbeddings,
              storageAfterCommunities,
            ),
          },
          sharedProcessMemoryBytes: {
            fixture: memoryDelta(memoryAfterFixture, memoryBeforeFixture),
            communities: memoryDelta(
              memoryAfterCommunities,
              memoryAfterFixture,
            ),
            embeddings: memoryDelta(
              memoryAfterEmbeddings,
              memoryAfterCommunities,
            ),
          },
          attribution:
            "Shared fixture/component evidence; not presented as isolated per-query memory.",
        },
        tokenCost: {
          measured: true,
          meanEstimatedExcerptTokens: run.meanEstimatedTokens,
          method:
            "APPROXIMATE characters/4 estimate over returned excerpts; ContextPacket budgets use tokenizer metadata separately.",
        },
        providerCost: {
          measured: true,
          externalApiUsd: 0,
          basis:
            "Pinned local embedding provider; no metered external provider API call.",
          localComputeCostMeasured: false,
        },
        filteredRecall: configuration.channels.includes("vector")
          ? filteredAnnEvidence
          : {
              measured: false,
              notApplicable: true,
              reason: "Configuration does not use the vector channel.",
            },
        multilingualBehavior: {
          measured: true,
          recallAt10: run.crossLanguageRecall,
        },
        codeSymbolBehavior: {
          measured: run.codeSymbolCases > 0,
          cases: run.codeSymbolCases,
          recallAt10: run.codeSymbolCases > 0 ? run.codeSymbolRecall : null,
        },
        failureDegradedMode: {
          warningCount: warnings.length,
          warnings: [...new Set(warnings)].sort(),
          criticalFailures: run.criticalFailures,
        },
      };
    });

    const isolationViolations = runs.flatMap((run) =>
      run.results.flatMap((result) =>
        result.rankedVaultIds.some(
          (vaultId) =>
            vaultId !==
            fixture.vaultIds.get(
              dataset.cases.find((entry) => entry.id === result.caseId)
                ?.vault ?? "",
            ),
        )
          ? [`${run.configurationName}:${result.caseId}`]
          : [],
      ),
    );
    if (isolationViolations.length > 0) {
      throw new Error(
        `Cross-vault isolation violation: ${isolationViolations.join(", ")}`,
      );
    }

    const report = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      historicalBaseline: V03_RETRIEVAL_BASELINE,
      evidence: {
        level: "CURATED_FIXTURE_REAL_PIPELINE",
        qualityClaim: "PIPELINE_EXECUTED_NOT_REAL_CORPUS",
        description:
          "Checked-in heterogeneous curated labels executed through real PostgreSQL FTS, persisted pgvector embeddings, bounded graph traversal and production RRF query code.",
        notMeasured: [
          "registered private/production-like corpus quality",
          "evidence-locator recall against real source artifacts",
          "agent task quality",
          "concurrent throughput under this retrieval matrix",
          "incremental index-update cost",
          "filtered ANN recall inside this harness",
          "local hardware/energy monetary cost",
        ],
      },
      runtime: {
        node: process.version,
        postgres: "DATABASE_URL-backed disposable PostgreSQL",
        queryImplementation: "apps/api/src/routes/search.ts#queryKnowledge",
      },
      dataset: {
        name: dataset.manifest.name,
        sourceEvidenceLevel: dataset.manifest.evidenceLevel,
        hashes: dataset.hashes,
        vaults: dataset.manifest.vaults.map((vault) => ({
          id: vault.id,
          kind: vault.kind,
          documents: vault.documents.length,
        })),
        labelledCases: dataset.cases.length,
      },
      semanticProvider: {
        ...LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR,
        dimensions: MULTILINGUAL_E5_SMALL_DIMENSIONS,
        generations: generations.map((generation) => ({
          vaultId: generation.vaultId,
          generationId: generation.generationId,
          corpusRevision: generation.corpusRevision,
          configurationHash: generation.configurationHash,
          runtime: generation.runtime,
        })),
      },
      resourceEvidence: {
        filteredAnn: filteredAnnEvidence,
        fixtureSeedMs,
        embeddingBuildMs,
        storage: {
          beforeFixture: storageBeforeFixture,
          afterFixture: storageAfterFixture,
          afterEmbeddings: storageAfterEmbeddings,
          fixtureDelta: storageDelta(storageAfterFixture, storageBeforeFixture),
          embeddingDelta: storageDelta(
            storageAfterEmbeddings,
            storageAfterFixture,
          ),
        },
        memory: {
          beforeFixture: memoryBeforeFixture,
          afterFixture: memoryAfterFixture,
          afterEmbeddings: memoryAfterEmbeddings,
          fixtureDelta: memoryDelta(memoryAfterFixture, memoryBeforeFixture),
          embeddingDelta: memoryDelta(
            memoryAfterEmbeddings,
            memoryAfterFixture,
          ),
        },
      },
      isolation: {
        status: "PROVEN_IN_FIXTURE",
        violations: isolationViolations,
      },
      productionDefault: {
        status: "NOT_SELECTED",
        reason:
          "A curated fixture running through the real pipeline is not the registered real-corpus evidence required to select a production retrieval default.",
      },
      runs: reportRuns,
    };
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(
      JSON.stringify(
        {
          outputPath,
          evidenceLevel: report.evidence.level,
          configurations: reportRuns.map((run) => ({
            name: run.configurationName,
            recallAt10: run.meanRecallAt10,
            mrr: run.meanReciprocalRank,
            codeSymbolRecall: run.codeSymbolBehavior.recallAt10,
            noAnswerAccuracy: run.noAnswerAccuracy,
            criticalFailures: run.criticalFailures,
            meanLatencyMs: run.meanLatencyMs,
          })),
          productionDefault: report.productionDefault,
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      await cleanupFixture(db, fixture);
    } finally {
      await db.close();
      if (previousVectorEnabled === undefined) {
        delete process.env.AKP_VECTOR_ENABLED;
      } else {
        process.env.AKP_VECTOR_ENABLED = previousVectorEnabled;
      }
    }
  }
}

await main();
