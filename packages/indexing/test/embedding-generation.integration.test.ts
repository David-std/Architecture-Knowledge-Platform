import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Postgres } from "@akp/postgres";
import {
  EmbeddingGenerationManager,
  type RequestEmbeddingGeneration,
} from "../src/embedding-generation.js";

const databaseUrl = process.env.DATABASE_URL;

function vector(dimensions: number, value = 0.001): number[] {
  const values = Array.from({ length: dimensions }, () => value);
  const norm = Math.hypot(...values);
  return values.map((component) => component / norm);
}

function descriptor(
  dimensions: number,
  configurationHash: string,
  normalization = "l2",
): RequestEmbeddingGeneration["descriptor"] {
  return {
    provider: dimensions === 64 ? "local-deterministic" : "local-semantic",
    model: dimensions === 64 ? "hash-projection" : "multilingual-e5-small",
    modelRevision: "test-revision-1",
    dimensions,
    normalization,
    inputStrategy: dimensions === 64 ? "unit-body-v1" : "passage-prefix-v1",
    configurationVersion: `test-${dimensions}-v1`,
    runtime:
      dimensions === 64
        ? "node-test"
        : {
            backend: "onnxruntime-node",
            device: "cpu",
            dtype: "fp32",
            library: "@huggingface/transformers",
            libraryVersion: "4.2.0",
            maxTokens: 512,
          },
    configurationHash,
  };
}

describe("provider-neutral embedding generation lifecycle", () => {
  it.skipIf(!databaseUrl)(
    "keeps generations scoped, supports 64/384 side by side, and activates atomically",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const manager = new EmbeddingGenerationManager(db);
      const organizationId = randomUUID();
      const spaceId = randomUUID();
      const vaultId = randomUUID();
      const documentId = randomUUID();
      const unitAId = randomUUID();
      const unitBId = randomUUID();
      const corpusRevision = "embedding-generation-test-revision";
      const unitAHash = "a".repeat(64);
      const unitBHash = "b".repeat(64);
      const base = {
        spaceId,
        vaultId,
        corpusRevision,
      };
      const request64: RequestEmbeddingGeneration = {
        ...base,
        descriptor: descriptor(64, "1".repeat(64)),
      };
      const request384: RequestEmbeddingGeneration = {
        ...base,
        descriptor: descriptor(384, "2".repeat(64)),
      };

      try {
        await db.pool.query(
          `insert into organizations(id,slug,name) values($1,$2,$3)`,
          [
            organizationId,
            `eg-${organizationId.slice(0, 8)}`,
            "Generation test",
          ],
        );
        await db.pool.query(
          `insert into spaces(
             id,organization_id,slug,name,visibility,knowledge_repo_path
           ) values($1,$2,$3,$4,'PRIVATE',$5)`,
          [
            spaceId,
            organizationId,
            `eg-${spaceId.slice(0, 8)}`,
            "Generation test space",
            "C:/akp/embedding-generation-test",
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
            "C:/akp/embedding-generation-test",
            "Generation test vault",
            corpusRevision,
            `eg-${vaultId.slice(0, 8)}`,
          ],
        );
        await db.pool.query(
          `insert into knowledge_documents(
             id,space_id,vault_id,path,external_id,title,type,lifecycle,
             trust_tier,current_revision,body_cache,frontmatter,aliases,layer,
             content_hash,token_estimate,raw_links
           ) values($1,$2,$3,'managed/generation.md','EG-DOC','Generation test',
             'note','ACTIVE','CURATED',$4,$5,$6,'{}','test',$7,4,'[]'::jsonb)`,
          [
            documentId,
            spaceId,
            vaultId,
            corpusRevision,
            "A deterministic and semantic generation fixture.",
            JSON.stringify({ id: "EG-DOC" }),
            "c".repeat(64),
          ],
        );
        for (const [unitId, unitKey, body, contentHash] of [
          [unitAId, "paragraph-a", "First unit", unitAHash],
          [unitBId, "paragraph-b", "Second unit", unitBHash],
        ] as const) {
          await db.pool.query(
            `insert into knowledge_units(
               id,document_id,space_id,vault_id,unit_key,unit_type,body,
               content_hash,corpus_revision,lifecycle,trust_tier,
               document_revision,embedding_eligible
             ) values($1,$2,$3,$4,$5,'PARAGRAPH',$6,$7,$8,'ACTIVE','CURATED',$8,true)`,
            [
              unitId,
              documentId,
              spaceId,
              vaultId,
              unitKey,
              body,
              contentHash,
              corpusRevision,
            ],
          );
        }

        const generation64 = await manager.request(request64);
        expect(generation64.status).toBe("REQUESTED");
        expect(generation64.dimensions).toBe(64);
        expect((await manager.request(request64)).generationId).toBe(
          generation64.generationId,
        );
        await expect(manager.ready(generation64.generationId)).rejects.toThrow(
          "INVALID_EMBEDDING_GENERATION_TRANSITION",
        );
        await expect(
          manager.activate(generation64.generationId),
        ).rejects.toThrow("EMBEDDING_GENERATION_NOT_READY");

        expect((await manager.build(generation64.generationId)).status).toBe(
          "BUILDING",
        );
        await expect(
          manager.writeEmbedding({
            generationId: generation64.generationId,
            unitId: unitAId,
            contentHash: unitAHash,
            embedding: vector(384),
          }),
        ).rejects.toThrow("EMBEDDING_DIMENSION_MISMATCH");
        await expect(
          manager.writeEmbedding({
            generationId: generation64.generationId,
            unitId: unitAId,
            contentHash: unitAHash,
            embedding: Array.from({ length: 64 }, () => 1),
          }),
        ).rejects.toThrow("EMBEDDING_NORMALIZATION_MISMATCH");
        await manager.writeEmbedding({
          generationId: generation64.generationId,
          unitId: unitAId,
          contentHash: unitAHash,
          embedding: vector(64),
        });
        await manager.writeEmbedding({
          generationId: generation64.generationId,
          unitId: unitBId,
          contentHash: unitBHash,
          embedding: vector(64, 0.002),
        });
        expect((await manager.ready(generation64.generationId, 2)).status).toBe(
          "READY",
        );
        expect((await manager.activate(generation64.generationId)).status).toBe(
          "ACTIVE",
        );

        const generation384 = await manager.request(request384);
        expect(generation384.status).toBe("REQUESTED");
        expect(generation384.runtime).toContain('"backend":"onnxruntime-node"');
        await manager.build(generation384.generationId);
        expect((await manager.getActive(spaceId, vaultId))?.generationId).toBe(
          generation64.generationId,
        );
        await expect(
          manager.activate(generation384.generationId),
        ).rejects.toThrow("EMBEDDING_GENERATION_NOT_READY");

        // A direct SQL write proves the database trigger catches malformed
        // vectors even when a caller bypasses the manager's early check.
        const malformedVector = `[${vector(64).join(",")}]`;
        await expect(
          db.pool.query(
            `insert into unit_embeddings(
               unit_id,generation_id,content_hash,embedding,embedding_dimensions
             ) values($1,$2,$3,$4::vector,384)`,
            [unitAId, generation384.generationId, unitAHash, malformedVector],
          ),
        ).rejects.toThrow("EMBEDDING_DIMENSION_MISMATCH");

        const wrongNormVector384 = `[${Array.from({ length: 384 }, () => 1).join(",")}]`;
        await expect(
          db.pool.query(
            `insert into unit_embeddings(
               unit_id,generation_id,content_hash,embedding,embedding_dimensions
            ) values($1,$2,$3,$4::vector,384)`,
            [
              unitAId,
              generation384.generationId,
              unitAHash,
              wrongNormVector384,
            ],
          ),
        ).rejects.toThrow("EMBEDDING_NORMALIZATION_MISMATCH");

        const wrongNormVector64 = `[${Array.from({ length: 64 }, () => 1).join(",")}]`;

        const providerDefined = await manager.request({
          ...base,
          descriptor: descriptor(64, "3".repeat(64), "provider-defined"),
        });
        await manager.build(providerDefined.generationId);
        await expect(
          db.pool.query(
            `insert into unit_embeddings(
               unit_id,generation_id,content_hash,embedding,embedding_dimensions
             ) values($1,$2,$3,$4::vector,64)`,
            [
              unitAId,
              providerDefined.generationId,
              unitAHash,
              wrongNormVector64,
            ],
          ),
        ).resolves.toMatchObject({ rowCount: 1 });

        await manager.writeEmbedding({
          generationId: generation384.generationId,
          unitId: unitAId,
          contentHash: unitAHash,
          embedding: vector(384),
        });
        await manager.writeEmbedding({
          generationId: generation384.generationId,
          unitId: unitBId,
          contentHash: unitBHash,
          embedding: vector(384, 0.002),
        });
        expect(
          (await manager.ready(generation384.generationId, 2)).status,
        ).toBe("READY");

        const activated384 = await manager.activate(generation384.generationId);
        expect(activated384.status).toBe("ACTIVE");
        expect(
          (await manager.activate(generation384.generationId)).generationId,
        ).toBe(generation384.generationId);
        expect((await manager.getActive(spaceId, vaultId))?.generationId).toBe(
          generation384.generationId,
        );
        const retired64 = await manager.get(generation64.generationId);
        expect(retired64?.status).toBe("RETIRED");
        expect(
          (
            await db.pool.query<{ count: string }>(
              `select count(*)::text count from embedding_generations
                where space_id=$1 and vault_id=$2 and status='ACTIVE'`,
              [spaceId, vaultId],
            )
          ).rows[0]?.count,
        ).toBe("1");

        const coexistence = await db.pool.query<{
          dimensions: number;
          status: string;
          count: string;
        }>(
          `select g.dimensions,g.status,count(e.id)::text count
             from embedding_generations g
             left join unit_embeddings e on e.generation_id=g.id
            where g.vault_id=$1 and g.id=any($2::uuid[])
            group by g.id order by g.dimensions`,
          [vaultId, [generation64.generationId, generation384.generationId]],
        );
        expect(coexistence.rows).toEqual([
          { dimensions: 64, status: "RETIRED", count: "2" },
          { dimensions: 384, status: "ACTIVE", count: "2" },
        ]);
        await expect(
          manager.fail(generation384.generationId, "cannot fail active"),
        ).rejects.toThrow("INVALID_EMBEDDING_GENERATION_TRANSITION");
      } finally {
        await db.pool.query(
          `delete from embedding_generations where vault_id=$1`,
          [vaultId],
        );
        await db.pool.query(`delete from knowledge_documents where id=$1`, [
          documentId,
        ]);
        await db.pool.query(`delete from vaults where id=$1`, [vaultId]);
        await db.pool.query(`delete from spaces where id=$1`, [spaceId]);
        await db.pool.query(`delete from organizations where id=$1`, [
          organizationId,
        ]);
        await db.pool.end();
      }
    },
  );
});
