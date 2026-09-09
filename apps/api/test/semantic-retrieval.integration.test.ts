import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type SearchRequest } from "@akp/contracts";
import { Postgres } from "@akp/postgres";
import {
  EmbeddingGenerationManager,
  type RequestEmbeddingGeneration,
} from "@akp/indexing";
import {
  QueryEmbeddingService,
  type ActiveEmbeddingGenerationDescriptor,
  type EmbeddingInputRole,
  type EmbeddingProvider,
  type EmbeddingRequestOptions,
} from "@akp/retrieval";
import { queryKnowledge } from "../src/routes/search.js";

const databaseUrl = process.env.DATABASE_URL;

const semanticDescriptor: RequestEmbeddingGeneration["descriptor"] = {
  provider: "semantic-integration-test",
  model: "multilingual-test-model",
  modelRevision: "integration-revision-1",
  dimensions: 3,
  normalization: "l2",
  inputStrategy: "semantic-query-passage-v1",
  configurationVersion: "semantic-integration-v1",
  runtime: "test-semantic-runtime",
};

interface ScopeIds {
  organizationId: string;
  spaceId: string;
  vaultId: string;
  documentId: string;
  unitId: string;
}

interface FixtureIds {
  primary: ScopeIds;
  secondVault: ScopeIds;
  otherSpace: ScopeIds;
  corpusRevision: string;
}

function scopeIds(): ScopeIds {
  return {
    organizationId: randomUUID(),
    spaceId: randomUUID(),
    vaultId: randomUUID(),
    documentId: randomUUID(),
    unitId: randomUUID(),
  };
}

function searchInput(
  spaceId: string,
  vaultId: string,
  query: string,
): SearchRequest {
  return {
    query,
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

async function seedScope(
  db: Postgres,
  scope: ScopeIds,
  corpusRevision: string,
  label: string,
): Promise<{ generationId: string }> {
  await db.pool.query(
    `insert into organizations(id,slug,name)
     values($1,$2,$3)
     on conflict(id) do nothing`,
    [
      scope.organizationId,
      `semantic-${scope.organizationId.slice(0, 8)}`,
      label,
    ],
  );
  await db.pool.query(
    `insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values($1,$2,$3,$4,'PRIVATE',$5)
     on conflict(id) do nothing`,
    [
      scope.spaceId,
      scope.organizationId,
      `semantic-${scope.spaceId.slice(0, 8)}`,
      `${label} space`,
      `C:/akp/semantic-retrieval/${scope.spaceId}`,
    ],
  );
  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,
       vault_key,local_path,visibility,enabled
     ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)`,
    [
      scope.vaultId,
      scope.spaceId,
      `C:/akp/semantic-retrieval/${scope.vaultId}`,
      `${label} vault`,
      corpusRevision,
      `semantic-${scope.vaultId.slice(0, 8)}`,
    ],
  );

  const documentHash = "a".repeat(64);
  const unitHash = "b".repeat(64);
  const body = `Cancel enrollment guidance for ${label}. A learner may cancel an enrollment before the deadline.`;
  await db.pool.query(
    `insert into knowledge_documents(
       id,space_id,vault_id,path,external_id,title,type,lifecycle,
       trust_tier,current_revision,body_cache,frontmatter,aliases,layer,
       content_hash,token_estimate,raw_links
     ) values($1,$2,$3,$4,$5,'Cancel enrollment','rule','ACTIVE',
       'HUMAN_REVIEWED',$6,$7,$8::jsonb,'{}','concept',$9,20,'[]'::jsonb)`,
    [
      scope.documentId,
      scope.spaceId,
      scope.vaultId,
      `managed/cancel-enrollment-${scope.documentId.slice(0, 8)}.md`,
      `SEMANTIC-${scope.documentId.slice(0, 8)}`,
      corpusRevision,
      body,
      JSON.stringify({
        id: `SEMANTIC-${scope.documentId.slice(0, 8)}`,
        title: "Cancel enrollment",
        knowledge_layer: "concept",
      }),
      documentHash,
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
      scope.unitId,
      scope.documentId,
      scope.spaceId,
      scope.vaultId,
      `paragraph-${scope.unitId.slice(0, 8)}`,
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
    [scope.spaceId, scope.vaultId, corpusRevision],
  );

  const manager = new EmbeddingGenerationManager(db);
  const requested = await manager.request({
    spaceId: scope.spaceId,
    vaultId: scope.vaultId,
    corpusRevision,
    descriptor: semanticDescriptor,
  });
  expect(requested.status).toBe("REQUESTED");
  expect(requested.dimensions).toBe(semanticDescriptor.dimensions);
  await expect(manager.build(requested.generationId)).resolves.toMatchObject({
    status: "BUILDING",
  });
  await manager.writeEmbedding({
    generationId: requested.generationId,
    unitId: scope.unitId,
    contentHash: unitHash,
    embedding: [1, 0, 0],
  });
  await expect(manager.ready(requested.generationId, 1)).resolves.toMatchObject(
    {
      status: "READY",
    },
  );
  const active = await manager.activate(requested.generationId);
  expect(active.status).toBe("ACTIVE");
  return { generationId: active.generationId };
}

async function cleanupFixture(
  db: Postgres,
  fixture: FixtureIds,
): Promise<void> {
  const vaultIds = [
    fixture.primary.vaultId,
    fixture.secondVault.vaultId,
    fixture.otherSpace.vaultId,
  ];
  const spaceIds = [fixture.primary.spaceId, fixture.otherSpace.spaceId];
  const organizationIds = [
    fixture.primary.organizationId,
    fixture.secondVault.organizationId,
    fixture.otherSpace.organizationId,
  ];
  await db.pool.query(
    `delete from unit_embeddings
      where generation_id in (
        select id from embedding_generations where vault_id=any($1::uuid[])
      )`,
    [vaultIds],
  );
  await db.pool.query(
    `delete from embedding_generations where vault_id=any($1::uuid[])`,
    [vaultIds],
  );
  await db.pool.query(
    `delete from knowledge_units where vault_id=any($1::uuid[])`,
    [vaultIds],
  );
  await db.pool.query(
    `delete from knowledge_documents where vault_id=any($1::uuid[])`,
    [vaultIds],
  );
  await db.pool.query(
    `delete from vault_index_revisions where vault_id=any($1::uuid[])`,
    [vaultIds],
  );
  await db.pool.query(`delete from vaults where id=any($1::uuid[])`, [
    vaultIds,
  ]);
  await db.pool.query(`delete from spaces where id=any($1::uuid[])`, [
    spaceIds,
  ]);
  await db.pool.query(`delete from organizations where id=any($1::uuid[])`, [
    organizationIds,
  ]);
}

describe("semantic retrieval PostgreSQL integration", () => {
  it.skipIf(!databaseUrl)(
    "activates a semantic generation, queries the correct scope, and degrades only vector on provider failure",
    async () => {
      if (!databaseUrl) return;

      const previousVectorEnabled = process.env.AKP_VECTOR_ENABLED;
      process.env.AKP_VECTOR_ENABLED = "true";
      const primary = scopeIds();
      const secondVault = scopeIds();
      const otherSpace = scopeIds();
      const fixture: FixtureIds = {
        primary,
        secondVault: {
          ...secondVault,
          organizationId: primary.organizationId,
          spaceId: primary.spaceId,
        },
        otherSpace,
        corpusRevision: `semantic-integration-${randomUUID()}`,
      };
      const db = new Postgres(databaseUrl);

      try {
        // The first two vaults intentionally share a space. The third fixture
        // repeats the same vector in another space, proving both boundaries
        // are enforced by queryKnowledge and by the active generation join.
        const primaryGeneration = await seedScope(
          db,
          fixture.primary,
          fixture.corpusRevision,
          "Primary",
        );
        const secondVaultGeneration = await seedScope(
          db,
          fixture.secondVault,
          fixture.corpusRevision,
          "Second vault",
        );
        const otherSpaceGeneration = await seedScope(
          db,
          fixture.otherSpace,
          fixture.corpusRevision,
          "Other space",
        );

        const activeRows = await db.pool.query<{
          generation_id: string;
          status: string;
          dimensions: number;
          embedding_dimensions: number;
          vector_dimensions: number;
        }>(
          `select g.id generation_id,g.status,g.dimensions,
                  e.embedding_dimensions,vector_dims(e.embedding) vector_dimensions
             from embedding_generations g
             join unit_embeddings e on e.generation_id=g.id
            where g.id=$1 and g.vault_id=$2`,
          [primaryGeneration.generationId, fixture.primary.vaultId],
        );
        expect(activeRows.rows).toEqual([
          {
            generation_id: primaryGeneration.generationId,
            status: "ACTIVE",
            dimensions: 3,
            embedding_dimensions: 3,
            vector_dimensions: 3,
          },
        ]);

        const providerRoles: Array<EmbeddingInputRole | undefined> = [];
        const semanticProvider: EmbeddingProvider = {
          descriptor: semanticDescriptor,
          embed: async (
            texts: readonly string[],
            request?: EmbeddingInputRole | EmbeddingRequestOptions,
          ) => {
            const role = typeof request === "string" ? request : request?.role;
            // The provider is deliberately tiny but semantically shaped: a
            // query vector is compared with the passage vector persisted by
            // the real generation manager. The integration is PostgreSQL and
            // pgvector-backed; no mock database is involved.
            expect(texts).toHaveLength(1);
            providerRoles.push(role);
            return [[1, 0, 0]];
          },
        };
        const resolverCalls: ActiveEmbeddingGenerationDescriptor[] = [];
        const queryService = new QueryEmbeddingService(async (generation) => {
          resolverCalls.push(generation);
          return semanticProvider;
        });

        const semanticQuery = "¿Cómo cancelar una matrícula?";
        const primaryHits = await queryKnowledge(
          db,
          searchInput(
            fixture.primary.spaceId,
            fixture.primary.vaultId,
            semanticQuery,
          ),
          {
            vaultIds: [fixture.primary.vaultId],
            channels: ["vector"],
            queryEmbeddingService: queryService,
          },
        );
        expect(primaryHits).toHaveLength(1);
        expect(primaryHits[0]).toMatchObject({
          documentId: fixture.primary.documentId,
          vaultId: fixture.primary.vaultId,
          unitId: fixture.primary.unitId,
          reasons: ["vector"],
        });
        expect(primaryHits[0]?.documentId).not.toBe(
          fixture.secondVault.documentId,
        );
        expect(primaryHits[0]?.documentId).not.toBe(
          fixture.otherSpace.documentId,
        );
        expect(resolverCalls).toHaveLength(1);
        expect(resolverCalls[0]).toMatchObject({
          generationId: primaryGeneration.generationId,
          spaceId: fixture.primary.spaceId,
          vaultId: fixture.primary.vaultId,
          dimensions: 3,
          inputStrategy: semanticDescriptor.inputStrategy,
        });
        expect(providerRoles).toEqual(["query"]);

        // The same provider and vector are valid for the other vault, but the
        // target scope selects its own active generation and document only.
        resolverCalls.length = 0;
        providerRoles.length = 0;
        const secondVaultHits = await queryKnowledge(
          db,
          searchInput(
            fixture.primary.spaceId,
            fixture.secondVault.vaultId,
            semanticQuery,
          ),
          {
            vaultIds: [fixture.secondVault.vaultId],
            channels: ["vector"],
            queryEmbeddingService: queryService,
          },
        );
        expect(secondVaultHits).toHaveLength(1);
        expect(secondVaultHits[0]).toMatchObject({
          documentId: fixture.secondVault.documentId,
          vaultId: fixture.secondVault.vaultId,
          unitId: fixture.secondVault.unitId,
        });
        expect(resolverCalls[0]?.generationId).toBe(
          secondVaultGeneration.generationId,
        );

        const foreignSpaceHits = await queryKnowledge(
          db,
          searchInput(
            fixture.otherSpace.spaceId,
            fixture.otherSpace.vaultId,
            semanticQuery,
          ),
          {
            vaultIds: [fixture.otherSpace.vaultId],
            channels: ["vector"],
            queryEmbeddingService: queryService,
          },
        );
        expect(foreignSpaceHits).toHaveLength(1);
        expect(foreignSpaceHits[0]?.documentId).toBe(
          fixture.otherSpace.documentId,
        );
        expect(resolverCalls.at(-1)?.generationId).toBe(
          otherSpaceGeneration.generationId,
        );

        const wrongSpaceHits = await queryKnowledge(
          db,
          searchInput(
            fixture.otherSpace.spaceId,
            fixture.primary.vaultId,
            semanticQuery,
          ),
          {
            vaultIds: [fixture.primary.vaultId],
            channels: ["vector"],
            queryEmbeddingService: queryService,
          },
        );
        expect(wrongSpaceHits).toEqual([]);

        const unavailableWarnings: string[] = [];
        const unavailableService = new QueryEmbeddingService(async () => {
          throw new Error(
            "provider offline; bearer super-secret must not leak",
          );
        });
        const degradedHits = await queryKnowledge(
          db,
          searchInput(
            fixture.primary.spaceId,
            fixture.primary.vaultId,
            "Cancel enrollment",
          ),
          {
            vaultIds: [fixture.primary.vaultId],
            channels: ["exact", "lexical", "vector"],
            queryEmbeddingService: unavailableService,
            warningSink: unavailableWarnings,
          },
        );
        expect(degradedHits).toHaveLength(1);
        expect(degradedHits[0]?.documentId).toBe(fixture.primary.documentId);
        expect(degradedHits[0]?.reasons).toContain("exact-or-alias");
        expect(degradedHits[0]?.reasons).toContain("lexical");
        expect(degradedHits[0]?.reasons).not.toContain("vector");
        expect(unavailableWarnings).toEqual([
          `VECTOR_PROVIDER_UNAVAILABLE:${fixture.primary.vaultId}`,
        ]);
        expect(unavailableWarnings.join(" ")).not.toContain("super-secret");
      } finally {
        await cleanupFixture(db, fixture).catch(() => undefined);
        await db.close();
        if (previousVectorEnabled === undefined) {
          delete process.env.AKP_VECTOR_ENABLED;
        } else {
          process.env.AKP_VECTOR_ENABLED = previousVectorEnabled;
        }
      }
    },
  );
});
