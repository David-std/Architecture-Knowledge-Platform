import "dotenv/config";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
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
import {
  assertSyntheticFixtureDatabaseSafety,
  Postgres,
} from "../packages/postgres/src/index.js";
import {
  assessRetrievalAnswerability,
  DeterministicQueryDecomposer,
  LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR,
  LocalSemanticEmbeddingAdapter,
  MULTILINGUAL_E5_SMALL_DIMENSIONS,
  parseKnowledgeUnits,
  QueryEmbeddingService,
  reciprocalRankFusion,
  resolveRetrievalPolicy,
  retrievalAnswerabilityCandidateKey,
  retrievalCandidatesToRankedChannels,
  type ActiveEmbeddingGenerationDescriptor,
  type EvidenceRetrievalStageSnapshot,
  type RetrievalCandidate,
} from "../packages/retrieval/src/index.js";
import { queryKnowledge } from "../apps/api/src/routes/search.js";
import {
  aggregateObservedBenchmarkRun,
  diagnoseSingleUnitCorpusCase,
} from "./retrieval-stage-observation.js";

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
  gold_support?: Array<{
    id: string;
    document: string;
    all_terms: string[];
    any_terms?: string[];
  }>;
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

type QueryHit = Awaited<ReturnType<typeof queryKnowledge>>[number];

type UnitizedUnit = {
  id: string;
  body: string;
  embeddingEligible: boolean;
};

type RuntimeObservation = BenchmarkObservation & {
  stageDiagnostics: ReturnType<typeof diagnoseSingleUnitCorpusCase>;
  warnings: string[];
  availableChannels: string[];
  rankedVaultIds: string[];
  fusionReasons: Record<string, string[]>;
  candidateSignals: ReturnType<
    typeof assessRetrievalAnswerability
  >["candidateSignals"];
  answerability: Pick<
    ReturnType<typeof assessRetrievalAnswerability>,
    | "supported"
    | "reason"
    | "topVectorScore"
    | "secondVectorScore"
    | "thirdVectorScore"
    | "vectorMargin"
    | "vectorNeighborhoodMargin"
  >;
};

type StorageSnapshot = {
  documentsBytes: number;
  unitsBytes: number;
  relationsBytes: number;
  communityBytes: number;
  embeddingsBytes: number;
};

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required");
  return value;
})();
assertSyntheticFixtureDatabaseSafety(databaseUrl);

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

function numeric(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected finite numeric value, received ${String(value)}`);
  }
  return parsed;
}
function normalizedPredicateText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US");
}

function passageMatchesGoldPredicate(
  passage: string,
  predicate: NonNullable<GoldCase["gold_support"]>[number],
): boolean {
  const normalized = normalizedPredicateText(passage);
  const all = predicate.all_terms.every((term) =>
    normalized.includes(normalizedPredicateText(term)),
  );
  const any =
    !predicate.any_terms?.length ||
    predicate.any_terms.some((term) =>
      normalized.includes(normalizedPredicateText(term)),
    );
  return all && any;
}

async function storageSnapshot(db: Postgres): Promise<StorageSnapshot> {
  const result = await db.pool.query(
    `
    select
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
  if (!row) throw new Error("PostgreSQL did not return storage evidence.");
  return {
    documentsBytes: numeric(row.documents_bytes),
    unitsBytes: numeric(row.units_bytes),
    relationsBytes: numeric(row.relations_bytes),
    communityBytes: numeric(row.community_bytes),
    embeddingsBytes: numeric(row.embeddings_bytes),
  };
}

function storageDelta(after: StorageSnapshot, before: StorageSnapshot) {
  const delta = {
    documentsBytes: after.documentsBytes - before.documentsBytes,
    unitsBytes: after.unitsBytes - before.unitsBytes,
    relationsBytes: after.relationsBytes - before.relationsBytes,
    communityBytes: after.communityBytes - before.communityBytes,
    embeddingsBytes: after.embeddingsBytes - before.embeddingsBytes,
  };
  for (const [name, value] of Object.entries(delta)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Registered storage delta is invalid for ${name}.`);
    }
  }
  return delta;
}

function resourceRequirements(configuration: BenchmarkConfiguration) {
  return {
    lexical: configuration.channels.includes("lexical"),
    vector: configuration.channels.includes("vector"),
    typedGraph: configuration.channels.includes("graph"),
    contextPack: configuration.channels.includes("context-pack"),
    rerank: Boolean(configuration.deterministicRerank),
    associativePpr: Boolean(configuration.associativePpr),
    community:
      Boolean(configuration.communityGlobal) ||
      Boolean(configuration.communityDrift),
    queryDecomposition: Boolean(configuration.queryDecomposition),
  };
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
    [path.relative(repositoryRoot, manifestPath).replaceAll("\\", "/")]:
      sha256(manifestRaw),
    [path.relative(repositoryRoot, casesPath).replaceAll("\\", "/")]:
      sha256(casesRaw),
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

async function seedUnitizedCorpus(
  db: Postgres,
  manifest: ResolvedManifest,
  fixture: Fixture,
): Promise<Map<string, UnitizedUnit[]>> {
  const unitsByDocument = new Map<string, UnitizedUnit[]>();
  await db.pool.query(
    `insert into organizations(id,slug,name) values($1,$2,$3)`,
    [
      fixture.organizationId,
      `registered-unitized-${fixture.organizationId.slice(0, 8)}`,
      "Registered public product corpus unit-selection benchmark",
    ],
  );
  await db.pool.query(
    `insert into spaces(id,organization_id,slug,name,visibility,knowledge_repo_path)
     values($1,$2,$3,$4,'PRIVATE',$5)`,
    [
      fixture.spaceId,
      fixture.organizationId,
      `registered-unitized-${fixture.spaceId.slice(0, 8)}`,
      "Registered public product corpus unit-selection benchmark",
      `benchmark/registered-unitized/${fixture.spaceId}`,
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
        `benchmark/registered-unitized/${vault.id}`,
        `Registered unitized ${vault.kind}`,
        fixture.corpusRevision,
        `registered-unitized-${vault.id}-${vaultId.slice(0, 8)}`,
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
      if (!documentId) {
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
            unitization: "parseKnowledgeUnits",
          }),
          document.aliases,
          contentHash,
          Math.max(1, document.body.split(/\s+/u).length),
        ],
      );

      const parsedUnits = parseKnowledgeUnits(document.title, document.body);
      const ids = new Map(
        parsedUnits.map((unit) => [unit.unitKey, randomUUID()] as const),
      );
      const materialized: UnitizedUnit[] = [];
      for (const unit of parsedUnits) {
        const unitId = ids.get(unit.unitKey);
        if (!unitId) throw new Error(`Missing unit id for ${unit.unitKey}`);
        const parentUnitId = unit.parentUnitKey
          ? (ids.get(unit.parentUnitKey) ?? null)
          : null;
        await db.pool.query(
          `insert into knowledge_units(
             id,document_id,space_id,vault_id,unit_key,unit_type,heading_path,
             body,content_hash,corpus_revision,document_revision,lifecycle,
             trust_tier,source_ids,token_estimate,parent_unit_id,permissions,
             locator,structural_order,container_only,embedding_eligible
           ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,'ACTIVE',
                    'HUMAN_REVIEWED',$11,$12,$13,'{}'::jsonb,$14::jsonb,
                    $15,$16,$17)`,
          [
            unitId,
            documentId,
            fixture.spaceId,
            vaultId,
            unit.unitKey,
            unit.unitType,
            unit.headingPath,
            unit.body,
            unit.contentHash,
            fixture.corpusRevision,
            document.evidence,
            unit.tokenEstimate,
            parentUnitId,
            JSON.stringify(unit.locator),
            unit.structuralOrder,
            unit.containerOnly,
            unit.embeddingEligible,
          ],
        );
        materialized.push({
          id: unitId,
          body: unit.body,
          embeddingEligible: unit.embeddingEligible,
        });
      }
      unitsByDocument.set(document.id, materialized);
    }
  }
  return unitsByDocument;
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
    "lexical+vector+graph",
    "lexical+graph",
    "vector+graph",
    "context-pack+lexical+graph",
    "full-hybrid-rrf",
    "full-hybrid+rerank",
    "lexical+vector+graph+ppr",
    "lexical+vector+graph+community-drift",
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
  candidatePoolLimit?: number,
  disableAssertionRecall = false,
): Promise<RuntimeObservation> {
  const vaultId = fixture.vaultIds.get(testCase.vault);
  if (!vaultId) throw new Error(`Unknown case vault ${testCase.vault}`);
  const warnings: string[] = [];
  const availableChannels = new Set<
    "context-pack" | "exact" | "lexical" | "vector" | "graph" | "raw" | "code"
  >();
  const baseRuntimeOptions = {
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
      : configuration.communityDrift
        ? {
            retrievalPolicy: {
              graphMode: "DRIFT" as const,
              channels: {
                COMMUNITY: { enabled: true, weight: 1.1 },
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
    graphScopes: [{ vaultId, pathPrefix: null }],
    graphPolicy: { maxHops: 3, directionPolicy: "both" as const },
    ...(candidatePoolLimit === undefined
      ? {}
      : { benchmarkCandidatePoolLimit: candidatePoolLimit }),
    ...(disableAssertionRecall
      ? { benchmarkDisableAssertionRecall: true }
      : {}),
  };

  const started = performance.now();
  let answerabilityCandidates: readonly QueryHit[] | undefined;
  let candidateStages: EvidenceRetrievalStageSnapshot | undefined;
  const rawHits = await queryKnowledge(
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
      ...baseRuntimeOptions,
      warningSink: warnings,
      availableChannelSink: availableChannels,
      answerabilityCandidateSink: (candidates) => {
        answerabilityCandidates = candidates;
      },
      stageDiagnosticSink: (snapshot) => {
        candidateStages = snapshot;
      },
    },
  );
  const answerability = assessRetrievalAnswerability(
    rawHits,
    testCase.query,
    {},
    {
      allowGraphSupport: testCase.category === "graph",
      ...(answerabilityCandidates
        ? { comparisonHits: answerabilityCandidates }
        : {}),
    },
  );
  const supportedCandidateKeys = new Set(answerability.supportedCandidateKeys);
  const hits = rawHits.filter((hit) =>
    supportedCandidateKeys.has(retrievalAnswerabilityCandidateKey(hit)),
  );
  if (!answerability.supported && rawHits.length > 0) {
    warnings.push(`ANSWERABILITY_GATE_REJECTED:${answerability.reason}`);
  }
  const latencyMs = performance.now() - started;
  const depthHits =
    (testCase.gold_support?.length ?? 0) > 0
      ? await queryKnowledge(
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
            limit: 64,
          },
          baseRuntimeOptions,
        )
      : rawHits;
  const rankedDocumentIds = hits.flatMap((hit) =>
    hit.document.externalId ? [hit.document.externalId] : [],
  );
  const retrievedUnitIds = hits.flatMap((hit) =>
    hit.unitId ? [hit.unitId] : [],
  );
  const retrievedDocumentIds = hits.flatMap((hit) =>
    hit.unitId ? [] : [hit.documentId],
  );
  const retrievedEvidenceIds = hits.length
    ? (
        await db.pool.query<{ source_ids: string[] }>(
          `select source_ids
             from knowledge_units
            where corpus_revision=$3
              and (
                id=any($1::uuid[])
                or document_id=any($2::uuid[])
              )`,
          [retrievedUnitIds, retrievedDocumentIds, fixture.corpusRevision],
        )
      ).rows.flatMap((row) => row.source_ids)
    : [];
  const goldSupportIds = (testCase.gold_support ?? []).map(
    (predicate) => predicate.id,
  );
  const supportIdsForHits = (candidates: readonly QueryHit[]): string[] =>
    (testCase.gold_support ?? []).flatMap((predicate) =>
      candidates.some(
        (hit) =>
          hit.document.externalId === predicate.document &&
          passageMatchesGoldPredicate(
            hit.parentContext?.trim() || hit.excerpt,
            predicate,
          ),
      )
        ? [predicate.id]
        : [],
    );
  const retrievedGoldSupportIds = supportIdsForHits(rawHits);
  const goldSupportFirstRanks = (testCase.gold_support ?? []).map(
    (predicate) => {
      const index = depthHits.findIndex(
        (hit) =>
          hit.document.externalId === predicate.document &&
          passageMatchesGoldPredicate(
            hit.parentContext?.trim() || hit.excerpt,
            predicate,
          ),
      );
      return index < 0 ? null : index + 1;
    },
  );
  const retrievedSupportIds = supportIdsForHits(hits);
  const selectedGoldSupportCandidateCount = hits.filter((hit) =>
    (testCase.gold_support ?? []).some(
      (predicate) =>
        hit.document.externalId === predicate.document &&
        passageMatchesGoldPredicate(
          hit.parentContext?.trim() || hit.excerpt,
          predicate,
        ),
    ),
  ).length;
  for (const supportId of goldSupportIds) {
    if (!retrievedSupportIds.includes(supportId)) {
      warnings.push(`PREDICATE_SUPPORT_MISSED:${supportId}`);
    }
  }
  const stageDiagnostics = diagnoseSingleUnitCorpusCase({
    caseId: testCase.id,
    goldDocuments: testCase.gold_documents,
    expectNoAnswer: testCase.expect_no_answer === true,
    documentIds: fixture.documentIds,
    unitIds: fixture.unitIds,
    candidateStages,
    shortlist: rawHits,
    shortlistLimit: 10,
    admitted: hits,
    assessment: answerability,
  });
  return {
    stageDiagnostics,
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
    ...(testCase.gold_support !== undefined
      ? {
          goldSupportIds,
          retrievedGoldSupportIds,
          goldSupportFirstRanks,
          retrievedSupportIds,
          selectedSupportCandidateCount: hits.length,
          selectedGoldSupportCandidateCount,
        }
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
    ...(testCase.critical !== undefined ? { critical: testCase.critical } : {}),
    warnings: [...new Set(warnings)],
    availableChannels: [...availableChannels].sort(),
    rankedVaultIds: [...new Set(hits.map((hit) => hit.vaultId))],
    fusionReasons: Object.fromEntries(
      hits.map((hit) => [
        hit.document.externalId ?? hit.documentId,
        [...hit.reasons],
      ]),
    ),
    candidateSignals: answerability.candidateSignals,
    answerability: {
      supported: answerability.supported,
      reason: answerability.reason,
      topVectorScore: answerability.topVectorScore,
      secondVectorScore: answerability.secondVectorScore,
      thirdVectorScore: answerability.thirdVectorScore,
      vectorMargin: answerability.vectorMargin,
      vectorNeighborhoodMargin: answerability.vectorNeighborhoodMargin,
    },
  };
}

function candidatePoolMeasurement(observations: readonly RuntimeObservation[]) {
  let expectedTargets = 0;
  let foundTargets = 0;
  const firstGoldRanks: number[] = [];
  const perChannelFound = new Map<string, number>();
  for (const observation of observations) {
    for (const target of observation.stageDiagnostics.expected) {
      expectedTargets += 1;
      const candidate = observation.stageDiagnostics.candidateTrace.find(
        (entry) =>
          entry.documentId === target.documentId &&
          entry.unitId === target.unitId,
      );
      if (!candidate) continue;
      foundTargets += 1;
      firstGoldRanks.push(candidate.rank);
      for (const channel of new Set(
        candidate.channels.map((entry) => entry.channel),
      )) {
        perChannelFound.set(channel, (perChannelFound.get(channel) ?? 0) + 1);
      }
    }
  }
  return {
    answerableGoldTargets: expectedTargets,
    candidateGoldTargetsFound: foundTargets,
    candidatePoolRecall:
      expectedTargets === 0 ? null : foundTargets / expectedTargets,
    meanFirstGoldRank:
      firstGoldRanks.length === 0
        ? null
        : firstGoldRanks.reduce((sum, value) => sum + value, 0) /
          firstGoldRanks.length,
    candidateMisses: expectedTargets - foundTargets,
    perChannelGoldCoverage: Object.fromEntries(
      [...perChannelFound.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([channel, count]) => [
          channel,
          expectedTargets === 0 ? null : count / expectedTargets,
        ]),
    ),
  };
}

function rankOfAny(
  rankedIds: readonly string[],
  goldIds: ReadonlySet<string>,
): number | null {
  const index = rankedIds.findIndex((id) => goldIds.has(id));
  return index < 0 ? null : index + 1;
}

function summarizeUnitRanks(ranks: readonly (number | null)[]) {
  const found = ranks.filter((rank): rank is number => rank !== null);
  return {
    cases: ranks.length,
    recallAt10:
      ranks.length === 0
        ? null
        : ranks.filter((rank) => rank !== null && rank <= 10).length /
          ranks.length,
    mrr:
      ranks.length === 0
        ? null
        : ranks.reduce(
            (sum, rank) => sum + (rank === null ? 0 : 1 / rank),
            0,
          ) / ranks.length,
    meanFoundRank:
      found.length === 0
        ? null
        : found.reduce((sum, rank) => sum + rank, 0) / found.length,
  };
}

async function runUnitSelectionStudy(
  db: Postgres,
  dataset: {
    manifest: ResolvedManifest;
    cases: GoldCase[];
  },
  fixture: Fixture,
  adapter: LocalSemanticEmbeddingAdapter,
  queryEmbeddingService: QueryEmbeddingService,
) {
  const unitsByDocument = await seedUnitizedCorpus(
    db,
    dataset.manifest,
    fixture,
  );
  const generations = await buildRealEmbeddings(
    db,
    dataset.manifest,
    fixture,
    adapter,
  );
  const labelled = dataset.cases.filter(
    (testCase) => (testCase.gold_support?.length ?? 0) > 0,
  );
  const policy = resolveRetrievalPolicy();
  const results = [];
  const unresolvedPredicates: string[] = [];

  for (const testCase of labelled) {
    const vaultId = fixture.vaultIds.get(testCase.vault);
    if (!vaultId) throw new Error(`Unknown case vault ${testCase.vault}`);
    const goldUnitIds = new Set<string>();
    const unresolvedForCase: string[] = [];
    for (const predicate of testCase.gold_support ?? []) {
      const matches = (unitsByDocument.get(predicate.document) ?? []).filter(
        (unit) =>
          unit.embeddingEligible &&
          passageMatchesGoldPredicate(unit.body, predicate),
      );
      if (matches.length === 0) {
        unresolvedForCase.push(predicate.id);
        unresolvedPredicates.push(predicate.id);
        continue;
      }
      for (const match of matches) goldUnitIds.add(match.id);
    }
    if (unresolvedForCase.length > 0 || goldUnitIds.size === 0) {
      results.push({
        caseId: testCase.id,
        status: "UNRESOLVED_GOLD_UNIT",
        unresolvedPredicates: unresolvedForCase,
      });
      continue;
    }

    let snapshot: EvidenceRetrievalStageSnapshot | undefined;
    const currentHits = await queryKnowledge(
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
        channels: ["lexical", "vector"],
        allowVectorForBenchmark: true,
        queryEmbeddingService,
        stageDiagnosticSink: (value) => {
          snapshot = value;
        },
      },
    );
    if (!snapshot) {
      throw new Error(`Missing stage diagnostics for ${testCase.id}`);
    }

    const keyToUnitId = new Map<string, string>();
    const unitCandidates: RetrievalCandidate[] = [];
    for (const candidate of snapshot.channelCandidateTrace ?? []) {
      if (
        !candidate.unitId ||
        (candidate.channel !== "LEXICAL" && candidate.channel !== "VECTOR")
      ) {
        continue;
      }
      const candidateId = `${candidate.documentId}:${candidate.unitId}`;
      keyToUnitId.set(candidateId, candidate.unitId);
      unitCandidates.push({
        candidateId,
        channel: candidate.channel,
        rank: candidate.rank,
        ...(candidate.rawScore === null
          ? {}
          : { rawScore: candidate.rawScore }),
        scopeId: fixture.spaceId,
        documentId: candidate.documentId,
        unitId: candidate.unitId,
        revision: fixture.corpusRevision,
        selectionReason: candidate.selectionReason,
      });
    }
    const unitRanked = reciprocalRankFusion(
      retrievalCandidatesToRankedChannels(unitCandidates, policy),
    );
    const currentUnitIds = currentHits.flatMap((hit) =>
      hit.unitId ? [hit.unitId] : [],
    );
    const unitKeyedIds = unitRanked.flatMap((item) => {
      const unitId = keyToUnitId.get(item.id);
      return unitId ? [unitId] : [];
    });
    const candidateGoldPresent = (snapshot.channelCandidateTrace ?? []).some(
      (candidate) =>
        candidate.unitId !== null && goldUnitIds.has(candidate.unitId),
    );

    results.push({
      caseId: testCase.id,
      status: "MEASURED",
      goldUnitAlternatives: goldUnitIds.size,
      candidateGoldPresent,
      currentDocumentKeyedRank: rankOfAny(currentUnitIds, goldUnitIds),
      unitKeyedRrfRank: rankOfAny(unitKeyedIds, goldUnitIds),
    });
  }

  const measured = results.filter(
    (
      result,
    ): result is {
      caseId: string;
      status: "MEASURED";
      goldUnitAlternatives: number;
      candidateGoldPresent: boolean;
      currentDocumentKeyedRank: number | null;
      unitKeyedRrfRank: number | null;
    } => result.status === "MEASURED",
  );
  const candidateGoldCoverage =
    measured.length === 0
      ? null
      : measured.filter((result) => result.candidateGoldPresent).length /
        measured.length;
  const current = summarizeUnitRanks(
    measured.map((result) => result.currentDocumentKeyedRank),
  );
  const unitKeyed = summarizeUnitRanks(
    measured.map((result) => result.unitKeyedRrfRank),
  );
  const comparable =
    unresolvedPredicates.length === 0 &&
    candidateGoldCoverage === 1 &&
    current.recallAt10 !== null &&
    unitKeyed.recallAt10 !== null &&
    current.mrr !== null &&
    unitKeyed.mrr !== null;
  const epsilon = 1e-12;
  const decision = !comparable
    ? "INCONCLUSIVE"
    : unitKeyed.recallAt10! > current.recallAt10! + epsilon ||
        (Math.abs(unitKeyed.recallAt10! - current.recallAt10!) <= epsilon &&
          unitKeyed.mrr! > current.mrr! + epsilon)
      ? "PROMOTE"
      : "REJECT";

  return {
    status: "MEASURED",
    independentVariable: "fusionIdentity",
    arms: ["DOCUMENT_KEYED_CURRENT", "UNIT_KEYED_RRF"],
    corpusProjection: "FRESH_PARSE_KNOWLEDGE_UNITS",
    casesLabelled: labelled.length,
    casesMeasured: measured.length,
    unresolvedPredicates: [...new Set(unresolvedPredicates)].sort(),
    candidateGoldCoverage,
    currentDocumentKeyed: current,
    unitKeyedRrf: unitKeyed,
    delta: {
      recallAt10:
        current.recallAt10 === null || unitKeyed.recallAt10 === null
          ? null
          : unitKeyed.recallAt10 - current.recallAt10,
      mrr:
        current.mrr === null || unitKeyed.mrr === null
          ? null
          : unitKeyed.mrr - current.mrr,
    },
    decision,
    productionDefaultChanged: false,
    generationCount: generations.length,
    goldDerivation:
      "Gold units are derived only from versioned gold_support predicates matched against embedding-eligible parseKnowledgeUnits output; no private vocabulary or manual unit labels are added.",
    claimBoundary:
      "This registered public-product slice isolates document-keyed versus unit-keyed fusion. Only a PROMOTE result may justify a later runtime change; this measurement does not change production behavior.",
    results,
  };
}

async function main(): Promise<void> {
  const repositoryState = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim(),
    workingTreeDirty:
      execFileSync("git", ["status", "--porcelain"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }).trim().length > 0,
  };
  const previousVectorEnabled = process.env.AKP_VECTOR_ENABLED;
  process.env.AKP_VECTOR_ENABLED = "true";
  const db = new Postgres(databaseUrl);
  const dataset = await loadDataset();
  const fixture = createFixture(dataset.manifest);
  const unitSelectionFixture = createFixture(dataset.manifest);
  const adapter = new LocalSemanticEmbeddingAdapter({
    ...(process.env.AKP_MODEL_CACHE_DIR?.trim()
      ? { cacheDir: process.env.AKP_MODEL_CACHE_DIR }
      : {}),
    localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
    maxBatchSize: 8,
  });

  try {
    const postgresVersionResult = await db.pool.query<{
      server_version: string;
    }>("show server_version");
    const postgresVersion =
      postgresVersionResult.rows[0]?.server_version ?? "UNKNOWN";
    const storageBeforeFixture = await storageSnapshot(db);
    await seedCorpus(db, dataset.manifest, fixture);
    const storageAfterFixture = await storageSnapshot(db);
    await buildCommunityIndexes(db, dataset.manifest, fixture);
    const storageAfterCommunities = await storageSnapshot(db);
    await adapter.load();
    const generations = await buildRealEmbeddings(
      db,
      dataset.manifest,
      fixture,
      adapter,
    );
    const storageAfterEmbeddings = await storageSnapshot(db);
    const queryEmbeddingService = new QueryEmbeddingService(
      async () => adapter,
    );
    const configurations = benchmarkConfigurations();
    const runs: Array<
      ReturnType<typeof aggregateObservedBenchmarkRun<RuntimeObservation>>
    > = [];
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
      runs.push(aggregateObservedBenchmarkRun(configuration, observations));
    }

    const candidateDepths = [20, 50, 100] as const;
    const candidateDepthConfiguration = configurations.find(
      (configuration) => configuration.name === "full-hybrid-rrf",
    );
    if (
      !candidateDepthConfiguration ||
      !candidateDepthConfiguration.allowVectorForBenchmark
    ) {
      throw new Error(
        "Registered candidate-depth study requires full-hybrid-rrf with benchmark vector access.",
      );
    }
    const candidateDepthStudy = [];
    for (const depth of candidateDepths) {
      const observations: RuntimeObservation[] = [];
      for (const testCase of dataset.cases) {
        observations.push(
          await executeCase(
            db,
            fixture,
            testCase,
            candidateDepthConfiguration,
            queryEmbeddingService,
            depth,
          ),
        );
      }
      candidateDepthStudy.push({
        depth,
        configuration: candidateDepthConfiguration.name,
        ...candidatePoolMeasurement(observations),
      });
    }

    const fullHybridRun = runs.find(
      (run) => run.configurationName === candidateDepthConfiguration.name,
    );
    if (!fullHybridRun) {
      throw new Error(
        "Registered full-hybrid run missing for assertion study.",
      );
    }
    const assertionRecallDisabledObservations: RuntimeObservation[] = [];
    for (const testCase of dataset.cases) {
      assertionRecallDisabledObservations.push(
        await executeCase(
          db,
          fixture,
          testCase,
          candidateDepthConfiguration,
          queryEmbeddingService,
          undefined,
          true,
        ),
      );
    }
    const assertionRecallStudy = {
      independentVariable: "assertionRecall",
      configuration: candidateDepthConfiguration.name,
      productionDefaultChanged: false,
      current: candidatePoolMeasurement(fullHybridRun.results),
      disabled: candidatePoolMeasurement(assertionRecallDisabledObservations),
      claimBoundary:
        "This isolates the residual lexical assertion-recall path on the registered corpus; it does not alter production selection.",
    };
    const unitSelectionStudy = await runUnitSelectionStudy(
      db,
      dataset,
      unitSelectionFixture,
      adapter,
      queryEmbeddingService,
    );

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
    const baselineRun = runs.find(
      (run) => run.configurationName === "exact+lexical",
    );
    if (!baselineRun) {
      throw new Error("Registered benchmark requires exact+lexical baseline.");
    }

    const fixtureStorage = storageDelta(
      storageAfterFixture,
      storageBeforeFixture,
    );
    const communityStorage = storageDelta(
      storageAfterCommunities,
      storageAfterFixture,
    );
    const embeddingStorage = storageDelta(
      storageAfterEmbeddings,
      storageAfterCommunities,
    );
    const storageComponents = {
      corpusDocumentsAndUnits:
        fixtureStorage.documentsBytes + fixtureStorage.unitsBytes,
      typedGraphRelations: fixtureStorage.relationsBytes,
      communityIndex: communityStorage.communityBytes,
      vectorIndex: embeddingStorage.embeddingsBytes,
    };
    const attributedStorageBytes = (
      configuration: BenchmarkConfiguration,
    ): number => {
      const requirements = resourceRequirements(configuration);
      return (
        storageComponents.corpusDocumentsAndUnits +
        (requirements.typedGraph ? storageComponents.typedGraphRelations : 0) +
        (requirements.vector ? storageComponents.vectorIndex : 0) +
        (requirements.community ? storageComponents.communityIndex : 0)
      );
    };

    const ablationStages = [
      { stage: "BASELINE_EXACT_LEXICAL", configuration: "exact+lexical" },
      { stage: "ADD_DENSE", configuration: "lexical+vector" },
      {
        stage: "ADD_TYPED_GRAPH",
        configuration: "lexical+vector+graph",
      },
      { stage: "ADD_RERANK", configuration: "full-hybrid+rerank" },
      {
        stage: "ADD_PPR",
        configuration: "lexical+vector+graph+ppr",
      },
      {
        stage: "ADD_COMMUNITY",
        configuration: "lexical+vector+graph+community-global",
      },
    ] as const;
    const ablationEntries = ablationStages.map((entry, index) => {
      const run = runs.find(
        (candidate) => candidate.configurationName === entry.configuration,
      );
      const configuration = configurations.find(
        (candidate) => candidate.name === entry.configuration,
      );
      if (!run || !configuration) {
        throw new Error(
          `Registered ablation configuration missing: ${entry.configuration}`,
        );
      }
      const previous =
        index === 0
          ? baselineRun
          : runs.find(
              (candidate) =>
                candidate.configurationName ===
                ablationStages[index - 1]!.configuration,
            );
      if (!previous) {
        throw new Error(
          `Registered ablation predecessor missing: ${entry.configuration}`,
        );
      }
      return {
        stage: entry.stage,
        configuration: entry.configuration,
        requirements: resourceRequirements(configuration),
        quality: {
          recallAt10: run.meanRecallAt10,
          mrr: run.meanReciprocalRank,
          ndcgAt10: run.meanNdcgAt10,
        },
        deltaVsBaseline: {
          recallAt10: run.meanRecallAt10 - baselineRun.meanRecallAt10,
          mrr: run.meanReciprocalRank - baselineRun.meanReciprocalRank,
          ndcgAt10: run.meanNdcgAt10 - baselineRun.meanNdcgAt10,
        },
        deltaVsPrevious: {
          recallAt10: run.meanRecallAt10 - previous.meanRecallAt10,
          mrr: run.meanReciprocalRank - previous.meanReciprocalRank,
          ndcgAt10: run.meanNdcgAt10 - previous.meanNdcgAt10,
        },
        latency: {
          meanMs: run.meanLatencyMs,
          deltaVsBaselineMs: run.meanLatencyMs - baselineRun.meanLatencyMs,
          deltaVsPreviousMs: run.meanLatencyMs - previous.meanLatencyMs,
        },
        storage: {
          attributedBytes: attributedStorageBytes(configuration),
          attribution:
            "Sum of measured PostgreSQL total-relation-size deltas for shared persisted components required by this configuration; not an isolated deployment total.",
        },
      };
    });

    const sortedFixtureHashes = Object.entries(dataset.hashes).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    const fixtureHash = sha256(JSON.stringify(sortedFixtureHashes));
    const configurationHash = sha256(
      JSON.stringify({
        configurations: configurations.map((configuration) => ({
          ...configuration,
          channels: [...configuration.channels],
        })),
        candidateDepthStudy: {
          configuration: candidateDepthConfiguration.name,
          depths: candidateDepths,
        },
        assertionRecallStudy: {
          configuration: candidateDepthConfiguration.name,
          variants: ["current", "disabled"],
        },
        unitSelectionStudy: {
          corpusProjection: "FRESH_PARSE_KNOWLEDGE_UNITS",
          variants: ["DOCUMENT_KEYED_CURRENT", "UNIT_KEYED_RRF"],
          labelledCases: dataset.cases.filter(
            (testCase) => (testCase.gold_support?.length ?? 0) > 0,
          ).length,
        },
      }),
    );
    const cpu = os.cpus();
    const reproducibility = {
      tool: {
        repositoryUrl:
          "https://github.com/David-std/Architecture-Knowledge-Platform",
        versionOrCommit: process.env.GITHUB_SHA ?? repositoryState.commit,
        checkoutCommit: repositoryState.commit,
        workingTreeDirty: repositoryState.workingTreeDirty,
        licenseObserved: "NOT_DECLARED_IN_REPOSITORY",
      },
      configuration: {
        sha256: configurationHash,
        configurations: configurations.map((configuration) => ({
          ...configuration,
          channels: [...configuration.channels],
        })),
      },
      environment: {
        node: process.version,
        postgres: postgresVersion,
        platform: os.platform(),
        release: os.release(),
        architecture: os.arch(),
        logicalCpuCount: cpu.length,
        cpuModel: cpu[0]?.model ?? "UNKNOWN",
        totalMemoryBytes: os.totalmem(),
        runnerEnvironment: process.env.RUNNER_ENVIRONMENT ?? null,
      },
      fixture: {
        sha256: fixtureHash,
        fileHashes: Object.fromEntries(sortedFixtureHashes),
      },
      invocation: "pnpm benchmark:retrieval:registered",
    };
    const ablation = {
      baseline: "exact+lexical",
      entries: ablationEntries,
      storageComponents,
      optionalChannels: {
        lateInteraction: {
          status: "NOT_RETAINED",
          reason:
            "No late-interaction production channel is retained in the registered v0.4 retrieval matrix; the Deep Spec makes this ablation conditional on retention.",
        },
      },
      claimBoundary:
        "Ablation deltas describe this registered public-product corpus and current CI environment only; they do not select a production default.",
    };

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
          "Stage diagnostics retain gold document/unit identities, but exact gold spans and final generation are not annotated or measured by this pack.",
          "The corpus is the product's own public documentation, not a private customer vault or production traffic sample.",
          "The primary comparison matrix retains its one-unit-per-document compatibility projection; unitSelectionStudy separately rebuilds the same public Markdown with production parseKnowledgeUnits for a controlled multi-unit comparison.",
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
        postgres: postgresVersion,
        queryImplementation: "apps/api/src/routes/search.ts#queryKnowledge",
      },
      reproducibility,
      ablation,
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
      candidateDepthStudy: {
        independentVariable: "candidatePoolLimit",
        productionDefaultChanged: false,
        measurements: candidateDepthStudy,
        claimBoundary:
          "Depth measurements use the same registered corpus and full-hybrid retrieval configuration; they do not select a production default.",
      },
      assertionRecallStudy,
      unitSelectionStudy,
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
          candidateDepthStudy: report.candidateDepthStudy,
          assertionRecallStudy: report.assertionRecallStudy,
          unitSelectionStudy: report.unitSelectionStudy,
          productionDefault: report.productionDefault,
          reproducibility: {
            commit: report.reproducibility.tool.versionOrCommit,
            fixtureHash: report.reproducibility.fixture.sha256,
            configurationHash: report.reproducibility.configuration.sha256,
          },
          ablation: report.ablation.entries.map((entry) => ({
            stage: entry.stage,
            configuration: entry.configuration,
            deltaRecallAt10: entry.deltaVsBaseline.recallAt10,
            deltaLatencyMs: entry.latency.deltaVsBaselineMs,
            attributedStorageBytes: entry.storage.attributedBytes,
          })),
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
      await cleanupCorpus(db, unitSelectionFixture);
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
}

await main();
