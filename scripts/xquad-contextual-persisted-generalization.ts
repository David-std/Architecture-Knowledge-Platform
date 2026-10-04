import "dotenv/config";

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Postgres } from "../packages/postgres/src/index.js";
import { buildEmbeddingIndex } from "../packages/indexing/src/index.js";
import {
  LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR,
  LocalSemanticEmbeddingAdapter,
  withEmbeddingPassageContext,
} from "../packages/retrieval/src/index.js";

type Language = "en" | "es";
type StrategyName = "bodyOnly" | "titleHeading";
type SliceName = "en-en" | "es-es" | "en-es" | "es-en";

type XQuadAnswer = {
  answer_start: number;
  text: string;
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

type XQuadRoot = {
  version: string;
  data: XQuadArticle[];
};

type CorpusQuestion = {
  id: string;
  text: string;
  articleIndex: number;
  paragraphIndex: number;
  goldUnitKey: string;
};

type Corpus = {
  language: Language;
  version: string;
  articles: XQuadArticle[];
  questions: CorpusQuestion[];
  questionById: Map<string, CorpusQuestion>;
  paragraphCount: number;
  exactAnswerOffsets: number;
};

type FixtureIds = {
  organizationId: string;
  spaceId: string;
  vaultIds: Record<Language, string>;
};

type PersistedEvidence = {
  status: string;
  inputStrategy: string;
  vectorRows: number;
  matchingInputHashes: number;
  complete: boolean;
};

type BuildEvidence = {
  generationId: string;
  persisted: PersistedEvidence;
  buildLatencyMs: number;
  embeddingsCreated: number;
  embeddingsReused: number;
};

type SliceObservation = {
  queryId: string;
  bodyOnlyRank: number | null;
  titleHeadingRank: number | null;
};

type Metrics = {
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  mrrAt10: number;
  meanQueryLatencyMs: number;
};

type SliceReport = {
  queryLanguage: Language;
  corpusLanguage: Language;
  queryCount: number;
  bodyOnly: Metrics;
  titleHeading: Metrics;
  delta: {
    recallAt1: number;
    recallAt5: number;
    recallAt10: number;
    mrrAt10: number;
    meanQueryLatencyMs: number;
  };
  paired: {
    improved: number;
    regressed: number;
    tied: number;
  };
  observations: SliceObservation[];
};

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const inputDir = path.resolve(
  repositoryRoot,
  process.env.AKP_XQUAD_DIR ?? ".cache/xquad",
);
const outputPath = path.resolve(
  repositoryRoot,
  process.env.AKP_XQUAD_REPORT ??
    "reports/ci/xquad-contextual-persisted-generalization.json",
);
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const upstream = {
  repository: "google-deepmind/xquad",
  commit: "7d30520c717524000f0d9d2f9c10a069acd9d285",
  license: "CC BY-SA 4.0",
  files: {
    en: {
      name: "xquad.en.json",
      gitBlobSha: "cc0e3e8b94910097d29d2e9df5f266e1b30b2810",
    },
    es: {
      name: "xquad.es.json",
      gitBlobSha: "7eb7791d26ca030581fe57079f6df864a012ead1",
    },
    readme: {
      name: "README.md",
      gitBlobSha: "addee0cf67354cbaeb9a7c77470c9b0c2f86b05d",
    },
    license: {
      name: "CC-BY-SA4.0.txt",
      gitBlobSha: "e07d2ce60b34d3b07ae88afd772f323e3c29d010",
    },
  },
} as const;

const topK = 10;

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function gitBlobSha(buffer: Buffer): string {
  const header = Buffer.from("blob " + buffer.length + "\0", "utf8");
  return createHash("sha1").update(header).update(buffer).digest("hex");
}

function pgVector(values: readonly number[]): string {
  if (
    values.length !== LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.dimensions ||
    values.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("Invalid semantic query vector.");
  }
  return "[" + values.join(",") + "]";
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function unitKey(
  language: Language,
  articleIndex: number,
  paragraphIndex: number,
): string {
  return (
    "xquad:" +
    language +
    ":a" +
    String(articleIndex) +
    ":p" +
    String(paragraphIndex)
  );
}

async function readPinnedFile(
  name: string,
  expectedBlobSha: string,
): Promise<{ buffer: Buffer; sha256: string }> {
  const buffer = await readFile(path.join(inputDir, name));
  const actualBlob = gitBlobSha(buffer);
  if (actualBlob !== expectedBlobSha) {
    throw new Error(
      "Pinned XQuAD blob mismatch for " +
        name +
        ": expected " +
        expectedBlobSha +
        ", got " +
        actualBlob,
    );
  }
  return { buffer, sha256: sha256(buffer) };
}

function loadCorpus(language: Language, raw: Buffer): Corpus {
  const parsed = JSON.parse(raw.toString("utf8")) as XQuadRoot;
  if (
    typeof parsed.version !== "string" ||
    !Array.isArray(parsed.data) ||
    parsed.data.length === 0
  ) {
    throw new Error("Invalid XQuAD " + language + " root.");
  }

  const questions: CorpusQuestion[] = [];
  const questionById = new Map<string, CorpusQuestion>();
  let paragraphCount = 0;
  let exactAnswerOffsets = 0;

  for (const [articleIndex, article] of parsed.data.entries()) {
    if (
      typeof article.title !== "string" ||
      article.title.length === 0 ||
      !Array.isArray(article.paragraphs)
    ) {
      throw new Error(
        "Invalid XQuAD article at " + language + ":" + articleIndex,
      );
    }

    for (const [paragraphIndex, paragraph] of article.paragraphs.entries()) {
      paragraphCount += 1;
      if (
        typeof paragraph.context !== "string" ||
        paragraph.context.length === 0 ||
        !Array.isArray(paragraph.qas)
      ) {
        throw new Error(
          "Invalid XQuAD paragraph at " +
            language +
            ":" +
            articleIndex +
            ":" +
            paragraphIndex,
        );
      }

      for (const question of paragraph.qas) {
        if (
          typeof question.id !== "string" ||
          question.id.length === 0 ||
          typeof question.question !== "string" ||
          question.question.length === 0 ||
          !Array.isArray(question.answers) ||
          question.answers.length === 0
        ) {
          throw new Error(
            "Invalid XQuAD question at " +
              language +
              ":" +
              articleIndex +
              ":" +
              paragraphIndex,
          );
        }
        if (questionById.has(question.id)) {
          throw new Error("Duplicate XQuAD question id " + question.id + ".");
        }

        for (const answer of question.answers) {
          if (
            !Number.isSafeInteger(answer.answer_start) ||
            answer.answer_start < 0 ||
            typeof answer.text !== "string" ||
            paragraph.context.slice(
              answer.answer_start,
              answer.answer_start + answer.text.length,
            ) !== answer.text
          ) {
            throw new Error(
              "XQuAD answer span is not exact for " +
                language +
                ":" +
                question.id,
            );
          }
        }
        exactAnswerOffsets += 1;

        const normalized: CorpusQuestion = {
          id: question.id,
          text: question.question,
          articleIndex,
          paragraphIndex,
          goldUnitKey: unitKey(language, articleIndex, paragraphIndex),
        };
        questions.push(normalized);
        questionById.set(question.id, normalized);
      }
    }
  }

  return {
    language,
    version: parsed.version,
    articles: parsed.data,
    questions,
    questionById,
    paragraphCount,
    exactAnswerOffsets,
  };
}

function assertAligned(en: Corpus, es: Corpus): void {
  if (
    en.articles.length !== es.articles.length ||
    en.paragraphCount !== es.paragraphCount ||
    en.questions.length !== es.questions.length
  ) {
    throw new Error("XQuAD EN/ES cardinalities are not aligned.");
  }

  for (const question of en.questions) {
    const translated = es.questionById.get(question.id);
    if (!translated) {
      throw new Error("Missing Spanish XQuAD id " + question.id + ".");
    }
    if (
      translated.articleIndex !== question.articleIndex ||
      translated.paragraphIndex !== question.paragraphIndex
    ) {
      throw new Error(
        "XQuAD EN/ES paragraph alignment changed for " + question.id + ".",
      );
    }
  }
}

async function seedRoot(
  db: Postgres,
): Promise<{ organizationId: string; spaceId: string }> {
  const organizationId = randomUUID();
  const spaceId = randomUUID();
  await db.pool.query(
    "insert into organizations(id,slug,name) values($1,$2,$3)",
    [
      organizationId,
      "xquad-" + organizationId.slice(0, 8),
      "XQuAD contextual persisted generalization",
    ],
  );
  await db.pool.query(
    \`insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values($1,$2,$3,$4,'PRIVATE',$5)\`,
    [
      spaceId,
      organizationId,
      "xquad-" + spaceId.slice(0, 8),
      "XQuAD contextual persisted generalization",
      "/tmp/akp-xquad-" + spaceId,
    ],
  );
  return { organizationId, spaceId };
}

async function seedCorpus(
  db: Postgres,
  root: { organizationId: string; spaceId: string },
  corpus: Corpus,
  corpusRevision: string,
): Promise<string> {
  const vaultId = randomUUID();
  await db.pool.query(
    \`insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,
       vault_key,local_path,visibility,enabled
     ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)\`,
    [
      vaultId,
      root.spaceId,
      "/tmp/akp-xquad-" + corpus.language + "-" + vaultId,
      "XQuAD " + corpus.language.toUpperCase(),
      corpusRevision,
      "xquad-" + corpus.language + "-" + vaultId.slice(0, 8),
    ],
  );
  await db.pool.query(
    \`insert into vault_index_revisions(
       space_id,vault_id,corpus_revision,lexical_revision,graph_revision,
       context_pack_revision,status,warnings
     ) values($1,$2,$3,$3,$3,$3,'DEGRADED','[]'::jsonb)\`,
    [root.spaceId, vaultId, corpusRevision],
  );

  let structuralOrder = 0;
  for (const [articleIndex, article] of corpus.articles.entries()) {
    const documentId = randomUUID();
    const bodyCache = article.paragraphs
      .map((paragraph) => paragraph.context)
      .join("\n\n");
    await db.pool.query(
      \`insert into knowledge_documents(
         id,space_id,vault_id,path,external_id,title,type,lifecycle,
         trust_tier,current_revision,body_cache,frontmatter,aliases,layer,
         content_hash,token_estimate,raw_links
       ) values(
         $1,$2,$3,$4,$5,$6,'concept','ACTIVE','HUMAN_REVIEWED',$7,$8,
         $9::jsonb,'{}','concept',$10,$11,'[]'::jsonb
       )\`,
      [
        documentId,
        root.spaceId,
        vaultId,
        "xquad/" + corpus.language + "/article-" + articleIndex + ".md",
        "xquad-" + corpus.language + "-article-" + articleIndex,
        article.title,
        corpusRevision,
        bodyCache,
        JSON.stringify({
          benchmark: "XQuAD",
          language: corpus.language,
          articleIndex,
        }),
        sha256(Buffer.from(bodyCache, "utf8")),
        Math.max(1, Math.ceil(bodyCache.length / 4)),
      ],
    );

    for (const [paragraphIndex, paragraph] of article.paragraphs.entries()) {
      await db.pool.query(
        \`insert into knowledge_units(
           id,document_id,space_id,vault_id,unit_key,unit_type,heading_path,
           body,content_hash,corpus_revision,lifecycle,trust_tier,source_ids,
           token_estimate,document_revision,permissions,locator,structural_order,
           container_only,embedding_eligible
         ) values(
           $1,$2,$3,$4,$5,'PARAGRAPH','{}',$6,$7,$8,
           'ACTIVE','HUMAN_REVIEWED','{}',$9,$8,'{}'::jsonb,$10::jsonb,
           $11,false,true
         )\`,
        [
          randomUUID(),
          documentId,
          root.spaceId,
          vaultId,
          unitKey(corpus.language, articleIndex, paragraphIndex),
          paragraph.context,
          sha256(Buffer.from(paragraph.context, "utf8")),
          corpusRevision,
          Math.max(1, Math.ceil(paragraph.context.length / 4)),
          JSON.stringify({
            kind: "XQUAD_PARAGRAPH",
            language: corpus.language,
            articleIndex,
            paragraphIndex,
          }),
          structuralOrder++,
        ],
      );
    }
  }

  return vaultId;
}

async function generationEvidence(
  db: Postgres,
  generationId: string,
): Promise<PersistedEvidence> {
  const generation = await db.pool.query<{
    status: string;
    input_strategy: string;
  }>("select status,input_strategy from embedding_generations where id=$1", [
    generationId,
  ]);
  const rows = await db.pool.query<{
    vector_rows: number;
    matching_input_hashes: number;
  }>(
    \`select count(*)::int vector_rows,
            count(*) filter(
              where e.input_hash=akp_embedding_passage_input_hash(
                g.input_strategy,d.title,u.heading_path,u.body
              )
            )::int matching_input_hashes
       from unit_embeddings e
       join embedding_generations g on g.id=e.generation_id
       join knowledge_units u on u.id=e.unit_id
       join knowledge_documents d on d.id=u.document_id
      where e.generation_id=$1\`,
    [generationId],
  );
  const complete = await db.pool.query<{ complete: boolean }>(
    "select akp_embedding_generation_is_complete($1) complete",
    [generationId],
  );
  const current = generation.rows[0];
  const counts = rows.rows[0];
  if (!current || !counts) {
    throw new Error("Persisted generation evidence is missing.");
  }
  return {
    status: current.status,
    inputStrategy: current.input_strategy,
    vectorRows: Number(counts.vector_rows),
    matchingInputHashes: Number(counts.matching_input_hashes),
    complete: complete.rows[0]?.complete === true,
  };
}

async function buildArm(
  db: Postgres,
  options: {
    spaceId: string;
    vaultId: string;
    corpusRevision: string;
    provider:
      | LocalSemanticEmbeddingAdapter
      | ReturnType<typeof withEmbeddingPassageContext>;
    expectedUnits: number;
  },
): Promise<BuildEvidence> {
  const started = performance.now();
  const built = await buildEmbeddingIndex(db, {
    spaceId: options.spaceId,
    vaultId: options.vaultId,
    corpusRevision: options.corpusRevision,
    provider: options.provider,
    activate: false,
  });
  const buildLatencyMs = performance.now() - started;

  if (
    built.embeddingsCreated !== options.expectedUnits ||
    built.embeddingsReused !== 0
  ) {
    throw new Error("XQuAD generation was not freshly inferred.");
  }

  const persisted = await generationEvidence(
    db,
    built.generation.generationId,
  );
  if (
    persisted.status !== "READY" ||
    persisted.complete !== true ||
    persisted.vectorRows !== options.expectedUnits ||
    persisted.matchingInputHashes !== options.expectedUnits
  ) {
    throw new Error("XQuAD persisted generation is incomplete.");
  }

  return {
    generationId: built.generation.generationId,
    persisted,
    buildLatencyMs,
    embeddingsCreated: built.embeddingsCreated,
    embeddingsReused: built.embeddingsReused,
  };
}

async function firstGoldRanks(
  db: Postgres,
  generationId: string,
  corpusRevision: string,
  queryVectors: readonly number[][],
  queryIds: readonly string[],
  goldUnitKeys: readonly string[],
): Promise<{ ranks: Array<number | null>; meanQueryLatencyMs: number }> {
  if (
    queryVectors.length !== queryIds.length ||
    queryIds.length !== goldUnitKeys.length
  ) {
    throw new Error("XQuAD query vectors and gold ids are not aligned.");
  }

  const ranks: Array<number | null> = [];
  let latencyMs = 0;
  for (let index = 0; index < queryVectors.length; index += 1) {
    const vector = queryVectors[index];
    const gold = goldUnitKeys[index];
    if (!vector || !gold) {
      throw new Error("Missing XQuAD vector or gold at index " + index + ".");
    }

    const started = performance.now();
    const ranked = await db.pool.query<{ unit_key: string }>(
      \`select u.unit_key
         from unit_embeddings e
         join knowledge_units u on u.id=e.unit_id
        where e.generation_id=$1
          and u.corpus_revision=$3
          and u.lifecycle in ('ACTIVE','DISPUTED')
        order by e.embedding <=> $2::vector asc,u.unit_key asc
        limit $4\`,
      [generationId, pgVector(vector), corpusRevision, topK],
    );
    latencyMs += performance.now() - started;
    const position = ranked.rows.findIndex((row) => row.unit_key === gold);
    ranks.push(position < 0 ? null : position + 1);
  }

  return {
    ranks,
    meanQueryLatencyMs: latencyMs / Math.max(1, queryVectors.length),
  };
}

function metrics(
  ranks: readonly (number | null)[],
  meanQueryLatencyMs: number,
): Metrics {
  return {
    recallAt1: rate(ranks.filter((rank) => rank === 1).length, ranks.length),
    recallAt5: rate(
      ranks.filter((rank) => rank !== null && rank <= 5).length,
      ranks.length,
    ),
    recallAt10: rate(
      ranks.filter((rank) => rank !== null && rank <= 10).length,
      ranks.length,
    ),
    mrrAt10: rate(
      ranks.reduce(
        (sum, rank) => sum + (rank === null || rank > 10 ? 0 : 1 / rank),
        0,
      ),
      ranks.length,
    ),
    meanQueryLatencyMs,
  };
}

async function measureSlice(
  db: Postgres,
  options: {
    name: SliceName;
    queryLanguage: Language;
    corpusLanguage: Language;
    queryVectors: readonly number[][];
    queryIds: readonly string[];
    goldUnitKeys: readonly string[];
    corpusRevision: string;
    bodyGenerationId: string;
    contextualGenerationId: string;
  },
): Promise<SliceReport> {
  const [body, contextual] = await Promise.all([
    firstGoldRanks(
      db,
      options.bodyGenerationId,
      options.corpusRevision,
      options.queryVectors,
      options.queryIds,
      options.goldUnitKeys,
    ),
    firstGoldRanks(
      db,
      options.contextualGenerationId,
      options.corpusRevision,
      options.queryVectors,
      options.queryIds,
      options.goldUnitKeys,
    ),
  ]);

  let improved = 0;
  let regressed = 0;
  let tied = 0;
  const observations: SliceObservation[] = [];

  for (let index = 0; index < options.queryIds.length; index += 1) {
    const queryId = options.queryIds[index];
    if (!queryId) throw new Error("Missing XQuAD query id.");
    const bodyRank = body.ranks[index] ?? null;
    const contextualRank = contextual.ranks[index] ?? null;
    const bodyComparable = bodyRank ?? topK + 1;
    const contextualComparable = contextualRank ?? topK + 1;
    if (contextualComparable < bodyComparable) improved += 1;
    else if (contextualComparable > bodyComparable) regressed += 1;
    else tied += 1;
    observations.push({
      queryId,
      bodyOnlyRank: bodyRank,
      titleHeadingRank: contextualRank,
    });
  }

  const bodyMetrics = metrics(body.ranks, body.meanQueryLatencyMs);
  const contextualMetrics = metrics(
    contextual.ranks,
    contextual.meanQueryLatencyMs,
  );

  return {
    queryLanguage: options.queryLanguage,
    corpusLanguage: options.corpusLanguage,
    queryCount: options.queryIds.length,
    bodyOnly: bodyMetrics,
    titleHeading: contextualMetrics,
    delta: {
      recallAt1: contextualMetrics.recallAt1 - bodyMetrics.recallAt1,
      recallAt5: contextualMetrics.recallAt5 - bodyMetrics.recallAt5,
      recallAt10: contextualMetrics.recallAt10 - bodyMetrics.recallAt10,
      mrrAt10: contextualMetrics.mrrAt10 - bodyMetrics.mrrAt10,
      meanQueryLatencyMs:
        contextualMetrics.meanQueryLatencyMs - bodyMetrics.meanQueryLatencyMs,
    },
    paired: { improved, regressed, tied },
    observations,
  };
}

async function cleanup(db: Postgres, ids: FixtureIds): Promise<void> {
  for (const vaultId of Object.values(ids.vaultIds)) {
    await db.pool.query(
      "delete from vault_index_revisions where vault_id=$1",
      [vaultId],
    );
    await db.pool.query("delete from embedding_generations where vault_id=$1", [
      vaultId,
    ]);
    await db.pool.query("delete from knowledge_documents where vault_id=$1", [
      vaultId,
    ]);
    await db.pool.query("delete from vaults where id=$1", [vaultId]);
  }
  await db.pool.query("delete from spaces where id=$1", [ids.spaceId]);
  await db.pool.query("delete from organizations where id=$1", [
    ids.organizationId,
  ]);
}

const [enFile, esFile, readmeFile, licenseFile] = await Promise.all([
  readPinnedFile(upstream.files.en.name, upstream.files.en.gitBlobSha),
  readPinnedFile(upstream.files.es.name, upstream.files.es.gitBlobSha),
  readPinnedFile(
    upstream.files.readme.name,
    upstream.files.readme.gitBlobSha,
  ),
  readPinnedFile(
    upstream.files.license.name,
    upstream.files.license.gitBlobSha,
  ),
]);

const en = loadCorpus("en", enFile.buffer);
const es = loadCorpus("es", esFile.buffer);
assertAligned(en, es);

if (
  en.articles.length !== 48 ||
  es.articles.length !== 48 ||
  en.paragraphCount !== 240 ||
  es.paragraphCount !== 240 ||
  en.questions.length !== 1190 ||
  es.questions.length !== 1190 ||
  en.exactAnswerOffsets !== 1190 ||
  es.exactAnswerOffsets !== 1190
) {
  throw new Error("Pinned XQuAD cardinalities or exact offsets changed.");
}

const db = new Postgres(databaseUrl);
const provider = new LocalSemanticEmbeddingAdapter({
  ...(process.env.AKP_MODEL_CACHE_DIR?.trim()
    ? { cacheDir: process.env.AKP_MODEL_CACHE_DIR }
    : {}),
  localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
  maxBatchSize: 32,
});
const contextual = withEmbeddingPassageContext(provider, "title-heading-v1");

let ids: FixtureIds | undefined;

try {
  const root = await seedRoot(db);
  const revisions: Record<Language, string> = {
    en: "xquad-en-" + enFile.sha256.slice(0, 16),
    es: "xquad-es-" + esFile.sha256.slice(0, 16),
  };
  const vaultIds: Record<Language, string> = {
    en: await seedCorpus(db, root, en, revisions.en),
    es: await seedCorpus(db, root, es, revisions.es),
  };
  ids = {
    organizationId: root.organizationId,
    spaceId: root.spaceId,
    vaultIds,
  };

  await provider.load();

  const [enVectors, esVectors] = await Promise.all([
    provider.embedQueries(en.questions.map((question) => question.text)),
    provider.embedQueries(es.questions.map((question) => question.text)),
  ]);

  const generations: Record<
    Language,
    Record<StrategyName, BuildEvidence>
  > = {
    en: {
      bodyOnly: await buildArm(db, {
        spaceId: root.spaceId,
        vaultId: vaultIds.en,
        corpusRevision: revisions.en,
        provider,
        expectedUnits: en.paragraphCount,
      }),
      titleHeading: await buildArm(db, {
        spaceId: root.spaceId,
        vaultId: vaultIds.en,
        corpusRevision: revisions.en,
        provider: contextual,
        expectedUnits: en.paragraphCount,
      }),
    },
    es: {
      bodyOnly: await buildArm(db, {
        spaceId: root.spaceId,
        vaultId: vaultIds.es,
        corpusRevision: revisions.es,
        provider,
        expectedUnits: es.paragraphCount,
      }),
      titleHeading: await buildArm(db, {
        spaceId: root.spaceId,
        vaultId: vaultIds.es,
        corpusRevision: revisions.es,
        provider: contextual,
        expectedUnits: es.paragraphCount,
      }),
    },
  };

  const generationIds = [
    generations.en.bodyOnly.generationId,
    generations.en.titleHeading.generationId,
    generations.es.bodyOnly.generationId,
    generations.es.titleHeading.generationId,
  ];
  if (new Set(generationIds).size !== generationIds.length) {
    throw new Error("XQuAD A/B generations are not distinct.");
  }

  const enIds = en.questions.map((question) => question.id);
  const esIds = es.questions.map((question) => question.id);
  const enGold = en.questions.map((question) => question.goldUnitKey);
  const esGold = es.questions.map((question) => question.goldUnitKey);
  const enGoldById = new Map(
    en.questions.map((question) => [question.id, question.goldUnitKey]),
  );
  const esGoldById = new Map(
    es.questions.map((question) => [question.id, question.goldUnitKey]),
  );

  const enGoldForEsQueries = esIds.map((id) => {
    const gold = enGoldById.get(id);
    if (!gold) throw new Error("Missing EN gold for " + id + ".");
    return gold;
  });
  const esGoldForEnQueries = enIds.map((id) => {
    const gold = esGoldById.get(id);
    if (!gold) throw new Error("Missing ES gold for " + id + ".");
    return gold;
  });

  const slices: Record<SliceName, SliceReport> = {
    "en-en": await measureSlice(db, {
      name: "en-en",
      queryLanguage: "en",
      corpusLanguage: "en",
      queryVectors: enVectors,
      queryIds: enIds,
      goldUnitKeys: enGold,
      corpusRevision: revisions.en,
      bodyGenerationId: generations.en.bodyOnly.generationId,
      contextualGenerationId: generations.en.titleHeading.generationId,
    }),
    "es-es": await measureSlice(db, {
      name: "es-es",
      queryLanguage: "es",
      corpusLanguage: "es",
      queryVectors: esVectors,
      queryIds: esIds,
      goldUnitKeys: esGold,
      corpusRevision: revisions.es,
      bodyGenerationId: generations.es.bodyOnly.generationId,
      contextualGenerationId: generations.es.titleHeading.generationId,
    }),
    "en-es": await measureSlice(db, {
      name: "en-es",
      queryLanguage: "en",
      corpusLanguage: "es",
      queryVectors: enVectors,
      queryIds: enIds,
      goldUnitKeys: esGoldForEnQueries,
      corpusRevision: revisions.es,
      bodyGenerationId: generations.es.bodyOnly.generationId,
      contextualGenerationId: generations.es.titleHeading.generationId,
    }),
    "es-en": await measureSlice(db, {
      name: "es-en",
      queryLanguage: "es",
      corpusLanguage: "en",
      queryVectors: esVectors,
      queryIds: esIds,
      goldUnitKeys: enGoldForEsQueries,
      corpusRevision: revisions.en,
      bodyGenerationId: generations.en.bodyOnly.generationId,
      contextualGenerationId: generations.en.titleHeading.generationId,
    }),
  };

  const epsilon = 1e-12;
  const primaryDeltas = Object.values(slices).flatMap((slice) => [
    slice.delta.recallAt1,
    slice.delta.recallAt5,
    slice.delta.recallAt10,
    slice.delta.mrrAt10,
  ]);
  const hasRegression = primaryDeltas.some((delta) => delta < -epsilon);
  const hasImprovement = primaryDeltas.some((delta) => delta > epsilon);
  const outcome = hasRegression
    ? "REJECT"
    : hasImprovement
      ? "PROMOTE"
      : "INCONCLUSIVE";

  const report = {
    schemaVersion: 1,
    benchmark: "XQUAD_CONTEXTUAL_PERSISTED_GENERALIZATION",
    generatedAt: new Date().toISOString(),
    outcome,
    promotionScope:
      outcome === "PROMOTE"
        ? "external-validation-of-title-heading-v1-option-only"
        : "none",
    productionDefaultsChanged: false,
    retrievalOnly: true,
    admissionMeasured: false,
    rawCorpusMaterialPersistedInReport: false,
    upstream: {
      repository: upstream.repository,
      commit: upstream.commit,
      license: upstream.license,
      files: {
        en: {
          name: upstream.files.en.name,
          gitBlobSha: upstream.files.en.gitBlobSha,
          sha256: enFile.sha256,
        },
        es: {
          name: upstream.files.es.name,
          gitBlobSha: upstream.files.es.gitBlobSha,
          sha256: esFile.sha256,
        },
        readme: {
          name: upstream.files.readme.name,
          gitBlobSha: upstream.files.readme.gitBlobSha,
          sha256: readmeFile.sha256,
        },
        license: {
          name: upstream.files.license.name,
          gitBlobSha: upstream.files.license.gitBlobSha,
          sha256: licenseFile.sha256,
        },
      },
    },
    dataset: {
      en: {
        version: en.version,
        articles: en.articles.length,
        paragraphs: en.paragraphCount,
        questions: en.questions.length,
        exactAnswerOffsets: en.exactAnswerOffsets,
      },
      es: {
        version: es.version,
        articles: es.articles.length,
        paragraphs: es.paragraphCount,
        questions: es.questions.length,
        exactAnswerOffsets: es.exactAnswerOffsets,
      },
      alignedQuestionIdsAndParagraphs: en.questions.length,
      contextMetadata: {
        titleProvidedByDataset: true,
        headingPathProvidedByDataset: false,
        injectedHeadingPath: false,
      },
    },
    topK,
    singleIndependentVariable:
      "Persisted passage embedding input only: canonical paragraph body versus the existing title-heading-v1 prefix. Because XQuAD has article titles but no heading paths, this external slice measures title context only. Corpus bytes, query embeddings, E5 model/revision/runtime, Postgres schema, persisted-generation lifecycle, vector distance and topK are otherwise identical.",
    model: LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR,
    corpusRevisions: revisions,
    generations,
    slices,
    decisionRule: {
      reject:
        "Any regression in Recall@1, Recall@5, Recall@10 or MRR@10 in any of the four full-dataset EN/ES directions.",
      promote:
        "No primary-metric regression in any direction and at least one primary-metric improvement.",
      inconclusive: "All primary metrics tie in all directions.",
    },
    claimBoundary: [
      "XQuAD v1.1 contains answerable extractive questions only; this benchmark does not measure abstention or no-answer behavior.",
      "The benchmark measures candidate vector retrieval only. Relevance never grants evidence support.",
      "The full pinned EN/ES XQuAD files are evaluated; there is no query-specific sample selection.",
      "XQuAD supplies article titles but no heading paths. No synthetic heading metadata is injected.",
      "No production retrieval, provider or admission default changes as a consequence of this run.",
      "The report stores ids, ranks, hashes, generation evidence and aggregate metrics, but not XQuAD questions, contexts or answers.",
    ],
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  process.stdout.write(
    JSON.stringify(
      {
        outcome: report.outcome,
        upstream: report.upstream,
        dataset: report.dataset,
        generations: report.generations,
        slices: Object.fromEntries(
          Object.entries(report.slices).map(([name, slice]) => [
            name,
            {
              queryCount: slice.queryCount,
              bodyOnly: slice.bodyOnly,
              titleHeading: slice.titleHeading,
              delta: slice.delta,
              paired: slice.paired,
            },
          ]),
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
