import "dotenv/config";

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Postgres } from "@akp/postgres";
import { buildEmbeddingIndex } from "../packages/indexing/src/index.js";
import {
  LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR,
  LocalSemanticEmbeddingAdapter,
  withEmbeddingPassageContext,
} from "../packages/retrieval/src/index.js";

type Locator = {
  kind: string;
  documentId: string;
  startLine: number;
  endLine: number;
};

type FixtureChunk = {
  id: string;
  headingPath: string[];
  body: string;
  locator: Locator;
};

type FixtureDocument = {
  id: string;
  title: string;
  parentContext: string;
  chunks: FixtureChunk[];
};

type FixtureQuery = {
  id: string;
  text: string;
  requiredChunkIds: string[];
  relevantChunkIds: string[];
};

type Fixture = {
  schemaVersion: number;
  evidenceLevel: string;
  productionDefaultsChanged: boolean;
  topK: number;
  documents: FixtureDocument[];
  queries: FixtureQuery[];
};

type RankedObservation = {
  queryId: string;
  requiredChunkIds: string[];
  relevantChunkIds: string[];
  rankedChunkIds: string[];
  firstGoldRank: number | null;
};

type ArmMetrics = {
  recallAt1: number;
  recallAtK: number;
  mrr: number;
  contextPrecisionAtK: number;
  meanQueryLatencyMs: number;
  observations: RankedObservation[];
};

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const fixturePath = path.join(
  repositoryRoot,
  "evals",
  "registered",
  "contextual-chunk-benchmark.json",
);
const outputPath = path.resolve(
  repositoryRoot,
  process.env.AKP_CONTEXTUAL_PERSISTED_REPORT ??
    "reports/ci/contextual-title-heading-persisted-generation.json",
);
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pgVector(values: readonly number[]): string {
  if (
    values.length !== LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.dimensions ||
    values.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("Invalid query vector.");
  }
  return "[" + values.join(",") + "]";
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

async function seedFixture(
  db: Postgres,
  fixture: Fixture,
  corpusRevision: string,
): Promise<{
  organizationId: string;
  spaceId: string;
  vaultId: string;
  unitCount: number;
}> {
  const organizationId = randomUUID();
  const spaceId = randomUUID();
  const vaultId = randomUUID();

  await db.pool.query(
    `insert into organizations(id,slug,name) values($1,$2,$3)`,
    [
      organizationId,
      "ctx-" + organizationId.slice(0, 8),
      "Contextual persisted generation benchmark",
    ],
  );
  await db.pool.query(
    `insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values($1,$2,$3,$4,'PRIVATE',$5)`,
    [
      spaceId,
      organizationId,
      "ctx-" + spaceId.slice(0, 8),
      "Contextual persisted generation benchmark",
      "/tmp/akp-contextual-" + spaceId,
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
      "/tmp/akp-contextual-" + vaultId,
      "Contextual persisted generation benchmark",
      corpusRevision,
      "ctx-" + vaultId.slice(0, 8),
    ],
  );
  await db.pool.query(
    `insert into vault_index_revisions(
       space_id,vault_id,corpus_revision,lexical_revision,graph_revision,
       context_pack_revision,status,warnings
     ) values($1,$2,$3,$3,$3,$3,'DEGRADED','[]'::jsonb)`,
    [spaceId, vaultId, corpusRevision],
  );

  let structuralOrder = 0;
  for (const document of fixture.documents) {
    const documentId = randomUUID();
    const bodyCache = document.chunks.map((chunk) => chunk.body).join("\n\n");
    await db.pool.query(
      `insert into knowledge_documents(
         id,space_id,vault_id,path,external_id,title,type,lifecycle,
         trust_tier,current_revision,body_cache,frontmatter,aliases,layer,
         content_hash,token_estimate,raw_links
       ) values(
         $1,$2,$3,$4,$5,$6,'concept','ACTIVE','HUMAN_REVIEWED',$7,$8,
         $9::jsonb,'{}','concept',$10,$11,'[]'::jsonb
       )`,
      [
        documentId,
        spaceId,
        vaultId,
        "benchmark/" + document.id + ".md",
        document.id,
        document.title,
        corpusRevision,
        bodyCache,
        JSON.stringify({
          id: document.id,
          title: document.title,
          benchmark: fixture.evidenceLevel,
        }),
        sha256(bodyCache),
        Math.max(1, Math.ceil(bodyCache.length / 4)),
      ],
    );

    for (const chunk of document.chunks) {
      const contentHash = sha256(chunk.body);
      await db.pool.query(
        `insert into knowledge_units(
           id,document_id,space_id,vault_id,unit_key,unit_type,heading_path,
           body,content_hash,corpus_revision,lifecycle,trust_tier,source_ids,
           token_estimate,document_revision,permissions,locator,structural_order,
           container_only,embedding_eligible
         ) values(
           $1,$2,$3,$4,$5,'PARAGRAPH',$6,$7,$8,$9,'ACTIVE','HUMAN_REVIEWED',
           '{}',$10,$9,'{}'::jsonb,$11::jsonb,$12,false,true
         )`,
        [
          randomUUID(),
          documentId,
          spaceId,
          vaultId,
          chunk.id,
          chunk.headingPath,
          chunk.body,
          contentHash,
          corpusRevision,
          Math.max(1, Math.ceil(chunk.body.length / 4)),
          JSON.stringify(chunk.locator),
          structuralOrder++,
        ],
      );
    }
  }

  return {
    organizationId,
    spaceId,
    vaultId,
    unitCount: fixture.documents.reduce(
      (sum, document) => sum + document.chunks.length,
      0,
    ),
  };
}

async function measureGeneration(
  db: Postgres,
  generationId: string,
  fixture: Fixture,
  queryVectors: readonly number[][],
  corpusRevision: string,
): Promise<ArmMetrics> {
  const observations: RankedObservation[] = [];
  let queryLatencyMs = 0;

  for (const [index, query] of fixture.queries.entries()) {
    const queryVector = queryVectors[index];
    if (!queryVector) throw new Error("Missing query vector for " + query.id + ".");
    const started = performance.now();
    const ranked = await db.pool.query<{ unit_key: string; score: number }>(
      `select u.unit_key,
              (1 - (e.embedding <=> $2::vector))::float8 score
         from unit_embeddings e
         join knowledge_units u on u.id=e.unit_id
        where e.generation_id=$1
          and u.corpus_revision=$3
          and u.lifecycle in ('ACTIVE','DISPUTED')
        order by e.embedding <=> $2::vector asc,u.unit_key asc
        limit $4`,
      [generationId, pgVector(queryVector), corpusRevision, fixture.topK],
    );
    queryLatencyMs += performance.now() - started;
    const rankedChunkIds = ranked.rows.map((row) => row.unit_key);
    const gold = new Set(query.requiredChunkIds);
    const firstGoldIndex = rankedChunkIds.findIndex((id) => gold.has(id));
    observations.push({
      queryId: query.id,
      requiredChunkIds: query.requiredChunkIds,
      relevantChunkIds: query.relevantChunkIds,
      rankedChunkIds,
      firstGoldRank: firstGoldIndex < 0 ? null : firstGoldIndex + 1,
    });
  }

  const recallAt1 = rate(
    observations.filter((row) => row.firstGoldRank === 1).length,
    observations.length,
  );
  const recallAtK = rate(
    observations.filter((row) => row.firstGoldRank !== null).length,
    observations.length,
  );
  const mrr = rate(
    observations.reduce(
      (sum, row) =>
        sum + (row.firstGoldRank === null ? 0 : 1 / row.firstGoldRank),
      0,
    ),
    observations.length,
  );
  let relevantRetrieved = 0;
  let totalRetrieved = 0;
  for (const observation of observations) {
    const relevant = new Set(observation.relevantChunkIds);
    relevantRetrieved += observation.rankedChunkIds.filter((id) =>
      relevant.has(id),
    ).length;
    totalRetrieved += observation.rankedChunkIds.length;
  }

  return {
    recallAt1,
    recallAtK,
    mrr,
    contextPrecisionAtK: rate(relevantRetrieved, totalRetrieved),
    meanQueryLatencyMs: queryLatencyMs / Math.max(1, fixture.queries.length),
    observations,
  };
}

async function generationEvidence(
  db: Postgres,
  generationId: string,
): Promise<{
  status: string;
  inputStrategy: string;
  vectorRows: number;
  matchingInputHashes: number;
  complete: boolean;
}> {
  const generation = await db.pool.query<{
    status: string;
    input_strategy: string;
  }>(
    `select status,input_strategy from embedding_generations where id=$1`,
    [generationId],
  );
  const rows = await db.pool.query<{
    vector_rows: number;
    matching_input_hashes: number;
  }>(
    `select count(*)::int vector_rows,
            count(*) filter(
              where e.input_hash=akp_embedding_passage_input_hash(
                g.input_strategy,d.title,u.heading_path,u.body
              )
            )::int matching_input_hashes
       from unit_embeddings e
       join embedding_generations g on g.id=e.generation_id
       join knowledge_units u on u.id=e.unit_id
       join knowledge_documents d on d.id=u.document_id
      where e.generation_id=$1`,
    [generationId],
  );
  const complete = await db.pool.query<{ complete: boolean }>(
    `select akp_embedding_generation_is_complete($1) complete`,
    [generationId],
  );
  const current = generation.rows[0];
  const counts = rows.rows[0];
  if (!current || !counts) throw new Error("Persisted generation evidence is missing.");
  return {
    status: current.status,
    inputStrategy: current.input_strategy,
    vectorRows: Number(counts.vector_rows),
    matchingInputHashes: Number(counts.matching_input_hashes),
    complete: complete.rows[0]?.complete === true,
  };
}

async function cleanup(
  db: Postgres,
  ids: { organizationId: string; spaceId: string; vaultId: string },
): Promise<void> {
  await db.pool.query("delete from vault_index_revisions where vault_id=$1", [
    ids.vaultId,
  ]);
  await db.pool.query("delete from embedding_generations where vault_id=$1", [
    ids.vaultId,
  ]);
  await db.pool.query("delete from knowledge_documents where vault_id=$1", [
    ids.vaultId,
  ]);
  await db.pool.query("delete from vaults where id=$1", [ids.vaultId]);
  await db.pool.query("delete from spaces where id=$1", [ids.spaceId]);
  await db.pool.query("delete from organizations where id=$1", [
    ids.organizationId,
  ]);
}

const fixtureRaw = await readFile(fixturePath, "utf8");
const fixture = JSON.parse(fixtureRaw) as Fixture;
if (
  fixture.schemaVersion !== 1 ||
  fixture.productionDefaultsChanged !== false ||
  !Number.isSafeInteger(fixture.topK) ||
  fixture.topK < 1 ||
  fixture.queries.length < 1
) {
  throw new Error("Contextual persisted benchmark fixture is invalid.");
}

const db = new Postgres(databaseUrl);
const corpusRevision =
  "contextual-persisted-" + sha256(fixtureRaw).slice(0, 16);
const provider = new LocalSemanticEmbeddingAdapter({
  ...(process.env.AKP_MODEL_CACHE_DIR?.trim()
    ? { cacheDir: process.env.AKP_MODEL_CACHE_DIR }
    : {}),
  localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
  maxBatchSize: 16,
});
const contextual = withEmbeddingPassageContext(provider, "title-heading-v1");
let ids:
  | {
      organizationId: string;
      spaceId: string;
      vaultId: string;
      unitCount: number;
    }
  | undefined;

try {
  ids = await seedFixture(db, fixture, corpusRevision);
  await provider.load();
  const queryVectors = await provider.embedQueries(
    fixture.queries.map((query) => query.text),
  );

  const rawStarted = performance.now();
  const rawBuild = await buildEmbeddingIndex(db, {
    spaceId: ids.spaceId,
    vaultId: ids.vaultId,
    corpusRevision,
    provider,
    activate: false,
  });
  const rawBuildLatencyMs = performance.now() - rawStarted;

  const contextualStarted = performance.now();
  const contextualBuild = await buildEmbeddingIndex(db, {
    spaceId: ids.spaceId,
    vaultId: ids.vaultId,
    corpusRevision,
    provider: contextual,
    activate: false,
  });
  const contextualBuildLatencyMs = performance.now() - contextualStarted;

  if (
    rawBuild.generation.generationId === contextualBuild.generation.generationId
  ) {
    throw new Error("Contextual and body-only generations must be distinct.");
  }
  if (
    rawBuild.embeddingsCreated !== ids.unitCount ||
    contextualBuild.embeddingsCreated !== ids.unitCount ||
    rawBuild.embeddingsReused !== 0 ||
    contextualBuild.embeddingsReused !== 0
  ) {
    throw new Error("Benchmark generations were not freshly inferred.");
  }

  const [rawPersisted, contextualPersisted] = await Promise.all([
    generationEvidence(db, rawBuild.generation.generationId),
    generationEvidence(db, contextualBuild.generation.generationId),
  ]);
  for (const evidence of [rawPersisted, contextualPersisted]) {
    if (
      evidence.status !== "READY" ||
      evidence.vectorRows !== ids.unitCount ||
      evidence.matchingInputHashes !== ids.unitCount ||
      evidence.complete !== true
    ) {
      throw new Error("Persisted generation is incomplete or fingerprint-invalid.");
    }
  }

  const [rawMetrics, contextualMetrics] = await Promise.all([
    measureGeneration(
      db,
      rawBuild.generation.generationId,
      fixture,
      queryVectors,
      corpusRevision,
    ),
    measureGeneration(
      db,
      contextualBuild.generation.generationId,
      fixture,
      queryVectors,
      corpusRevision,
    ),
  ]);

  const epsilon = 1e-12;
  const noRegression =
    contextualMetrics.recallAt1 + epsilon >= rawMetrics.recallAt1 &&
    contextualMetrics.recallAtK + epsilon >= rawMetrics.recallAtK &&
    contextualMetrics.mrr + epsilon >= rawMetrics.mrr;
  const improved =
    contextualMetrics.recallAt1 > rawMetrics.recallAt1 + epsilon ||
    contextualMetrics.recallAtK > rawMetrics.recallAtK + epsilon ||
    contextualMetrics.mrr > rawMetrics.mrr + epsilon;
  const outcome = !noRegression
    ? "REJECT"
    : improved
      ? "PROMOTE"
      : "INCONCLUSIVE";

  const report = {
    schemaVersion: 1,
    benchmark: "CONTEXTUAL_TITLE_HEADING_PERSISTED_GENERATION",
    generatedAt: new Date().toISOString(),
    outcome,
    promotionScope:
      outcome === "PROMOTE"
        ? "retain-title-heading-v1-as-benchmark-gated-option"
        : "none",
    productionDefaultsChanged: false,
    retrievalOnly: true,
    admissionMeasured: false,
    fixture: {
      path: path.relative(repositoryRoot, fixturePath),
      sha256: sha256(fixtureRaw),
      evidenceLevel: fixture.evidenceLevel,
      documents: fixture.documents.length,
      units: ids.unitCount,
      queries: fixture.queries.length,
      topK: fixture.topK,
    },
    corpusRevision,
    singleIndependentVariable:
      "Embedding passage input only: canonical unit body versus the existing title-heading-v1 contextual prefix. Corpus, query embeddings, E5 model/revision/runtime, Postgres schema, persisted generation lifecycle, vector distance and topK are identical.",
    model: LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR,
    arms: {
      bodyOnly: {
        generationId: rawBuild.generation.generationId,
        descriptor: rawBuild.generation,
        persisted: rawPersisted,
        build: {
          milliseconds: rawBuildLatencyMs,
          embeddingsCreated: rawBuild.embeddingsCreated,
          embeddingsReused: rawBuild.embeddingsReused,
        },
        metrics: rawMetrics,
      },
      titleHeading: {
        generationId: contextualBuild.generation.generationId,
        descriptor: contextualBuild.generation,
        persisted: contextualPersisted,
        build: {
          milliseconds: contextualBuildLatencyMs,
          embeddingsCreated: contextualBuild.embeddingsCreated,
          embeddingsReused: contextualBuild.embeddingsReused,
        },
        metrics: contextualMetrics,
      },
    },
    deltas: {
      recallAt1: contextualMetrics.recallAt1 - rawMetrics.recallAt1,
      recallAtK: contextualMetrics.recallAtK - rawMetrics.recallAtK,
      mrr: contextualMetrics.mrr - rawMetrics.mrr,
      contextPrecisionAtK:
        contextualMetrics.contextPrecisionAtK -
        rawMetrics.contextPrecisionAtK,
      buildLatencyMs: contextualBuildLatencyMs - rawBuildLatencyMs,
      meanQueryLatencyMs:
        contextualMetrics.meanQueryLatencyMs - rawMetrics.meanQueryLatencyMs,
    },
    claimBoundary: [
      "Both arms are fresh persisted READY embedding generations with complete input fingerprints; this is not an in-memory-only embedding comparison.",
      "The benchmark measures candidate vector retrieval only. Relevance does not grant evidence support.",
      "No production default or provider configuration is changed by this result.",
      "The registered synthetic fixture is not private-vault evidence and is not a claim of universal retrieval quality.",
    ],
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
  try {
    if (ids) await cleanup(db, ids);
  } finally {
    await provider.dispose();
    await db.pool.end();
  }
}
