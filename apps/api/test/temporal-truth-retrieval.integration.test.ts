import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SearchRequest } from "@akp/contracts";
import { Postgres, PostgresTemporalTruthStore } from "@akp/postgres";
import {
  EmbeddingGenerationManager,
  type RequestEmbeddingGeneration,
} from "@akp/indexing";
import {
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
  unitId: string;
  generationId: string;
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
    unitId,
    generationId: active.generationId,
    sourceEpisodeId: episode.id,
    preWithdrawalRevisionHash: fact.revision.revisionHash,
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
