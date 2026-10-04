import "dotenv/config";

import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  assertSyntheticFixtureDatabaseSafety,
  Postgres,
} from "../packages/postgres/src/index.js";
import { buildEmbeddingIndex } from "../packages/indexing/src/index.js";
import {
  LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR,
  LocalSemanticEmbeddingAdapter,
  withEmbeddingPassageContext,
} from "../packages/retrieval/src/index.js";

type Language = "en" | "es";

type XQuadAnswer = {
  text: string;
  answer_start: number;
};

type XQuadQuestion = {
  id: string;
  question: string;
  answers: XQuadAnswer[];
};

type XQuadParagraph = {
  context: string;
  qas: XQuadQuestion[];
};

type XQuadArticle = {
  title: string;
  paragraphs: XQuadParagraph[];
};

type XQuadDataset = {
  version: string;
  data: XQuadArticle[];
};

type SourceIdentity = {
  path: string;
  gitBlobSha: string;
  sha256: string;
  bytes: number;
};

type UnitSeed = {
  unitKey: string;
  articleIndex: number;
  paragraphIndex: number;
  title: string;
  body: string;
};

type QuerySeed = {
  id: string;
  question: string;
  articleIndex: number;
  paragraphIndex: number;
  goldUnitKey: string;
};

type ParsedLanguage = {
  language: Language;
  dataset: XQuadDataset;
  units: UnitSeed[];
  queries: QuerySeed[];
  queryById: Map<string, QuerySeed>;
  answerSpans: number;
};

type RankedObservation = {
  queryId: string;
  firstGoldRank: number | null;
  rankedUnitKeys: string[];
};

type RetrievalMetrics = {
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  mrrAt10: number;
  meanQueryLatencyMs: number;
  observations: RankedObservation[];
};

type PairedRankSummary = {
  improved: number;
  regressed: number;
  tied: number;
};

type SeededFixture = {
  organizationId: string;
  spaceId: string;
  vaultIds: Record<Language, string>;
  unitCounts: Record<Language, number>;
};

type GenerationEvidence = {
  status: string;
  inputStrategy: string;
  vectorRows: number;
  matchingInputHashes: number;
  complete: boolean;
};

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const outputPath = path.resolve(
  repositoryRoot,
  process.env.AKP_XQUAD_CONTEXTUAL_REPORT ??
    "reports/ci/xquad-contextual-persisted-generation.json",
);
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
assertSyntheticFixtureDatabaseSafety(databaseUrl);

const XQUAD_REPOSITORY = "google-deepmind/xquad";
const XQUAD_COMMIT = "7d30520c717524000f0d9d2f9c10a069acd9d285";
const XQUAD_LICENSE = "CC BY-SA 4.0";
const TOP_K = 10;
const EXPECTED = {
  articles: 48,
  paragraphs: 240,
  questions: 1190,
} as const;
const SOURCES = {
  en: {
    path: "xquad.en.json",
    gitBlobSha: "cc0e3e8b94910097d29d2e9df5f266e1b30b2810",
  },
  es: {
    path: "xquad.es.json",
    gitBlobSha: "7eb7791d26ca030581fe57079f6df864a012ead1",
  },
  readme: {
    path: "README.md",
    gitBlobSha: "addee0cf67354cbaeb9a7c77470c9b0c2f86b05d",
  },
  license: {
    path: "CC-BY-SA4.0.txt",
    gitBlobSha: "e07d2ce60b34d3b07ae88afd772f323e3c29d010",
  },
} as const;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function gitBlobSha(value: Buffer): string {
  const header = Buffer.from(`blob ${value.byteLength}\0`, "utf8");
  return createHash("sha1").update(header).update(value).digest("hex");
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

async function fetchPinnedFile(
  source: { path: string; gitBlobSha: string },
): Promise<{ identity: SourceIdentity; text: string }> {
  const url = `https://raw.githubusercontent.com/${XQUAD_REPOSITORY}/${XQUAD_COMMIT}/${source.path}`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "akp-xquad-contextual-benchmark" },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        throw new Error(
          `XQuAD fetch failed for ${source.path}: ${response.status} ${response.statusText}`,
        );
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const actualBlobSha = gitBlobSha(bytes);
      if (actualBlobSha !== source.gitBlobSha) {
        throw new Error(
          `XQuAD blob identity mismatch for ${source.path}: expected ${source.gitBlobSha}, received ${actualBlobSha}`,
        );
      }
      return {
        identity: {
          path: source.path,
          gitBlobSha: actualBlobSha,
          sha256: sha256(bytes),
          bytes: bytes.byteLength,
        },
        text: bytes.toString("utf8"),
      };
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Unable to fetch pinned XQuAD file ${source.path}.`);
}

function parseLanguage(language: Language, raw: string): ParsedLanguage {
  const dataset = JSON.parse(raw) as XQuadDataset;
  if (dataset.version !== "1.1" || !Array.isArray(dataset.data)) {
    throw new Error(
      `XQuAD ${language} does not match the expected SQuAD 1.1 shape.`,
    );
  }

  const units: UnitSeed[] = [];
  const queries: QuerySeed[] = [];
  const queryById = new Map<string, QuerySeed>();
  let answerSpans = 0;

  for (const [articleIndex, article] of dataset.data.entries()) {
    if (!article.title || !Array.isArray(article.paragraphs)) {
      throw new Error(`XQuAD ${language} article ${articleIndex} is malformed.`);
    }
    for (const [paragraphIndex, paragraph] of article.paragraphs.entries()) {
      if (!paragraph.context || !Array.isArray(paragraph.qas)) {
        throw new Error(
          `XQuAD ${language} paragraph ${articleIndex}/${paragraphIndex} is malformed.`,
        );
      }
      const unitKey = `${language}:${articleIndex}:${paragraphIndex}`;
      units.push({
        unitKey,
        articleIndex,
        paragraphIndex,
        title: article.title,
        body: paragraph.context,
      });

      for (const qa of paragraph.qas) {
        if (
          !qa.id ||
          !qa.question ||
          !Array.isArray(qa.answers) ||
          qa.answers.length === 0
        ) {
          throw new Error(`XQuAD ${language} contains an invalid QA record.`);
        }
        if (queryById.has(qa.id)) {
          throw new Error(`Duplicate XQuAD ${language} question id ${qa.id}.`);
        }
        for (const answer of qa.answers) {
          const observed = paragraph.context.slice(
            answer.answer_start,
            answer.answer_start + answer.text.length,
          );
          if (observed !== answer.text) {
            throw new Error(
              `XQuAD ${language} answer span mismatch for ${qa.id}.`,
            );
          }
          answerSpans += 1;
        }
        const query = {
          id: qa.id,
          question: qa.question,
          articleIndex,
          paragraphIndex,
          goldUnitKey: unitKey,
        };
        queries.push(query);
        queryById.set(qa.id, query);
      }
    }
  }

  if (
    dataset.data.length !== EXPECTED.articles ||
    units.length !== EXPECTED.paragraphs ||
    queries.length !== EXPECTED.questions ||
    answerSpans !== EXPECTED.questions
  ) {
    throw new Error(
      `XQuAD ${language} cardinality mismatch: ${dataset.data.length} articles, ${units.length} paragraphs, ${queries.length} questions, ${answerSpans} answer spans.`,
    );
  }

  return { language, dataset, units, queries, queryById, answerSpans };
}

function validateAlignment(
  en: ParsedLanguage,
  es: ParsedLanguage,
): {
  alignedQuestionIds: number;
  alignedLocations: number;
  sharedArticleTitles: number;
} {
  if (en.dataset.data.length !== es.dataset.data.length) {
    throw new Error("XQuAD EN/ES article counts are not aligned.");
  }
  let sharedArticleTitles = 0;
  for (const [index, enArticle] of en.dataset.data.entries()) {
    const esArticle = es.dataset.data[index];
    if (!esArticle) throw new Error(`Missing XQuAD ES article ${index}.`);
    if (enArticle.title === esArticle.title) sharedArticleTitles += 1;
    if (enArticle.paragraphs.length !== esArticle.paragraphs.length) {
      throw new Error(
        `XQuAD EN/ES paragraph count mismatch at article ${index}.`,
      );
    }
  }

  let alignedQuestionIds = 0;
  let alignedLocations = 0;
  for (const query of en.queries) {
    const peer = es.queryById.get(query.id);
    if (!peer) throw new Error(`XQuAD ES is missing question ${query.id}.`);
    alignedQuestionIds += 1;
    if (
      query.articleIndex === peer.articleIndex &&
      query.paragraphIndex === peer.paragraphIndex
    ) {
      alignedLocations += 1;
    }
  }
  if (
    alignedQuestionIds !== EXPECTED.questions ||
    alignedLocations !== EXPECTED.questions
  ) {
    throw new Error("XQuAD EN/ES question locations are not exactly aligned.");
  }
  return { alignedQuestionIds, alignedLocations, sharedArticleTitles };
}

async function seedFixture(
  db: Postgres,
  parsed: Record<Language, ParsedLanguage>,
  corpusRevision: string,
): Promise<SeededFixture> {
  const organizationId = randomUUID();
  const spaceId = randomUUID();
  const vaultIds: Record<Language, string> = {
    en: randomUUID(),
    es: randomUUID(),
  };

  await db.pool.query(
    `insert into organizations(id,slug,name) values($1,$2,$3)`,
    [
      organizationId,
      "xquad-" + organizationId.slice(0, 8),
      "XQuAD contextual persisted generation benchmark",
    ],
  );
  await db.pool.query(
    `insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values($1,$2,$3,$4,'PRIVATE',$5)`,
    [
      spaceId,
      organizationId,
      "xquad-" + spaceId.slice(0, 8),
      "XQuAD contextual persisted generation benchmark",
      "/tmp/akp-xquad-" + spaceId,
    ],
  );

  for (const language of ["en", "es"] as const) {
    const vaultId = vaultIds[language];
    await db.pool.query(
      `insert into vaults(
         id,space_id,canonical_path,name,read_only,current_revision,
         vault_key,local_path,visibility,enabled
       ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)`,
      [
        vaultId,
        spaceId,
        `/tmp/akp-xquad-${language}-${vaultId}`,
        `XQuAD ${language.toUpperCase()} benchmark`,
        corpusRevision,
        `xquad-${language}-${vaultId.slice(0, 8)}`,
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
    const languageData = parsed[language];
    for (const [articleIndex, article] of languageData.dataset.data.entries()) {
      const documentId = randomUUID();
      const articleUnits = languageData.units.filter(
        (unit) => unit.articleIndex === articleIndex,
      );
      const bodyCache = articleUnits.map((unit) => unit.body).join("\n\n");
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
          `benchmark/xquad/${language}/article-${articleIndex}.json`,
          `xquad:${language}:article:${articleIndex}`,
          article.title,
          corpusRevision,
          bodyCache,
          JSON.stringify({
            benchmark: "XQUAD_CONTEXTUAL_PERSISTED_GENERATION",
            source_repository: XQUAD_REPOSITORY,
            source_commit: XQUAD_COMMIT,
            language,
            article_index: articleIndex,
          }),
          sha256(bodyCache),
          Math.max(1, Math.ceil(bodyCache.length / 4)),
        ],
      );

      for (const unit of articleUnits) {
        await db.pool.query(
          `insert into knowledge_units(
             id,document_id,space_id,vault_id,unit_key,unit_type,heading_path,
             body,content_hash,corpus_revision,lifecycle,trust_tier,source_ids,
             token_estimate,document_revision,permissions,locator,structural_order,
             container_only,embedding_eligible
           ) values(
             $1,$2,$3,$4,$5,'PARAGRAPH','{}',$6,$7,$8,'ACTIVE','HUMAN_REVIEWED',
             '{}',$9,$8,'{}'::jsonb,$10::jsonb,$11,false,true
           )`,
          [
            randomUUID(),
            documentId,
            spaceId,
            vaultId,
            unit.unitKey,
            unit.body,
            sha256(unit.body),
            corpusRevision,
            Math.max(1, Math.ceil(unit.body.length / 4)),
            JSON.stringify({
              kind: "XQUAD_PARAGRAPH",
              language,
              articleIndex: unit.articleIndex,
              paragraphIndex: unit.paragraphIndex,
              sourceCommit: XQUAD_COMMIT,
            }),
            structuralOrder++,
          ],
        );
      }
    }
  }

  return {
    organizationId,
    spaceId,
    vaultIds,
    unitCounts: {
      en: parsed.en.units.length,
      es: parsed.es.units.length,
    },
  };
}

async function generationEvidence(
  db: Postgres,
  generationId: string,
): Promise<GenerationEvidence> {
  const generation = await db.pool.query<{
    status: string;
    input_strategy: string;
  }>(`select status,input_strategy from embedding_generations where id=$1`, [
    generationId,
  ]);
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
  if (!current || !counts) {
    throw new Error("Persisted XQuAD generation evidence is missing.");
  }
  return {
    status: current.status,
    inputStrategy: current.input_strategy,
    vectorRows: Number(counts.vector_rows),
    matchingInputHashes: Number(counts.matching_input_hashes),
    complete: complete.rows[0]?.complete === true,
  };
}

async function measureGeneration(
  db: Postgres,
  generationId: string,
  corpusRevision: string,
  queries: readonly QuerySeed[],
  queryVectors: readonly number[][],
  targetGoldUnitByQueryId: ReadonlyMap<string, string>,
): Promise<RetrievalMetrics> {
  const observations: RankedObservation[] = [];
  let queryLatencyMs = 0;

  for (const [index, query] of queries.entries()) {
    const queryVector = queryVectors[index];
    if (!queryVector) throw new Error(`Missing query vector for ${query.id}.`);
    const goldUnitKey = targetGoldUnitByQueryId.get(query.id);
    if (!goldUnitKey) {
      throw new Error(`Missing target gold unit for ${query.id}.`);
    }
    const started = performance.now();
    const ranked = await db.pool.query<{ unit_key: string }>(
      `select u.unit_key
         from unit_embeddings e
         join knowledge_units u on u.id=e.unit_id
        where e.generation_id=$1
          and u.corpus_revision=$3
          and u.lifecycle in ('ACTIVE','DISPUTED')
        order by e.embedding <=> $2::vector asc,u.unit_key asc
        limit $4`,
      [generationId, pgVector(queryVector), corpusRevision, TOP_K],
    );
    queryLatencyMs += performance.now() - started;
    const rankedUnitKeys = ranked.rows.map((row) => row.unit_key);
    const goldIndex = rankedUnitKeys.indexOf(goldUnitKey);
    observations.push({
      queryId: query.id,
      firstGoldRank: goldIndex < 0 ? null : goldIndex + 1,
      rankedUnitKeys,
    });
  }

  return {
    recallAt1: rate(
      observations.filter((row) => row.firstGoldRank === 1).length,
      observations.length,
    ),
    recallAt5: rate(
      observations.filter(
        (row) => row.firstGoldRank !== null && row.firstGoldRank <= 5,
      ).length,
      observations.length,
    ),
    recallAt10: rate(
      observations.filter((row) => row.firstGoldRank !== null).length,
      observations.length,
    ),
    mrrAt10: rate(
      observations.reduce(
        (sum, row) =>
          sum + (row.firstGoldRank === null ? 0 : 1 / row.firstGoldRank),
        0,
      ),
      observations.length,
    ),
    meanQueryLatencyMs: queryLatencyMs / Math.max(1, observations.length),
    observations,
  };
}

function pairedRankSummary(
  bodyOnly: RetrievalMetrics,
  titleHeading: RetrievalMetrics,
): PairedRankSummary {
  const contextualById = new Map(
    titleHeading.observations.map((row) => [row.queryId, row.firstGoldRank]),
  );
  let improved = 0;
  let regressed = 0;
  let tied = 0;
  for (const row of bodyOnly.observations) {
    const contextual = contextualById.get(row.queryId);
    if (contextual === undefined) {
      throw new Error(
        `Missing paired contextual observation for ${row.queryId}.`,
      );
    }
    const baselineRank = row.firstGoldRank ?? Number.POSITIVE_INFINITY;
    const contextualRank = contextual ?? Number.POSITIVE_INFINITY;
    if (contextualRank < baselineRank) improved += 1;
    else if (contextualRank > baselineRank) regressed += 1;
    else tied += 1;
  }
  return { improved, regressed, tied };
}

function metricDeltas(
  bodyOnly: RetrievalMetrics,
  titleHeading: RetrievalMetrics,
) {
  return {
    recallAt1: titleHeading.recallAt1 - bodyOnly.recallAt1,
    recallAt5: titleHeading.recallAt5 - bodyOnly.recallAt5,
    recallAt10: titleHeading.recallAt10 - bodyOnly.recallAt10,
    mrrAt10: titleHeading.mrrAt10 - bodyOnly.mrrAt10,
    meanQueryLatencyMs:
      titleHeading.meanQueryLatencyMs - bodyOnly.meanQueryLatencyMs,
  };
}

function primaryMetricValues(metrics: RetrievalMetrics): number[] {
  return [
    metrics.recallAt1,
    metrics.recallAt5,
    metrics.recallAt10,
    metrics.mrrAt10,
  ];
}

async function cleanup(db: Postgres, ids: SeededFixture): Promise<void> {
  await db.pool.query(`delete from vault_index_revisions where space_id=$1`, [
    ids.spaceId,
  ]);
  await db.pool.query(`delete from embedding_generations where space_id=$1`, [
    ids.spaceId,
  ]);
  await db.pool.query(`delete from knowledge_documents where space_id=$1`, [
    ids.spaceId,
  ]);
  await db.pool.query(`delete from vaults where space_id=$1`, [ids.spaceId]);
  await db.pool.query(`delete from spaces where id=$1`, [ids.spaceId]);
  await db.pool.query(`delete from organizations where id=$1`, [
    ids.organizationId,
  ]);
}

const [enSource, esSource, readmeSource, licenseSource] = await Promise.all([
  fetchPinnedFile(SOURCES.en),
  fetchPinnedFile(SOURCES.es),
  fetchPinnedFile(SOURCES.readme),
  fetchPinnedFile(SOURCES.license),
]);
if (
  !readmeSource.text.includes("240 paragraphs and 1190 question-answer pairs") ||
  !readmeSource.text.includes("entirely parallel") ||
  !readmeSource.text.includes("there are no unanswerable questions")
) {
  throw new Error(
    "Pinned XQuAD README no longer states the expected benchmark contract.",
  );
}
if (
  !licenseSource.text.includes(
    "Creative Commons Attribution-ShareAlike 4.0 International Public License",
  )
) {
  throw new Error(
    "Pinned XQuAD license is not the expected CC BY-SA 4.0 text.",
  );
}

const parsed = {
  en: parseLanguage("en", enSource.text),
  es: parseLanguage("es", esSource.text),
};
const alignment = validateAlignment(parsed.en, parsed.es);
const corpusRevision =
  "xquad-contextual-" +
  sha256(
    [
      XQUAD_COMMIT,
      enSource.identity.sha256,
      esSource.identity.sha256,
    ].join(":"),
  ).slice(0, 16);

const db = new Postgres(databaseUrl);
const provider = new LocalSemanticEmbeddingAdapter({
  ...(process.env.AKP_MODEL_CACHE_DIR?.trim()
    ? { cacheDir: process.env.AKP_MODEL_CACHE_DIR }
    : {}),
  localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
  maxBatchSize: 16,
});
const contextualProvider = withEmbeddingPassageContext(
  provider,
  "title-heading-v1",
);
let ids: SeededFixture | undefined;

try {
  ids = await seedFixture(db, parsed, corpusRevision);
  await provider.load();
  const enQueryVectors = await provider.embedQueries(
    parsed.en.queries.map((query) => query.question),
  );
  const esQueryVectors = await provider.embedQueries(
    parsed.es.queries.map((query) => query.question),
  );

  const generations = {} as Record<
    Language,
    {
      bodyOnly: {
        generationId: string;
        descriptor: unknown;
        persisted: GenerationEvidence;
        build: {
          milliseconds: number;
          embeddingsCreated: number;
          embeddingsReused: number;
        };
      };
      titleHeading: {
        generationId: string;
        descriptor: unknown;
        persisted: GenerationEvidence;
        build: {
          milliseconds: number;
          embeddingsCreated: number;
          embeddingsReused: number;
        };
      };
    }
  >;

  for (const language of ["en", "es"] as const) {
    const vaultId = ids.vaultIds[language];
    const expectedUnits = ids.unitCounts[language];

    const bodyStarted = performance.now();
    const bodyBuild = await buildEmbeddingIndex(db, {
      spaceId: ids.spaceId,
      vaultId,
      corpusRevision,
      provider,
      activate: false,
    });
    const bodyBuildLatencyMs = performance.now() - bodyStarted;

    const contextualStarted = performance.now();
    const contextualBuild = await buildEmbeddingIndex(db, {
      spaceId: ids.spaceId,
      vaultId,
      corpusRevision,
      provider: contextualProvider,
      activate: false,
    });
    const contextualBuildLatencyMs = performance.now() - contextualStarted;

    if (
      bodyBuild.generation.generationId ===
      contextualBuild.generation.generationId
    ) {
      throw new Error(`XQuAD ${language} A/B generations must be distinct.`);
    }
    if (
      bodyBuild.embeddingsCreated !== expectedUnits ||
      contextualBuild.embeddingsCreated !== expectedUnits ||
      bodyBuild.embeddingsReused !== 0 ||
      contextualBuild.embeddingsReused !== 0
    ) {
      throw new Error(
        `XQuAD ${language} generations were not freshly inferred.`,
      );
    }

    const [bodyPersisted, contextualPersisted] = await Promise.all([
      generationEvidence(db, bodyBuild.generation.generationId),
      generationEvidence(db, contextualBuild.generation.generationId),
    ]);
    for (const evidence of [bodyPersisted, contextualPersisted]) {
      if (
        evidence.status !== "READY" ||
        evidence.vectorRows !== expectedUnits ||
        evidence.matchingInputHashes !== expectedUnits ||
        evidence.complete !== true
      ) {
        throw new Error(
          `XQuAD ${language} persisted generation is incomplete or fingerprint-invalid.`,
        );
      }
    }

    generations[language] = {
      bodyOnly: {
        generationId: bodyBuild.generation.generationId,
        descriptor: bodyBuild.generation,
        persisted: bodyPersisted,
        build: {
          milliseconds: bodyBuildLatencyMs,
          embeddingsCreated: bodyBuild.embeddingsCreated,
          embeddingsReused: bodyBuild.embeddingsReused,
        },
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
      },
    };
  }

  const targetGoldMaps = {
    en: new Map(
      parsed.en.queries.map((query) => [query.id, query.goldUnitKey]),
    ),
    es: new Map(
      parsed.es.queries.map((query) => [query.id, query.goldUnitKey]),
    ),
  };
  const directionDefinitions = {
    "en-en": {
      queryLanguage: "en" as const,
      targetLanguage: "en" as const,
      queries: parsed.en.queries,
      vectors: enQueryVectors,
    },
    "es-es": {
      queryLanguage: "es" as const,
      targetLanguage: "es" as const,
      queries: parsed.es.queries,
      vectors: esQueryVectors,
    },
    "es-en": {
      queryLanguage: "es" as const,
      targetLanguage: "en" as const,
      queries: parsed.es.queries,
      vectors: esQueryVectors,
    },
    "en-es": {
      queryLanguage: "en" as const,
      targetLanguage: "es" as const,
      queries: parsed.en.queries,
      vectors: enQueryVectors,
    },
  };

  const results: Record<string, unknown> = {};
  let anyPrimaryRegression = false;
  let anyPrimaryImprovement = false;
  const epsilon = 1e-12;

  for (const [direction, definition] of Object.entries(directionDefinitions)) {
    const targetGenerations = generations[definition.targetLanguage];
    const gold = targetGoldMaps[definition.targetLanguage];
    const [bodyOnly, titleHeading] = await Promise.all([
      measureGeneration(
        db,
        targetGenerations.bodyOnly.generationId,
        corpusRevision,
        definition.queries,
        definition.vectors,
        gold,
      ),
      measureGeneration(
        db,
        targetGenerations.titleHeading.generationId,
        corpusRevision,
        definition.queries,
        definition.vectors,
        gold,
      ),
    ]);
    const bodyPrimary = primaryMetricValues(bodyOnly);
    const contextualPrimary = primaryMetricValues(titleHeading);
    for (const [index, baseline] of bodyPrimary.entries()) {
      const candidate = contextualPrimary[index];
      if (candidate === undefined) throw new Error("Missing primary metric.");
      if (candidate + epsilon < baseline) anyPrimaryRegression = true;
      if (candidate > baseline + epsilon) anyPrimaryImprovement = true;
    }
    results[direction] = {
      queryLanguage: definition.queryLanguage,
      targetLanguage: definition.targetLanguage,
      bodyOnly,
      titleHeading,
      deltas: metricDeltas(bodyOnly, titleHeading),
      pairedRanks: pairedRankSummary(bodyOnly, titleHeading),
    };
  }

  const outcome = anyPrimaryRegression
    ? "EXTERNAL_COUNTEREVIDENCE"
    : anyPrimaryImprovement
      ? "EXTERNAL_SUPPORT"
      : "INCONCLUSIVE";

  const report = {
    schemaVersion: 1,
    benchmark: "XQUAD_CONTEXTUAL_PERSISTED_GENERATION",
    generatedAt: new Date().toISOString(),
    outcome,
    productionDefaultsChanged: false,
    retrievalOnly: true,
    admissionMeasured: false,
    corpusRedistributed: false,
    corpusRevision,
    upstream: {
      repository: XQUAD_REPOSITORY,
      commit: XQUAD_COMMIT,
      license: XQUAD_LICENSE,
      sourceIdentity: {
        en: enSource.identity,
        es: esSource.identity,
        readme: readmeSource.identity,
        license: licenseSource.identity,
      },
    },
    dataset: {
      languages: ["en", "es"],
      articlesPerLanguage: EXPECTED.articles,
      paragraphsPerLanguage: EXPECTED.paragraphs,
      questionsPerLanguage: EXPECTED.questions,
      answerSpans: {
        en: parsed.en.answerSpans,
        es: parsed.es.answerSpans,
      },
      alignment,
      allQuestionIdsAligned:
        alignment.alignedQuestionIds === EXPECTED.questions,
      allQuestionLocationsAligned:
        alignment.alignedLocations === EXPECTED.questions,
      titlesSharedAcrossLanguages:
        alignment.sharedArticleTitles === EXPECTED.articles,
      unanswerableQuestionsPresent: false,
      headingMetadataInvented: false,
      contextualMetadataUsed:
        "dataset article title only; heading_path is empty",
      topK: TOP_K,
      directions: Object.keys(directionDefinitions),
    },
    model: LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR,
    singleIndependentVariable:
      "Embedding passage input only: canonical XQuAD paragraph body versus the existing title-heading-v1 prefix using the dataset-provided article title and an empty heading path. Dataset bytes, paragraph units, query embeddings, E5 model/revision/runtime, Postgres schema, persisted generation lifecycle, vector distance and topK are identical within each target language.",
    decisionRule:
      "EXTERNAL_COUNTEREVIDENCE if any EN/ES direction regresses on Recall@1, Recall@5, Recall@10 or MRR@10; EXTERNAL_SUPPORT if none regress and at least one improves; otherwise INCONCLUSIVE. Latency is reported but is not a promotion metric.",
    generations,
    results,
    claimBoundary: [
      "This benchmark measures candidate vector retrieval only. Relevance never grants evidence support.",
      "No production default, provider configuration or admission rule is changed by this result.",
      "XQuAD is a public parallel QA benchmark; it is external validation, not private-vault evidence.",
      "XQuAD v1.1 contains no unanswerable questions, so this benchmark cannot validate abstention or false-acceptance behavior.",
      "The XQuAD files expose article titles but no section-heading metadata. heading_path is intentionally empty; no synthetic headings are invented.",
      "XQuAD EN/ES article titles are shared across languages at the pinned revision, which limits how broadly title-context effects may be generalized.",
      "The report stores source identities, question IDs and retrieval ranks but does not redistribute XQuAD contexts, questions or answers.",
    ],
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  process.stdout.write(
    JSON.stringify(
      {
        outcome,
        corpusRevision,
        upstream: report.upstream,
        dataset: report.dataset,
        generations: Object.fromEntries(
          Object.entries(generations).map(([language, value]) => [
            language,
            {
              bodyOnly: {
                generationId: value.bodyOnly.generationId,
                persisted: value.bodyOnly.persisted,
                build: value.bodyOnly.build,
              },
              titleHeading: {
                generationId: value.titleHeading.generationId,
                persisted: value.titleHeading.persisted,
                build: value.titleHeading.build,
              },
            },
          ]),
        ),
        results: Object.fromEntries(
          Object.entries(results).map(([direction, value]) => {
            const typed = value as {
              bodyOnly: RetrievalMetrics;
              titleHeading: RetrievalMetrics;
              deltas: ReturnType<typeof metricDeltas>;
              pairedRanks: PairedRankSummary;
            };
            return [
              direction,
              {
                bodyOnly: {
                  recallAt1: typed.bodyOnly.recallAt1,
                  recallAt5: typed.bodyOnly.recallAt5,
                  recallAt10: typed.bodyOnly.recallAt10,
                  mrrAt10: typed.bodyOnly.mrrAt10,
                  meanQueryLatencyMs: typed.bodyOnly.meanQueryLatencyMs,
                },
                titleHeading: {
                  recallAt1: typed.titleHeading.recallAt1,
                  recallAt5: typed.titleHeading.recallAt5,
                  recallAt10: typed.titleHeading.recallAt10,
                  mrrAt10: typed.titleHeading.mrrAt10,
                  meanQueryLatencyMs: typed.titleHeading.meanQueryLatencyMs,
                },
                deltas: typed.deltas,
                pairedRanks: typed.pairedRanks,
              },
            ];
          }),
        ),
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  try {
    if (ids) await cleanup(db, ids);
  } finally {
    await provider.dispose();
    await db.pool.end();
  }
}
