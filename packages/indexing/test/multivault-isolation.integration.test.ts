import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Postgres } from "@akp/postgres";
import { rebuildManagedRelations } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * The registry deliberately allows two vault identities to reference the
 * same checkout path.  Derived documents and managed links must nevertheless
 * remain scoped to the vault identity, not the path (or enclosing space).
 */
describe("multivault managed relation isolation", () => {
  it.skipIf(!databaseUrl)(
    "accepts duplicate paths and never resolves a managed link across vaults",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const organizationId = randomUUID();
      const spaceId = randomUUID();
      const vaultA = randomUUID();
      const vaultB = randomUUID();
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

        const documents = [
          [vaultA, "source-a", "Source A"],
          [vaultA, "target-a", "Target A"],
          [vaultB, "source-b", "Source B"],
          [vaultB, "target-b", "Target B"],
        ] as const;
        for (const [vaultId, externalId, title] of documents) {
          const isSource = externalId.startsWith("source");
          await db.pool.query(
            `insert into knowledge_documents(
               space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,
               current_revision,body_cache,frontmatter,aliases,raw_links
             ) values($1,$2,$3,$4,$5,'note','ACTIVE','CURATED','rev-$2',$6,$7,$8,$9)`,
            [
              spaceId,
              vaultId,
              isSource ? "managed/source.md" : "managed/target.md",
              externalId,
              title,
              title,
              JSON.stringify({ id: externalId }),
              [],
              JSON.stringify(isSource ? ["target.md"] : []),
            ],
          );
        }

        const duplicatePathCount = await db.pool.query<{ count: number }>(
          `select count(*)::int as count
             from knowledge_documents
            where space_id=$1 and path in ('managed/source.md','managed/target.md')`,
          [spaceId],
        );
        expect(duplicatePathCount.rows[0]?.count).toBe(4);

        const relationsA = await rebuildManagedRelations(db, spaceId, vaultA);
        expect(relationsA).toBe(1);
        const linksA = await db.pool.query<{
          from_vault: string;
          to_vault: string;
          to_external_id: string;
        }>(
          `select f.vault_id as from_vault,t.vault_id as to_vault,t.external_id as to_external_id
             from knowledge_relations r
             join knowledge_documents f on f.id=r.from_document_id
             join knowledge_documents t on t.id=r.to_document_id
            where r.space_id=$1 and r.provenance='managed-markdown' and f.vault_id=$2`,
          [spaceId, vaultA],
        );
        expect(linksA.rows).toEqual([
          { from_vault: vaultA, to_vault: vaultA, to_external_id: "target-a" },
        ]);

        const relationsB = await rebuildManagedRelations(db, spaceId, vaultB);
        expect(relationsB).toBe(1);
        const linksB = await db.pool.query<{
          from_vault: string;
          to_vault: string;
          to_external_id: string;
        }>(
          `select f.vault_id as from_vault,t.vault_id as to_vault,t.external_id as to_external_id
             from knowledge_relations r
             join knowledge_documents f on f.id=r.from_document_id
             join knowledge_documents t on t.id=r.to_document_id
            where r.space_id=$1 and r.provenance='managed-markdown' and f.vault_id=$2`,
          [spaceId, vaultB],
        );
        expect(linksB.rows).toEqual([
          { from_vault: vaultB, to_vault: vaultB, to_external_id: "target-b" },
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
