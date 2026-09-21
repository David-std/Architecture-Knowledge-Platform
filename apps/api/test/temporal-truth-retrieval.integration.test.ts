import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SearchRequest } from "@akp/contracts";
import { Postgres, PostgresTemporalTruthStore } from "@akp/postgres";
import {
  EmbeddingGenerationManager,
  type RequestEmbeddingGeneration,
} from "@akp/indexing";
import {
  planQuery,
  QueryEmbeddingService,
  type EmbeddingInputRole,
  type EmbeddingProvider,
  type EmbeddingRequestOptions,
} from "@akp/retrieval";
import {
  queryKnowledge,
  type RetrievalTruthState,
} from "../src/routes/search.js";

const databaseUrl = process.env.DATABASE_URL;
let db: Postgres;

const descriptor: RequestEmbeddingGeneration["descriptor"] = {
  provider: "temporal-retrieval-test",
  model: "temporal-vector",
  modelRevision: "r1",
  dimensions: 3,
  normalization: "l2",
  inputStrategy: "semantic-query-passage-v1",
  configurationVersion: "temporal-v1",
  runtime: "test",
};

interface Fixture {
  spaceId: string;
  vaultId: string;
  documentId: string;
  unitId: string;
  generationId: string;
  corpusRevision: string;
  supportSetId: string;
  sourceEpisodeId: string;
  preWithdrawalRevisionHash: string;
  store: PostgresTemporalTruthStore;
}

function searchInput(spaceId: string, vaultId: string): SearchRequest {
  return {
    query: "current security rule",
    spaceId,
    vaultId,
    vaultIds: [],
    federated: false,
    types: [],
    minimumTrust: "MACHINE_SUPPORTED",
    mode: "SOURCE_BACKED",
    limit: 10,
  };
}

async function seedFixture(label: string): Promise<Fixture> {
  const organizationId = randomUUID();
  const spaceId = randomUUID();
  const vaultId = randomUUID();
  const documentId = randomUUID();
  const unitId = randomUUID();
  const sourceId = randomUUID();
  const artifactId = randomUUID();
  const corpusRevision = `truth-vector-${randomUUID()}`;
  const sourceHash = "a".repeat(64);
  const unitHash = "b".repeat(64);

  await db.pool.query(
    "insert into organizations(id,slug,name) values($1,$2,$3)",
    [organizationId, `truth-vector-${organizationId.slice(0, 8)}`, label],
  );
  await db.pool.query(
    `insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values($1,$2,$3,$4,'PRIVATE',$5)`,
    [
      spaceId,
      organizationId,
      `truth-vector-${spaceId.slice(0, 8)}`,
      label,
      `/tmp/truth-vector-${spaceId}`,
    ],
  );
  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,vault_key,
       local_path,visibility,enabled
     ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)`,
    [
      vaultId,
      spaceId,
      `/tmp/truth-vector-${vaultId}`,
      label,
      corpusRevision,
      `truth-vector-${vaultId.slice(0, 8)}`,
    ],
  );
  await db.pool.query(
    `insert into sources(
       id,space_id,vault_id,title,source_uri,media_type,sha256,byte_size,
       object_key,status,metadata
     ) values($1,$2,$3,$4,$5,'text/plain',$6,4,$7,'ACTIVE','{}'::jsonb)`,
    [
      sourceId,
      spaceId,
      vaultId,
      `${label} source`,
      `https://example.test/${sourceId}`,
      sourceHash,
      `truth-vector/${sourceId}.txt`,
    ],
  );
  await db.pool.query(
    `insert into source_artifacts(
       id,source_id,kind,object_key,source_hash,extractor,extractor_version,
       quality,metadata
     ) values($1,$2,'normalized',$3,$4,'fixture','1','HIGH','{}'::jsonb)`,
    [artifactId, sourceId, `truth-vector/${artifactId}.json`, sourceHash],
  );
  const body = `${label}: administrators must use the current security rule.`;
  await db.pool.query(
    `insert into knowledge_documents(
       id,space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,
       current_revision,body_cache,frontmatter,aliases,layer,content_hash,
       token_estimate,raw_links
     ) values($1,$2,$3,$4,$5,$6,'rule','ACTIVE','HUMAN_REVIEWED',
       $7,$8,'{}'::jsonb,'{}','concept',$9,20,'[]'::jsonb)`,
    [
      documentId,
      spaceId,
      vaultId,
      `security/${documentId}.md`,
      `TRUTH-${documentId.slice(0, 8)}`,
      label,
      corpusRevision,
      body,
      "c".repeat(64),
    ],
  );
  await db.pool.query(
    `insert into knowledge_units(
       id,document_id,space_id,vault_id,unit_key,unit_type,heading_path,body,
       content_hash,corpus_revision,lifecycle,trust_tier,source_ids,
       token_estimate,parent_unit_id,document_revision,permissions,locator,
       structural_order,container_only,embedding_eligible
     ) values($1,$2,$3,$4,$5,'PARAGRAPH','{}',$6,$7,$8,'ACTIVE',
       'HUMAN_REVIEWED','{}',20,null,$8,'{}'::jsonb,'{}'::jsonb,1,false,true)`,
    [
      unitId,
      documentId,
      spaceId,
      vaultId,
      `paragraph-${unitId.slice(0, 8)}`,
      body,
      unitHash,
      corpusRevision,
    ],
  );
  await db.pool.query(
    `insert into vault_index_revisions(
       space_id,vault_id,corpus_revision,lexical_revision,vector_revision,
       graph_revision,context_pack_revision,status,warnings
     ) values($1,$2,$3,$3,$3,$3,$3,'CONSISTENT','[]'::jsonb)`,
    [spaceId, vaultId, corpusRevision],
  );

  const manager = new EmbeddingGenerationManager(db);
  const requested = await manager.request({
    spaceId,
    vaultId,
    corpusRevision,
    descriptor,
  });
  await manager.build(requested.generationId);
  await manager.writeEmbedding({
    generationId: requested.generationId,
    unitId,
    contentHash: unitHash,
    embedding: [1, 0, 0],
  });
  await manager.ready(requested.generationId, 1);
  const active = await manager.activate(requested.generationId);

  const store = new PostgresTemporalTruthStore(db);
  const episode = await store.createSourceEpisode({
    spaceId,
    vaultId,
    sourceId,
    sourceArtifactId: artifactId,
    sourceHash,
    locatorRefs: [`source:${sourceId}#rule`],
  });
  const support = await store.createSupportSet({
    spaceId,
    vaultId,
    sourceEpisodeIds: [episode.id],
    sourceRevisionHashes: [sourceHash],
  });
  const fact = await store.recordFact({
    spaceId,
    vaultId,
    scopeId: `security:${documentId}`,
    authorizationPath: `security/${documentId}.md`,
    subjectRef: `policy:${documentId}`,
    predicate: "current_security_rule",
    object: { enabled: true },
    validFrom: "2025-01-01T00:00:00.000Z",
    supportSetId: support.id,
    sourceEpisodeId: episode.id,
  });
  await store.registerDerivedDependency({
    spaceId,
    vaultId,
    derivedStoreKind: "VECTOR",
    derivedItemRef: `vector:${active.generationId}:${unitId}`,
    supportSetId: support.id,
    sourceRevisionHashes: [sourceHash],
    truthRevisionHash: fact.revision.revisionHash,
    projectionRevision: corpusRevision,
  });

  return {
    spaceId,
    vaultId,
    documentId,
    unitId,
    generationId: active.generationId,
    corpusRevision,
    supportSetId: support.id,
    sourceEpisodeId: episode.id,
    preWithdrawalRevisionHash: fact.revision.revisionHash,
    store,
  };
}

interface ContradictoryVectorFixture {
  spaceId: string;
  vaultId: string;
  generationId: string;
  oldDocumentId: string;
  newDocumentId: string;
  oldUnitId: string;
  newUnitId: string;
  oldRevisionHash: string;
  newRevisionHash: string;
  store: PostgresTemporalTruthStore;
}

async function seedContradictoryVectorFixture(
  label: string,
): Promise<ContradictoryVectorFixture> {
  const organizationId = randomUUID();
  const spaceId = randomUUID();
  const vaultId = randomUUID();
  const sourceId = randomUUID();
  const artifactId = randomUUID();
  const oldDocumentId = randomUUID();
  const newDocumentId = randomUUID();
  const oldUnitId = randomUUID();
  const newUnitId = randomUUID();
  const corpusRevision = `truth-contradiction-${randomUUID()}`;
  const sourceHash = "d".repeat(64);

  await db.pool.query(
    "insert into organizations(id,slug,name) values($1,$2,$3)",
    [
      organizationId,
      `truth-contradiction-${organizationId.slice(0, 8)}`,
      label,
    ],
  );
  await db.pool.query(
    `insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values($1,$2,$3,$4,'PRIVATE',$5)`,
    [
      spaceId,
      organizationId,
      `truth-contradiction-${spaceId.slice(0, 8)}`,
      label,
      `/tmp/truth-contradiction-${spaceId}`,
    ],
  );
  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,vault_key,
       local_path,visibility,enabled
     ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)`,
    [
      vaultId,
      spaceId,
      `/tmp/truth-contradiction-${vaultId}`,
      label,
      corpusRevision,
      `truth-contradiction-${vaultId.slice(0, 8)}`,
    ],
  );
  await db.pool.query(
    `insert into sources(
       id,space_id,vault_id,title,source_uri,media_type,sha256,byte_size,
       object_key,status,metadata
     ) values($1,$2,$3,$4,$5,'text/plain',$6,4,$7,'ACTIVE','{}'::jsonb)`,
    [
      sourceId,
      spaceId,
      vaultId,
      `${label} source`,
      `https://example.test/${sourceId}`,
      sourceHash,
      `truth-contradiction/${sourceId}.txt`,
    ],
  );
  await db.pool.query(
    `insert into source_artifacts(
       id,source_id,kind,object_key,source_hash,extractor,extractor_version,
       quality,metadata
     ) values($1,$2,'normalized',$3,$4,'fixture','1','HIGH','{}'::jsonb)`,
    [
      artifactId,
      sourceId,
      `truth-contradiction/${artifactId}.json`,
      sourceHash,
    ],
  );

  const documents = [
    {
      documentId: oldDocumentId,
      unitId: oldUnitId,
      title: "OLD transport security guidance",
      body: "TLS 1.2 is the required minimum transport security version.",
      unitHash: "e".repeat(64),
      embedding: [1, 0, 0],
    },
    {
      documentId: newDocumentId,
      unitId: newUnitId,
      title: "NEW transport security guidance",
      body: "TLS 1.3 is the required minimum transport security version.",
      unitHash: "f".repeat(64),
      embedding: [0.995, 0.1, 0],
    },
  ] as const;

  for (const document of documents) {
    await db.pool.query(
      `insert into knowledge_documents(
         id,space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,
         current_revision,body_cache,frontmatter,aliases,layer,content_hash,
         token_estimate,raw_links
       ) values($1,$2,$3,$4,$5,$6,'rule','ACTIVE','HUMAN_REVIEWED',
         $7,$8,'{}'::jsonb,'{}','concept',$9,20,'[]'::jsonb)`,
      [
        document.documentId,
        spaceId,
        vaultId,
        `security/${document.documentId}.md`,
        `TRUTH-${document.documentId.slice(0, 8)}`,
        document.title,
        corpusRevision,
        document.body,
        document.unitHash,
      ],
    );
    await db.pool.query(
      `insert into knowledge_units(
         id,document_id,space_id,vault_id,unit_key,unit_type,heading_path,body,
         content_hash,corpus_revision,lifecycle,trust_tier,source_ids,
         token_estimate,parent_unit_id,document_revision,permissions,locator,
         structural_order,container_only,embedding_eligible
       ) values($1,$2,$3,$4,$5,'PARAGRAPH','{}',$6,$7,$8,'ACTIVE',
         'HUMAN_REVIEWED','{}',20,null,$8,'{}'::jsonb,'{}'::jsonb,1,false,true)`,
      [
        document.unitId,
        document.documentId,
        spaceId,
        vaultId,
        `paragraph-${document.unitId.slice(0, 8)}`,
        document.body,
        document.unitHash,
        corpusRevision,
      ],
    );
  }

  await db.pool.query(
    `insert into vault_index_revisions(
       space_id,vault_id,corpus_revision,lexical_revision,vector_revision,
       graph_revision,context_pack_revision,status,warnings
     ) values($1,$2,$3,$3,$3,$3,$3,'CONSISTENT','[]'::jsonb)`,
    [spaceId, vaultId, corpusRevision],
  );

  const manager = new EmbeddingGenerationManager(db);
  const requested = await manager.request({
    spaceId,
    vaultId,
    corpusRevision,
    descriptor,
  });
  await manager.build(requested.generationId);
  for (const document of documents) {
    await manager.writeEmbedding({
      generationId: requested.generationId,
      unitId: document.unitId,
      contentHash: document.unitHash,
      embedding: [...document.embedding],
    });
  }
  await manager.ready(requested.generationId, documents.length);
  const active = await manager.activate(requested.generationId);

  const store = new PostgresTemporalTruthStore(db);
  const episode = await store.createSourceEpisode({
    spaceId,
    vaultId,
    sourceId,
    sourceArtifactId: artifactId,
    sourceHash,
    locatorRefs: [`source:${sourceId}#transport-security`],
  });
  const factSupport = await store.createSupportSet({
    spaceId,
    vaultId,
    sourceEpisodeIds: [episode.id],
    sourceRevisionHashes: [sourceHash],
  });
  const oldFact = await store.recordFact({
    spaceId,
    vaultId,
    scopeId: "security:transport",
    authorizationPath: `security/${oldDocumentId}.md`,
    subjectRef: "policy:transport",
    predicate: "tls_minimum",
    object: { version: "1.2" },
    validFrom: "2025-01-01T00:00:00.000Z",
    supportSetId: factSupport.id,
    sourceEpisodeId: episode.id,
  });
  const oldVectorSupport = await store.createSupportSet({
    spaceId,
    vaultId,
    factIds: [oldFact.fact.id],
  });
  await store.registerDerivedDependency({
    spaceId,
    vaultId,
    derivedStoreKind: "VECTOR",
    derivedItemRef: `vector:${active.generationId}:${oldUnitId}`,
    supportSetId: oldVectorSupport.id,
    truthRevisionHash: oldFact.revision.revisionHash,
    projectionRevision: corpusRevision,
  });

  const newFact = await store.recordFact({
    spaceId,
    vaultId,
    scopeId: "security:transport",
    authorizationPath: `security/${newDocumentId}.md`,
    subjectRef: "policy:transport",
    predicate: "tls_minimum",
    object: { version: "1.3" },
    validFrom: "2026-01-01T00:00:00.000Z",
    supportSetId: factSupport.id,
    sourceEpisodeId: episode.id,
    supersedesFactId: oldFact.fact.id,
  });
  const newVectorSupport = await store.createSupportSet({
    spaceId,
    vaultId,
    factIds: [newFact.fact.id],
  });
  await store.registerDerivedDependency({
    spaceId,
    vaultId,
    derivedStoreKind: "VECTOR",
    derivedItemRef: `vector:${active.generationId}:${newUnitId}`,
    supportSetId: newVectorSupport.id,
    truthRevisionHash: newFact.revision.revisionHash,
    projectionRevision: corpusRevision,
  });

  return {
    spaceId,
    vaultId,
    generationId: active.generationId,
    oldDocumentId,
    newDocumentId,
    oldUnitId,
    newUnitId,
    oldRevisionHash: oldFact.revision.revisionHash,
    newRevisionHash: newFact.revision.revisionHash,
    store,
  };
}

interface AlternativeSupportVectorFixture {
  spaceId: string;
  vaultId: string;
  generationId: string;
  explanationDocumentId: string;
  conclusionDocumentId: string;
  explanationUnitId: string;
  conclusionUnitId: string;
  sourceEpisodeAId: string;
  preWithdrawalRevisionHash: string;
  store: PostgresTemporalTruthStore;
}

async function seedAlternativeSupportVectorFixture(
  label: string,
): Promise<AlternativeSupportVectorFixture> {
  const organizationId = randomUUID();
  const spaceId = randomUUID();
  const vaultId = randomUUID();
  const sourceA = randomUUID();
  const sourceB = randomUUID();
  const artifactA = randomUUID();
  const artifactB = randomUUID();
  const explanationDocumentId = randomUUID();
  const conclusionDocumentId = randomUUID();
  const explanationUnitId = randomUUID();
  const conclusionUnitId = randomUUID();
  const corpusRevision = `truth-alternative-${randomUUID()}`;
  const sourceHashA = "1".repeat(64);
  const sourceHashB = "2".repeat(64);

  await db.pool.query(
    "insert into organizations(id,slug,name) values($1,$2,$3)",
    [organizationId, `truth-alternative-${organizationId.slice(0, 8)}`, label],
  );
  await db.pool.query(
    `insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values($1,$2,$3,$4,'PRIVATE',$5)`,
    [
      spaceId,
      organizationId,
      `truth-alternative-${spaceId.slice(0, 8)}`,
      label,
      `/tmp/truth-alternative-${spaceId}`,
    ],
  );
  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,vault_key,
       local_path,visibility,enabled
     ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)`,
    [
      vaultId,
      spaceId,
      `/tmp/truth-alternative-${vaultId}`,
      label,
      corpusRevision,
      `truth-alternative-${vaultId.slice(0, 8)}`,
    ],
  );

  for (const source of [
    {
      sourceId: sourceA,
      artifactId: artifactA,
      hash: sourceHashA,
      suffix: "a",
    },
    {
      sourceId: sourceB,
      artifactId: artifactB,
      hash: sourceHashB,
      suffix: "b",
    },
  ]) {
    await db.pool.query(
      `insert into sources(
         id,space_id,vault_id,title,source_uri,media_type,sha256,byte_size,
         object_key,status,metadata
       ) values($1,$2,$3,$4,$5,'text/plain',$6,4,$7,'ACTIVE','{}'::jsonb)`,
      [
        source.sourceId,
        spaceId,
        vaultId,
        `${label} source ${source.suffix}`,
        `https://example.test/${source.sourceId}`,
        source.hash,
        `truth-alternative/${source.artifactId}.txt`,
      ],
    );
    await db.pool.query(
      `insert into source_artifacts(
         id,source_id,kind,object_key,source_hash,extractor,extractor_version,
         quality,metadata
       ) values($1,$2,'normalized',$3,$4,'fixture','1','HIGH','{}'::jsonb)`,
      [
        source.artifactId,
        source.sourceId,
        `truth-alternative/${source.artifactId}.json`,
        source.hash,
      ],
    );
  }

  const documents = [
    {
      documentId: explanationDocumentId,
      unitId: explanationUnitId,
      title: "Source A security explanation",
      body: "Source A alone explains the security conclusion.",
      unitHash: "3".repeat(64),
      embedding: [1, 0, 0],
    },
    {
      documentId: conclusionDocumentId,
      unitId: conclusionUnitId,
      title: "Independently supported security conclusion",
      body: "The security conclusion remains supported independently by source B.",
      unitHash: "4".repeat(64),
      embedding: [0.995, 0.1, 0],
    },
  ] as const;

  for (const document of documents) {
    await db.pool.query(
      `insert into knowledge_documents(
         id,space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,
         current_revision,body_cache,frontmatter,aliases,layer,content_hash,
         token_estimate,raw_links
       ) values($1,$2,$3,$4,$5,$6,'rule','ACTIVE','HUMAN_REVIEWED',
         $7,$8,'{}'::jsonb,'{}','concept',$9,20,'[]'::jsonb)`,
      [
        document.documentId,
        spaceId,
        vaultId,
        `security/${document.documentId}.md`,
        `TRUTH-${document.documentId.slice(0, 8)}`,
        document.title,
        corpusRevision,
        document.body,
        document.unitHash,
      ],
    );
    await db.pool.query(
      `insert into knowledge_units(
         id,document_id,space_id,vault_id,unit_key,unit_type,heading_path,body,
         content_hash,corpus_revision,lifecycle,trust_tier,source_ids,
         token_estimate,parent_unit_id,document_revision,permissions,locator,
         structural_order,container_only,embedding_eligible
       ) values($1,$2,$3,$4,$5,'PARAGRAPH','{}',$6,$7,$8,'ACTIVE',
         'HUMAN_REVIEWED','{}',20,null,$8,'{}'::jsonb,'{}'::jsonb,1,false,true)`,
      [
        document.unitId,
        document.documentId,
        spaceId,
        vaultId,
        `paragraph-${document.unitId.slice(0, 8)}`,
        document.body,
        document.unitHash,
        corpusRevision,
      ],
    );
  }

  await db.pool.query(
    `insert into vault_index_revisions(
       space_id,vault_id,corpus_revision,lexical_revision,vector_revision,
       graph_revision,context_pack_revision,status,warnings
     ) values($1,$2,$3,$3,$3,$3,$3,'CONSISTENT','[]'::jsonb)`,
    [spaceId, vaultId, corpusRevision],
  );

  const manager = new EmbeddingGenerationManager(db);
  const requested = await manager.request({
    spaceId,
    vaultId,
    corpusRevision,
    descriptor,
  });
  await manager.build(requested.generationId);
  for (const document of documents) {
    await manager.writeEmbedding({
      generationId: requested.generationId,
      unitId: document.unitId,
      contentHash: document.unitHash,
      embedding: [...document.embedding],
    });
  }
  await manager.ready(requested.generationId, documents.length);
  const active = await manager.activate(requested.generationId);

  const store = new PostgresTemporalTruthStore(db);
  const episodeA = await store.createSourceEpisode({
    spaceId,
    vaultId,
    sourceId: sourceA,
    sourceArtifactId: artifactA,
    sourceHash: sourceHashA,
    locatorRefs: ["source:a#security"],
  });
  const episodeB = await store.createSourceEpisode({
    spaceId,
    vaultId,
    sourceId: sourceB,
    sourceArtifactId: artifactB,
    sourceHash: sourceHashB,
    locatorRefs: ["source:b#security"],
  });

  const aOnlySupport = await store.createSupportSet({
    spaceId,
    vaultId,
    sourceEpisodeIds: [episodeA.id],
  });
  const explanationFact = await store.recordFact({
    spaceId,
    vaultId,
    scopeId: "security:a-only-explanation",
    authorizationPath: `security/${explanationDocumentId}.md`,
    subjectRef: "policy:a-only-explanation",
    predicate: "supported",
    object: { value: true },
    validFrom: "2025-01-01T00:00:00.000Z",
    supportSetId: aOnlySupport.id,
    sourceEpisodeId: episodeA.id,
  });
  const explanationVectorSupport = await store.createSupportSet({
    spaceId,
    vaultId,
    factIds: [explanationFact.fact.id],
  });
  await store.registerDerivedDependency({
    spaceId,
    vaultId,
    derivedStoreKind: "VECTOR",
    derivedItemRef: `vector:${active.generationId}:${explanationUnitId}`,
    supportSetId: explanationVectorSupport.id,
    truthRevisionHash: explanationFact.revision.revisionHash,
    projectionRevision: corpusRevision,
  });

  const conclusionSupport = await store.createSupportSet({
    spaceId,
    vaultId,
    sourceEpisodeIds: [episodeA.id, episodeB.id],
    alternativeSupportGroups: [
      [`source_episode:${episodeA.id}`],
      [`source_episode:${episodeB.id}`],
    ],
  });
  const conclusionFact = await store.recordFact({
    spaceId,
    vaultId,
    scopeId: "security:independent-conclusion",
    authorizationPath: `security/${conclusionDocumentId}.md`,
    subjectRef: "policy:independent-conclusion",
    predicate: "supported",
    object: { value: true },
    validFrom: "2025-01-01T00:00:00.000Z",
    supportSetId: conclusionSupport.id,
    sourceEpisodeId: episodeA.id,
  });
  const conclusionVectorSupport = await store.createSupportSet({
    spaceId,
    vaultId,
    factIds: [conclusionFact.fact.id],
  });
  await store.registerDerivedDependency({
    spaceId,
    vaultId,
    derivedStoreKind: "VECTOR",
    derivedItemRef: `vector:${active.generationId}:${conclusionUnitId}`,
    supportSetId: conclusionVectorSupport.id,
    truthRevisionHash: conclusionFact.revision.revisionHash,
    projectionRevision: corpusRevision,
  });

  return {
    spaceId,
    vaultId,
    generationId: active.generationId,
    explanationDocumentId,
    conclusionDocumentId,
    explanationUnitId,
    conclusionUnitId,
    sourceEpisodeAId: episodeA.id,
    preWithdrawalRevisionHash: conclusionFact.revision.revisionHash,
    store,
  };
}

function queryService(
  beforeEmbedding?: () => Promise<void>,
): QueryEmbeddingService {
  let invoked = false;
  const provider: EmbeddingProvider = {
    descriptor,
    embed: async (
      texts: readonly string[],
      request?: EmbeddingInputRole | EmbeddingRequestOptions,
    ) => {
      const role = typeof request === "string" ? request : request?.role;
      expect(role).toBe("query");
      expect(texts).toHaveLength(1);
      if (!invoked && beforeEmbedding) {
        invoked = true;
        await beforeEmbedding();
      }
      return [[1, 0, 0]];
    },
  };
  return new QueryEmbeddingService(async () => provider);
}

beforeAll(() => {
  if (!databaseUrl) return;
  db = new Postgres(databaseUrl);
});

afterAll(async () => {
  if (db) await db.close();
});

describe.skipIf(!databaseUrl)("truth-valid vector retrieval", () => {
  it("rejects a stale vector before ranking after support withdrawal", async () => {
    const fixture = await seedFixture("Strict truth vector");
    let withdrawalRevision = "";
    await expect(
      queryKnowledge(db, searchInput(fixture.spaceId, fixture.vaultId), {
        vaultIds: [fixture.vaultId],
        channels: ["vector"],
        allowVectorForBenchmark: true,
        queryEmbeddingService: queryService(async () => {
          const withdrawn = await fixture.store.withdrawSourceEpisode({
            spaceId: fixture.spaceId,
            vaultId: fixture.vaultId,
            sourceEpisodeId: fixture.sourceEpisodeId,
            reason: "Support withdrawn during retrieval",
          });
          withdrawalRevision = withdrawn.revisionHash;
        }),
        truthConsistency: "STRICT",
      }),
    ).rejects.toThrow("CONTEXT_REVISION_CHANGED");
    expect(withdrawalRevision).not.toBe("");

    const physical = await db.pool.query<{ count: string }>(
      `select count(*)::text count
         from unit_embeddings
        where generation_id=$1 and unit_id=$2`,
      [fixture.generationId, fixture.unitId],
    );
    expect(physical.rows[0]?.count).toBe("1");

    const warnings: string[] = [];
    const currentHits = await queryKnowledge(
      db,
      searchInput(fixture.spaceId, fixture.vaultId),
      {
        vaultIds: [fixture.vaultId],
        channels: ["vector"],
        allowVectorForBenchmark: true,
        queryEmbeddingService: queryService(),
        truthConsistency: "STRICT",
        warningSink: warnings,
      },
    );
    expect(currentHits).toEqual([]);
    expect(warnings).toContain(
      `TRUTH_SUPPORT_REJECTED:VECTOR:${fixture.unitId}`,
    );
    expect(
      await fixture.store.validateDerivedItems({
        spaceId: fixture.spaceId,
        vaultId: fixture.vaultId,
        derivedStoreKind: "VECTOR",
        derivedItemRefs: [`vector:${fixture.generationId}:${fixture.unitId}`],
        truthRevisionHash: fixture.preWithdrawalRevisionHash,
      }),
    ).toMatchObject([{ state: "SUPPORTED", valid: true }]);
  });

  it("keeps alternative support while rejecting the higher-scoring A-only explanation before RRF", async () => {
    const fixture = await seedAlternativeSupportVectorFixture(
      "Alternative support vector truth",
    );
    const physicalScores = await db.pool.query<{
      unit_id: string;
      score: number;
    }>(
      `select unit_id,
              1 - (embedding::vector(3) <=> '[1,0,0]'::vector(3)) score
         from unit_embeddings
        where generation_id=$1 and unit_id=any($2::uuid[])
        order by score desc,unit_id`,
      [
        fixture.generationId,
        [fixture.explanationUnitId, fixture.conclusionUnitId],
      ],
    );
    const scoreByUnit = new Map(
      physicalScores.rows.map((row) => [row.unit_id, Number(row.score)]),
    );
    expect(scoreByUnit.get(fixture.explanationUnitId)).toBeGreaterThan(
      scoreByUnit.get(fixture.conclusionUnitId) ?? Number.POSITIVE_INFINITY,
    );

    const withdrawn = await fixture.store.withdrawSourceEpisode({
      spaceId: fixture.spaceId,
      vaultId: fixture.vaultId,
      sourceEpisodeId: fixture.sourceEpisodeAId,
      reason: "Source A withdrawn while source B remains independent support",
    });

    const warnings: string[] = [];
    const hits = await queryKnowledge(
      db,
      {
        ...searchInput(fixture.spaceId, fixture.vaultId),
        query: "independently supported security conclusion",
      },
      {
        vaultIds: [fixture.vaultId],
        channels: ["vector"],
        allowVectorForBenchmark: true,
        queryEmbeddingService: queryService(),
        truthConsistency: "STRICT",
        warningSink: warnings,
      },
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      documentId: fixture.conclusionDocumentId,
      unitId: fixture.conclusionUnitId,
      fusionContributions: [
        expect.objectContaining({
          channel: "vector",
          rank: 1,
          rawScore: expect.any(Number),
        }),
      ],
    });
    const selectedScore = hits[0]?.fusionContributions?.find(
      (entry) => entry.channel === "vector",
    )?.rawScore;
    expect(selectedScore).toBeCloseTo(
      scoreByUnit.get(fixture.conclusionUnitId) ?? 0,
      8,
    );
    expect(selectedScore).toBeLessThan(
      scoreByUnit.get(fixture.explanationUnitId) ?? 0,
    );
    expect(warnings).toContain(
      `TRUTH_SUPPORT_REJECTED:VECTOR:${fixture.explanationUnitId}`,
    );
    expect(warnings).not.toContain(
      `TRUTH_SUPPORT_REJECTED:VECTOR:${fixture.conclusionUnitId}`,
    );

    const currentValidation = await fixture.store.validateDerivedItems({
      spaceId: fixture.spaceId,
      vaultId: fixture.vaultId,
      derivedStoreKind: "VECTOR",
      derivedItemRefs: [
        `vector:${fixture.generationId}:${fixture.explanationUnitId}`,
        `vector:${fixture.generationId}:${fixture.conclusionUnitId}`,
      ],
      truthRevisionHash: withdrawn.revisionHash,
      validAt: "2026-09-01T00:00:00.000Z",
    });
    expect(currentValidation).toMatchObject([
      { state: "UNSUPPORTED", valid: false },
      { state: "SUPPORTED", valid: true },
    ]);

    const historicalValidation = await fixture.store.validateDerivedItems({
      spaceId: fixture.spaceId,
      vaultId: fixture.vaultId,
      derivedStoreKind: "VECTOR",
      derivedItemRefs: [
        `vector:${fixture.generationId}:${fixture.explanationUnitId}`,
        `vector:${fixture.generationId}:${fixture.conclusionUnitId}`,
      ],
      truthRevisionHash: fixture.preWithdrawalRevisionHash,
      validAt: "2026-09-01T00:00:00.000Z",
    });
    expect(historicalValidation).toMatchObject([
      { state: "SUPPORTED", valid: true },
      { state: "SUPPORTED", valid: true },
    ]);

    const physicalCount = await db.pool.query<{ count: string }>(
      `select count(*)::text count
         from unit_embeddings
        where generation_id=$1 and unit_id=any($2::uuid[])`,
      [
        fixture.generationId,
        [fixture.explanationUnitId, fixture.conclusionUnitId],
      ],
    );
    expect(physicalCount.rows[0]?.count).toBe("2");
  });

  it("filters the higher-scoring OLD neighbor before RRF while preserving historical eligibility", async () => {
    const fixture = await seedContradictoryVectorFixture(
      "Contradictory dense neighbors",
    );
    const physical = await db.pool.query<{ unit_id: string; score: number }>(
      `select unit_id,
              1 - (embedding::vector(3) <=> '[1,0,0]'::vector(3)) score
         from unit_embeddings
        where generation_id=$1 and unit_id=any($2::uuid[])
        order by score desc,unit_id`,
      [fixture.generationId, [fixture.oldUnitId, fixture.newUnitId]],
    );
    const scoreByUnit = new Map(
      physical.rows.map((row) => [row.unit_id, Number(row.score)]),
    );
    expect(scoreByUnit.get(fixture.oldUnitId)).toBeGreaterThan(
      scoreByUnit.get(fixture.newUnitId) ?? Number.POSITIVE_INFINITY,
    );

    const warnings: string[] = [];
    const hits = await queryKnowledge(
      db,
      {
        ...searchInput(fixture.spaceId, fixture.vaultId),
        query: "TLS transport security minimum version",
      },
      {
        vaultIds: [fixture.vaultId],
        channels: ["vector"],
        allowVectorForBenchmark: true,
        queryEmbeddingService: queryService(),
        truthConsistency: "STRICT",
        warningSink: warnings,
      },
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      documentId: fixture.newDocumentId,
      fusionContributions: [
        expect.objectContaining({
          channel: "vector",
          rank: 1,
          rawScore: expect.any(Number),
        }),
      ],
    });
    const currentVectorScore = hits[0]?.fusionContributions?.find(
      (entry) => entry.channel === "vector",
    )?.rawScore;
    expect(currentVectorScore).toBeCloseTo(
      scoreByUnit.get(fixture.newUnitId) ?? 0,
      8,
    );
    expect(currentVectorScore).toBeLessThan(
      scoreByUnit.get(fixture.oldUnitId) ?? 0,
    );
    expect(warnings).toContain(
      `TRUTH_SUPPORT_REJECTED:VECTOR:${fixture.oldUnitId}`,
    );

    const historicalValidation = await fixture.store.validateDerivedItems({
      spaceId: fixture.spaceId,
      vaultId: fixture.vaultId,
      derivedStoreKind: "VECTOR",
      derivedItemRefs: [
        `vector:${fixture.generationId}:${fixture.oldUnitId}`,
        `vector:${fixture.generationId}:${fixture.newUnitId}`,
      ],
      truthRevisionHash: fixture.oldRevisionHash,
      validAt: "2026-09-01T00:00:00.000Z",
    });
    expect(historicalValidation).toMatchObject([
      {
        derivedItemRef: `vector:${fixture.generationId}:${fixture.oldUnitId}`,
        state: "SUPPORTED",
        valid: true,
      },
      {
        derivedItemRef: `vector:${fixture.generationId}:${fixture.newUnitId}`,
        state: "UNSUPPORTED",
        valid: false,
      },
    ]);

    const historicalFacts = await fixture.store.listFacts({
      spaceId: fixture.spaceId,
      vaultId: fixture.vaultId,
      subjectRef: "policy:transport",
      predicate: "tls_minimum",
      validAt: "2026-09-01T00:00:00.000Z",
      truthRevisionHash: fixture.oldRevisionHash,
    });
    expect(historicalFacts).toMatchObject([
      {
        object: { version: "1.2" },
        queryRevisionHash: fixture.oldRevisionHash,
      },
    ]);
    const currentFacts = await fixture.store.listFacts({
      spaceId: fixture.spaceId,
      vaultId: fixture.vaultId,
      subjectRef: "policy:transport",
      predicate: "tls_minimum",
      validAt: "2026-09-01T00:00:00.000Z",
      truthRevisionHash: fixture.newRevisionHash,
    });
    expect(currentFacts).toMatchObject([
      {
        object: { version: "1.3" },
        queryRevisionHash: fixture.newRevisionHash,
      },
    ]);
    const history = await fixture.store.supportHistory(historicalFacts[0]!.id);
    expect(history.supersessions).toEqual([
      expect.objectContaining({
        old_fact_id: historicalFacts[0]!.id,
        new_fact_id: currentFacts[0]!.id,
        truth_revision_hash: fixture.newRevisionHash,
      }),
    ]);
  });

  it("rejects a stale community summary before fusion while the physical community remains", async () => {
    const fixture = await seedFixture("Community derived truth");
    const revisionId = randomUUID();
    const communityRevision = `truth-community-${randomUUID()}`;
    const communityKey = `community:p5-${randomUUID()}`;
    await db.pool.query(
      `insert into community_index_revisions(
         id,space_id,vault_id,scope_id,community_revision,graph_revision,
         algorithm,algorithm_version,objective,resolution,random_seed,quality,
         hierarchy,lifecycle,status,stale,activated_at
       ) values(
         $1,$2,$3,$4,$5,$6,'LEIDEN','p5-test','CPM',0.5,7,1,
         '{}'::jsonb,'DERIVED_INDEX','ACTIVE',false,now()
       )`,
      [
        revisionId,
        fixture.spaceId,
        fixture.vaultId,
        `vault:${fixture.vaultId}`,
        communityRevision,
        fixture.corpusRevision,
      ],
    );
    await db.pool.query(
      `insert into community_index_communities(
         revision_id,community_key,ordinal,member_count,summary,
         summary_lifecycle,citable,support_set,hierarchy
       ) values(
         $1,$2,0,1,$3,'DERIVED_INDEX',false,'{}'::jsonb,'{}'::jsonb
       )`,
      [revisionId, communityKey, "panoramic omega support"],
    );
    await db.pool.query(
      `insert into community_index_memberships(
         revision_id,document_id,community_key,hierarchy
       ) values($1,$2,$3,'{}'::jsonb)`,
      [revisionId, fixture.documentId, communityKey],
    );
    await fixture.store.registerDerivedDependency({
      spaceId: fixture.spaceId,
      vaultId: fixture.vaultId,
      derivedStoreKind: "COMMUNITY_REPORT",
      derivedItemRef: `community:${communityRevision}:${communityKey}`,
      supportSetId: fixture.supportSetId,
      truthRevisionHash: fixture.preWithdrawalRevisionHash,
      projectionRevision: communityRevision,
    });

    const request = {
      ...searchInput(fixture.spaceId, fixture.vaultId),
      query: "panoramic omega support",
    };
    const plan = planQuery(request.query, "GLOBAL_SYNTHESIS", {
      vectorAvailable: false,
      graphConsistent: true,
      communityAvailable: true,
    });
    const before = await queryKnowledge(db, request, {
      vaultIds: [fixture.vaultId],
      plan,
      graphScopes: [{ vaultId: fixture.vaultId, pathPrefix: null }],
      retrievalPolicy: {
        channels: { COMMUNITY: { enabled: true, weight: 1.1 } },
      },
    });
    expect(
      before.some((hit) =>
        hit.fusionContributions?.some(
          (contribution) => contribution.channel === "community",
        ),
      ),
    ).toBe(true);

    await fixture.store.withdrawSourceEpisode({
      spaceId: fixture.spaceId,
      vaultId: fixture.vaultId,
      sourceEpisodeId: fixture.sourceEpisodeId,
      reason: "Community summary support withdrawn",
    });
    const warnings: string[] = [];
    const after = await queryKnowledge(db, request, {
      vaultIds: [fixture.vaultId],
      plan,
      graphScopes: [{ vaultId: fixture.vaultId, pathPrefix: null }],
      retrievalPolicy: {
        channels: { COMMUNITY: { enabled: true, weight: 1.1 } },
      },
      warningSink: warnings,
    });
    expect(
      after.some((hit) =>
        hit.fusionContributions?.some(
          (contribution) => contribution.channel === "community",
        ),
      ),
    ).toBe(false);
    expect(warnings).toContain(
      `TRUTH_SUPPORT_REJECTED:COMMUNITY:${communityKey}`,
    );
    const physical = await db.pool.query<{ count: string }>(
      `select count(*)::text count
         from community_index_communities
        where revision_id=$1 and community_key=$2`,
      [revisionId, communityKey],
    );
    expect(physical.rows[0]?.count).toBe("1");
  });

  it("rejects a stale context fragment before fusion while the document remains", async () => {
    const fixture = await seedFixture("Context fragment truth");
    await db.pool.query(
      `update knowledge_documents
          set layer='context-pack',type='context-pack'
        where id=$1 and space_id=$2 and vault_id=$3`,
      [fixture.documentId, fixture.spaceId, fixture.vaultId],
    );
    await fixture.store.registerDerivedDependency({
      spaceId: fixture.spaceId,
      vaultId: fixture.vaultId,
      derivedStoreKind: "CONTEXT_FRAGMENT",
      derivedItemRef:
        `context-fragment:${fixture.documentId}:${fixture.corpusRevision}`,
      supportSetId: fixture.supportSetId,
      truthRevisionHash: fixture.preWithdrawalRevisionHash,
      projectionRevision: fixture.corpusRevision,
    });

    const before = await queryKnowledge(
      db,
      searchInput(fixture.spaceId, fixture.vaultId),
      {
        vaultIds: [fixture.vaultId],
        channels: ["context-pack"],
      },
    );
    expect(before).toHaveLength(1);
    expect(before[0]?.documentId).toBe(fixture.documentId);
    expect(
      before[0]?.fusionContributions?.some(
        (contribution) => contribution.channel === "context-pack",
      ),
    ).toBe(true);

    await fixture.store.withdrawSourceEpisode({
      spaceId: fixture.spaceId,
      vaultId: fixture.vaultId,
      sourceEpisodeId: fixture.sourceEpisodeId,
      reason: "Context fragment support withdrawn",
    });
    const warnings: string[] = [];
    const after = await queryKnowledge(
      db,
      searchInput(fixture.spaceId, fixture.vaultId),
      {
        vaultIds: [fixture.vaultId],
        channels: ["context-pack"],
        warningSink: warnings,
      },
    );
    expect(after).toEqual([]);
    expect(warnings).toContain(
      `TRUTH_SUPPORT_REJECTED:CONTEXT_FRAGMENT:${fixture.documentId}`,
    );
    const physical = await db.pool.query<{ count: string }>(
      `select count(*)::text count
         from knowledge_documents
        where id=$1 and layer='context-pack'`,
      [fixture.documentId],
    );
    expect(physical.rows[0]?.count).toBe("1");
  });

  it("returns the captured snapshot with a warning in best-effort mode", async () => {
    const fixture = await seedFixture("Best effort truth vector");
    const warnings: string[] = [];
    let truthState: RetrievalTruthState | undefined;
    const hits = await queryKnowledge(
      db,
      searchInput(fixture.spaceId, fixture.vaultId),
      {
        vaultIds: [fixture.vaultId],
        channels: ["vector"],
        allowVectorForBenchmark: true,
        queryEmbeddingService: queryService(async () => {
          await fixture.store.withdrawSourceEpisode({
            spaceId: fixture.spaceId,
            vaultId: fixture.vaultId,
            sourceEpisodeId: fixture.sourceEpisodeId,
            reason: "Best-effort concurrent withdrawal",
          });
        }),
        truthConsistency: "BEST_EFFORT",
        warningSink: warnings,
        truthStateSink: (state) => {
          truthState = state;
        },
      },
    );
    expect(hits).toHaveLength(1);
    expect(warnings).toContain("CONTEXT_REVISION_CHANGED_BEST_EFFORT");
    expect(truthState).toMatchObject({
      consistency: "BEST_EFFORT",
      changedDuringQuery: true,
      snapshot: {
        vaults: [
          {
            vaultId: fixture.vaultId,
            revisionHash: fixture.preWithdrawalRevisionHash,
          },
        ],
      },
    });
  });
});
