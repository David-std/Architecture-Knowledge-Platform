import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Postgres } from "@akp/postgres";
import { rebuildManagedRelations } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * The registry deliberately allows two vault identities to carry the same
 * checkout path, source SHA and document identities. Derived state must remain
 * scoped to the vault identity rather than collapsing on any of those values.
 */
describe("multivault managed relation isolation", () => {
  it.skipIf(!databaseUrl)(
    "accepts identical paths, IDs, aliases, hashes and source SHA without cross-vault resolution",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const organizationId = randomUUID();
      const spaceId = randomUUID();
      const vaultA = randomUUID();
      const vaultB = randomUUID();
      const sourceIds = [randomUUID(), randomUUID()];
      const duplicateSourceSha = createHash("sha256")
        .update("identical raw source bytes", "utf8")
        .digest("hex");
      try {
        await db.pool.query(
          `insert into organizations(id,slug,name) values($1,$2,$3)`,
          [
            organizationId,
            `mv-${organizationId.slice(0, 8)}`,
            "Multivault isolation test",
          ],
        );
        await db.pool.query(
          `insert into spaces(id,organization_id,slug,name,visibility,knowledge_repo_path)
           values($1,$2,$3,$4,'PRIVATE',$5)`,
          [
            spaceId,
            organizationId,
            `mv-${spaceId.slice(0, 8)}`,
            "Multivault isolation space",
            "C:/akp/multivault-shared-checkout",
          ],
        );
        const sharedPath = "C:/akp/multivault-shared-checkout";
        await db.pool.query(
          `insert into vaults(
             id,space_id,canonical_path,name,read_only,current_revision,
             vault_key,local_path,visibility,enabled
           ) values
             ($1,$3,$4,'Vault A',true,'rev-a',$5,$4,'PRIVATE',true),
             ($2,$3,$4,'Vault B',true,'rev-b',$6,$4,'PRIVATE',true)`,
          [
            vaultA,
            vaultB,
            spaceId,
            sharedPath,
            `mv-a-${vaultA.slice(0, 8)}`,
            `mv-b-${vaultB.slice(0, 8)}`,
          ],
        );

        await db.pool.query(
          `insert into sources(
             id,space_id,vault_id,title,source_uri,media_type,sha256,
             byte_size,object_key,status,metadata
           ) values
             ($1,$3,$4,'Shared source','file:///vault-a/shared.pdf','application/pdf',$6,26,$7,'ACTIVE','{}'::jsonb),
             ($2,$3,$5,'Shared source','file:///vault-b/shared.pdf','application/pdf',$6,26,$8,'ACTIVE','{}'::jsonb)`,
          [
            sourceIds[0],
            sourceIds[1],
            spaceId,
            vaultA,
            vaultB,
            duplicateSourceSha,
            `sha256/${duplicateSourceSha}/vault-a`,
            `sha256/${duplicateSourceSha}/vault-b`,
          ],
        );
        const duplicateSources = await db.pool.query<{
          vault_id: string;
          sha256: string;
        }>(
          `select vault_id,sha256
             from sources
            where id=any($1::uuid[])
            order by vault_id`,
          [sourceIds],
        );
        expect(duplicateSources.rows).toHaveLength(2);
        expect(
          duplicateSources.rows.every(
            (row) => row.sha256 === duplicateSourceSha,
          ),
        ).toBe(true);
        expect(new Set(duplicateSources.rows.map((row) => row.vault_id))).toEqual(
          new Set([vaultA, vaultB]),
        );

        const documents = [
          {
            vaultId: vaultA,
            externalId: "shared-source",
            title: "Shared Source",
            path: "managed/source.md",
            body: "Shared source body",
            aliases: ["shared-source-alias"],
            rawLinks: ["target.md"],
          },
          {
            vaultId: vaultB,
            externalId: "shared-source",
            title: "Shared Source",
            path: "managed/source.md",
            body: "Shared source body",
            aliases: ["shared-source-alias"],
            rawLinks: ["target.md"],
          },
          {
            vaultId: vaultA,
            externalId: "shared-target",
            title: "Shared Target",
            path: "managed/target.md",
            body: "Shared target body",
            aliases: ["shared-target-alias"],
            rawLinks: [],
          },
          {
            vaultId: vaultB,
            externalId: "shared-target",
            title: "Shared Target",
            path: "managed/target.md",
            body: "Shared target body",
            aliases: ["shared-target-alias"],
            rawLinks: [],
          },
        ] as const;
        for (const document of documents) {
          const contentHash = createHash("sha256")
            .update(document.body, "utf8")
            .digest("hex");
          await db.pool.query(
            `insert into knowledge_documents(
               space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,
               current_revision,body_cache,frontmatter,aliases,raw_links,content_hash
             ) values($1,$2,$3,$4,$5,'note','ACTIVE','CURATED','rev-$2',$6,$7,$8,$9,$10)`,
            [
              spaceId,
              document.vaultId,
              document.path,
              document.externalId,
              document.title,
              document.body,
              JSON.stringify({
                id: document.externalId,
                title: document.title,
                aliases: document.aliases,
              }),
              [...document.aliases],
              JSON.stringify(document.rawLinks),
              contentHash,
            ],
          );
        }

        const collisions = await db.pool.query<{
          path: string;
          external_id: string;
          title: string;
          aliases: string[];
          content_hash: string;
          vault_count: number;
        }>(
          `select path,external_id,title,aliases,content_hash,
                  count(distinct vault_id)::int as vault_count
             from knowledge_documents
            where vault_id=any($1::uuid[])
            group by path,external_id,title,aliases,content_hash
            order by path`,
          [[vaultA, vaultB]],
        );
        expect(collisions.rows).toHaveLength(2);
        expect(collisions.rows.every((row) => row.vault_count === 2)).toBe(true);
        expect(collisions.rows.map((row) => row.external_id).sort()).toEqual([
          "shared-source",
          "shared-target",
        ]);

        const relationsA = await rebuildManagedRelations(db, spaceId, vaultA);
        expect(relationsA).toBe(1);
        const linksA = await db.pool.query<{
          from_vault: string;
          to_vault: string;
          from_external_id: string;
          to_external_id: string;
        }>(
          `select f.vault_id as from_vault,t.vault_id as to_vault,
                  f.external_id as from_external_id,t.external_id as to_external_id
             from knowledge_relations r
             join knowledge_documents f on f.id=r.from_document_id
             join knowledge_documents t on t.id=r.to_document_id
            where r.space_id=$1 and r.provenance='managed-markdown' and f.vault_id=$2`,
          [spaceId, vaultA],
        );
        expect(linksA.rows).toEqual([
          {
            from_vault: vaultA,
            to_vault: vaultA,
            from_external_id: "shared-source",
            to_external_id: "shared-target",
          },
        ]);

        const relationsB = await rebuildManagedRelations(db, spaceId, vaultB);
        expect(relationsB).toBe(1);
        const linksB = await db.pool.query<{
          from_vault: string;
          to_vault: string;
          from_external_id: string;
          to_external_id: string;
        }>(
          `select f.vault_id as from_vault,t.vault_id as to_vault,
                  f.external_id as from_external_id,t.external_id as to_external_id
             from knowledge_relations r
             join knowledge_documents f on f.id=r.from_document_id
             join knowledge_documents t on t.id=r.to_document_id
            where r.space_id=$1 and r.provenance='managed-markdown' and f.vault_id=$2`,
          [spaceId, vaultB],
        );
        expect(linksB.rows).toEqual([
          {
            from_vault: vaultB,
            to_vault: vaultB,
            from_external_id: "shared-source",
            to_external_id: "shared-target",
          },
        ]);
      } finally {
        await db.pool.query(
          "delete from knowledge_relations where space_id=$1",
          [spaceId],
        );
        await db.pool.query(
          "delete from knowledge_documents where space_id=$1",
          [spaceId],
        );
        await db.pool.query("delete from sources where id=any($1::uuid[])", [
          sourceIds,
        ]);
        await db.pool.query(
          "delete from vault_index_revisions where space_id=$1",
          [spaceId],
        );
        await db.pool.query("delete from vaults where space_id=$1", [spaceId]);
        await db.pool.query("delete from spaces where id=$1", [spaceId]);
        await db.pool.query("delete from organizations where id=$1", [
          organizationId,
        ]);
        await db.pool.end();
      }
    },
  );
});
