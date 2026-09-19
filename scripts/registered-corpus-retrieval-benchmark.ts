import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  aggregateBenchmarkRun,
  RETRIEVAL_BENCHMARK_MATRIX,
  V03_RETRIEVAL_BASELINE,
  selectBenchmarkDefault,
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

type RegisteredDocument = {
  id: string;
  title: string;
  aliases: string[];
  sourcePath: string;
  related: string[];
  evidence: string[];
  citations: string[];
};

type ResolvedDocument = RegisteredDocument & { body: string };

type RegisteredVault = {
  id: string;
  kind: string;
  documents: RegisteredDocument[];
};

type ResolvedVault = Omit<RegisteredVault, "documents"> & {
  documents: ResolvedDocument[];
};

type RegisteredManifest = {
  schemaVersion: number;
  evidenceLevel: string;
  name: string;
  description: string;
  vaults: RegisteredVault[];
};

type ResolvedManifest = Omit<RegisteredManifest, "vaults"> & {
  vaults: ResolvedVault[];
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

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const repositoryRoot = path.resolve(".");
const manifestPath = path.resolve(
  "evals/registered/public-product-corpus.json",
);
const casesPath = path.resolve(
  "evals/registered/public-product-corpus-cases.jsonl",
);
const outputPath = path.resolve(
  process.env.AKP_REGISTERED_RETRIEVAL_REPORT ??
    "reports/ci/registered-corpus-retrieval-benchmark.json",
);

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveRepositoryPath(sourcePath: string): string {
  const resolved = path.resolve(repositoryRoot, sourcePath);
  const relative = path.relative(repositoryRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Registered corpus path escapes repository: ${sourcePath}`);
  }
  return resolved;
}

async function loadDataset(): Promise<{
  manifest: ResolvedManifest;
  cases: GoldCase[];
  hashes: Record<string, string>;
}> {
  const manifestRaw = await readFile(manifestPath, "utf8");
  const casesRaw = await readFile(casesPath, "utf8");
  const parsed = JSON.parse(manifestRaw) as RegisteredManifest;
  const hashes: Record<string, string> = {
    [path.relative(repositoryRoot, manifestPath)]: sha256(manifestRaw),
    [path.relative(repositoryRoot, casesPath)]: sha256(casesRaw),
  };

  const vaults: ResolvedVault[] = [];
  for (const vault of parsed.vaults) {
    const documents: ResolvedDocument[] = [];
    for (const document of vault.documents) {
      const absolutePath = resolveRepositoryPath(document.sourcePath);
      const body = await readFile(absolutePath, "utf8");
      hashes[document.sourcePath] = sha256(body);
      documents.push({ ...document, body });
    }
    vaults.push({ ...vault, documents });
  }

  const cases = casesRaw
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GoldCase);

  return {
    manifest: { ...parsed, vaults },
    cases,
    hashes,
  };
}

function createFixture(manifest: ResolvedManifest): Fixture {
  return {
    organizationId: randomUUID(),
    spaceId: randomUUID(),
    corpusRevision: `registered-corpus-${randomUUID()}`,
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

async function seedCorpus(
  db: Postgres,
  manifest: ResolvedManifest,
  fixture: Fixture,
): Promise<void> {
  await db.pool.query(
    `insert into organizations(id,slug,name) values($1,$2,$3)`,
    [
      fixture.organizationId,
      `registered-corpus-${fixture.organizationId.slice(0, 8)}`,
      "Registered public product corpus benchmark",
    ],
  );
  await db.pool.query(
    `insert into spaces(id,organization_id,slug,name,visibility,knowledge_repo_path)
     values($1,$2,$3,$4,'PRIVATE',$5)`,
    [
      fixture.spaceId,
      fixture.organizationId,
      `registered-corpus-${fixture.spaceId.slice(0, 8)}`,
      "Registered public product corpus benchmark",
      `benchmark/registered/${fixture.spaceId}`,
    ],
  );

  for (const vault of manifest.vaults) {
    const vaultId = fixture.vaultIds.get(vault.id);
    if (!vaultId) throw new Error(`Missing vault mapping for ${vault.id}`);
    await db.pool.query(
      `insert into vaults(
         id,space_id,canonical_path,name,read_only,current_revision,
         vault_key,local_path,visibility,enabled
       ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)`,
      [
        vaultId,
        fixture.spaceId,
        `benchmark/registered/${vault.id}`,
        `Registered ${vault.kind}`,
        fixture.corpusRevision,
        `registered-${vault.id}-${vaultId.slice(0, 8)}`,
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
          document.sourcePath,
          document.id,
          document.title,
          fixture.corpusRevision,
          document.body,
          JSON.stringify({
            id: document.id,
            title: document.title,
            knowledge_layer: "concept",
            benchmark_corpus: manifest.name,
            source_path: document.sourcePath,
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
          `document-${document.id}`,
          [document.title],
          document.body,
          contentHash,
          fixture.corpusRevision,
          document.evidence,
          Math.max(1, document.body.split(/\s+/u).length),
          JSON.stringify({
            sourcePath: document.sourcePath,
            citations: document.citations,
            logicalDocumentId: document.id,
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
           ) values($1,$2,$3,'related_to',1,'registered-corpus-benchmark')
           on conflict do nothing`,
          [fixture.spaceId, from, to],
        );
      }
    }
  }
}

async function buildCommunityIndexes(
  db: Postgres,
  manifest: ResolvedManifest,
  fixture: Fixture,
): Promise<void> {
  for (const vault of manifest.vaults) {
    const vaultId = fixture.vaultIds.get(vault.id);
    if (!vaultId) throw new Error(`Missing vault mapping for ${vault.id}`);
    await rebuildCommunityIndex(db, {
      spaceId: fixture.spaceId,
      vaultId,
      graphRevision: fixture.corpusRevision,
    });
  }
}

async function cleanupCorpus(db: Postgres, fixture: Fixture): Promise<void> {
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
  manifest: ResolvedManifest,
  fixture: Fixture,
  adapter: LocalSemanticEmbeddingAdapter,
): Promise<ActiveEmbeddingGenerationDescriptor[]> {
  const generations: ActiveEmbeddingGenerationDescriptor[] = [];
  for (const vault of manifest.vaults) {
    const vaultId = fixture.vaultIds.get(vault.id);
    if (!vaultId) throw new Error(`Missing vault mapping for ${vault.id}`);
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
  const retrievedEvidenceIds = hits.length
    ? (
        await db.pool.query<{ source_ids: string[] }>(
          `select source_ids
             from knowledge_units
            where document_id=any($1::uuid[])
              and corpus_revision=$2`,
          [hits.map((hit) => hit.documentId), fixture.corpusRevision],
        )
      ).rows.flatMap((row) => row.source_ids)
    : [];
  return {
    configurationName: configuration.name,
    caseId: testCase.id,
    slice: testCase.slice ?? testCase.category,
    rankedDocumentIds,
    goldDocumentIds: [...testCase.gold_documents],
    ...(testCase.gold_evidence
      ? { goldEvidenceIds: [...testCase.gold_evidence] }
      : {}),
    ...(testCase.gold_citations
      ? { goldCitationIds: [...testCase.gold_citations] }
      : {}),
    retrievedEvidenceIds,
    ...(testCase.must_not_include
      ? { mustNotInclude: [...testCase.must_not_include] }
      : {}),
    ...(testCase.expect_no_answer !== undefined
      ? { expectNoAnswer: testCase.expect_no_answer }
      : {}),
    retrievedCitationIds: hits.flatMap((hit) => hit.citations),
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
    fusionReasons: Object.fromEntries(
      hits.map((hit) => [
        hit.document.externalId ?? hit.documentId,
        [...hit.reasons],
      ]),
    ),
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
    await seedCorpus(db, dataset.manifest, fixture);
    await buildCommunityIndexes(db, dataset.manifest, fixture);
    await adapter.load();
    const generations = await buildRealEmbeddings(
      db,
      dataset.manifest,
      fixture,
      adapter,
    );
    const queryEmbeddingService = new QueryEmbeddingService(
      async () => adapter,
    );
    const runs = [];
    for (const configuration of benchmarkConfigurations()) {
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

    const isolationViolations = runs.flatMap((run) =>
      run.results.flatMap((result) => {
        const expectedVault = dataset.cases.find(
          (entry) => entry.id === result.caseId,
        )?.vault;
        const expectedVaultId = expectedVault
          ? fixture.vaultIds.get(expectedVault)
          : undefined;
        return expectedVaultId &&
          result.rankedVaultIds.some((vaultId) => vaultId !== expectedVaultId)
          ? [`${run.configurationName}:${result.caseId}`]
          : [];
      }),
    );
    if (isolationViolations.length > 0) {
      throw new Error(
        `Cross-vault isolation violation: ${isolationViolations.join(", ")}`,
      );
    }

    const candidateDecision = selectBenchmarkDefault(runs);
    const report = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      historicalBaseline: V03_RETRIEVAL_BASELINE,
      evidence: {
        level: "REGISTERED_PUBLIC_PRODUCT_CORPUS_REAL_RETRIEVAL_PIPELINE",
        qualityClaim: "MEASURED_ON_PUBLIC_PRODUCT_DOCS_ONLY",
        description:
          "Versioned repository product documentation is read from its real source files, hashed, embedded with the pinned multilingual E5 provider, persisted to PostgreSQL/pgvector, and queried through production retrieval/RRF code.",
        limitations: [
          "The corpus is the product's own public documentation, not a private customer vault or production traffic sample.",
          "The benchmark seeds one retrieval unit per source document and therefore does not validate extraction or production chunking fidelity.",
          "The corpus is small and single-product; results are not evidence of domain-general retrieval superiority.",
        ],
        notMeasured: [
          "private customer corpus quality",
          "end-to-end source extraction and chunking fidelity",
          "agent task quality",
          "concurrent throughput and resource pressure",
          "provider monetary cost",
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
        description: dataset.manifest.description,
        hashes: dataset.hashes,
        vaults: dataset.manifest.vaults.map((vault) => ({
          id: vault.id,
          kind: vault.kind,
          documents: vault.documents.map((document) => ({
            id: document.id,
            sourcePath: document.sourcePath,
          })),
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
      isolation: {
        status: "PROVEN_IN_REGISTERED_CORPUS_RUN",
        violations: isolationViolations,
      },
      candidateDecision,
      productionDefault: {
        status: "NOT_SELECTED",
        reason:
          "A small single-product public corpus is real evidence but is insufficient by itself to freeze a production retrieval default for arbitrary customer vaults.",
      },
      runs,
    };

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(
      JSON.stringify(
        {
          outputPath,
          evidenceLevel: report.evidence.level,
          cases: dataset.cases.length,
          candidateDecision,
          productionDefault: report.productionDefault,
          configurations: runs.map((run) => ({
            name: run.configurationName,
            recallAt10: run.meanRecallAt10,
            mrr: run.meanReciprocalRank,
            ndcgAt10: run.meanNdcgAt10,
            noAnswerAccuracy: run.noAnswerAccuracy,
            exactIdentifierRecall: run.exactIdentifierRecall,
            crossLanguageRecall: run.crossLanguageRecall,
            criticalFailures: run.criticalFailures,
            meanLatencyMs: run.meanLatencyMs,
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      await cleanupCorpus(db, fixture);
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
