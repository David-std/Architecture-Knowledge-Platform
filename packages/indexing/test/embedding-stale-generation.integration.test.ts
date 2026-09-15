import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Postgres } from "@akp/postgres";
import { EmbeddingGenerationManager } from "../src/embedding-generation.js";

const databaseUrl = process.env.DATABASE_URL;

describe("embedding stale generation lifecycle", () => {
  it.skipIf(!databaseUrl)(
    "removes a stale generation from normal selection and permits a controlled rebuild",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const organizationId = randomUUID();
      const spaceId = randomUUID();
      const vaultId = randomUUID();
      const manager = new EmbeddingGenerationManager(db);

      try {
        await db.pool.query(
          "insert into organizations(id,slug,name) values($1,$2,$3)",
          [
            organizationId,
            `stale-${organizationId.slice(0, 8)}`,
            "Stale generation test",
          ],
        );
        await db.pool.query(
          `insert into spaces(
             id,organization_id,slug,name,visibility,knowledge_repo_path
           ) values($1,$2,$3,$4,'PRIVATE',$5)`,
          [
            spaceId,
            organizationId,
            `stale-${spaceId.slice(0, 8)}`,
            "Stale generation test space",
            `/tmp/akp-stale-generation-${spaceId}`,
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
            `/tmp/akp-stale-generation-${vaultId}`,
            "Stale generation test vault",
            "stale-generation-revision",
            `stale-${vaultId.slice(0, 8)}`,
          ],
        );

        const generation = await manager.request({
          spaceId,
          vaultId,
          corpusRevision: "stale-generation-revision",
          descriptor: {
            provider: "local-deterministic",
            model: "hash-projection",
            modelRevision: "test-revision-1",
            dimensions: 64,
            normalization: "l2",
            inputStrategy: "unit-body-v1",
            configurationVersion: "stale-generation-test-v1",
            runtime: "node-test",
            configurationHash: "4".repeat(64),
          },
        });
        expect((await manager.build(generation.generationId)).status).toBe(
          "BUILDING",
        );

        const stale = await manager.stale(generation.generationId);
        expect(stale.status).toBe("STALE");
        expect((await manager.get(generation.generationId))?.status).toBe(
          "STALE",
        );
        expect(await manager.getActive(spaceId, vaultId)).toBeNull();

        const rebuilt = await manager.build(generation.generationId);
        expect(rebuilt.status).toBe("BUILDING");
      } finally {
        await db.pool.query(
          "delete from embedding_generations where vault_id=$1",
          [vaultId],
        );
        await db.pool.query("delete from vaults where id=$1", [vaultId]);
        await db.pool.query("delete from spaces where id=$1", [spaceId]);
        await db.pool.query("delete from organizations where id=$1", [
          organizationId,
        ]);
        await db.pool.end();
      }
    },
  );
});
