import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Postgres } from "@akp/postgres";
import { rebuildCommunityIndex } from "../src/community-index.js";

const databaseUrl = process.env.DATABASE_URL;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("community index PostgreSQL integration", () => {
  it.skipIf(!databaseUrl)(
    "versions Leiden membership, keeps summaries derived/non-citable, and stales the prior revision",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const organizationId = randomUUID();
      const spaceId = randomUUID();
      const vaultId = randomUUID();
      const ids = Object.fromEntries(
        ["a", "b", "c", "d", "e", "f"].map((key) => [key, randomUUID()]),
      ) as Record<string, string>;
      try {
        await db.pool.query(
          "insert into organizations(id,slug,name) values($1,$2,$3)",
          [
            organizationId,
            `community-${organizationId.slice(0, 8)}`,
            "Community index integration",
          ],
        );
        await db.pool.query(
          `insert into spaces(
             id,organization_id,slug,name,visibility,knowledge_repo_path
           ) values($1,$2,$3,$4,'PRIVATE',$5)`,
          [
            spaceId,
            organizationId,
            `community-${spaceId.slice(0, 8)}`,
            "Community index space",
            "C:/akp/community-index",
          ],
        );
        await db.pool.query(
          `insert into vaults(
             id,space_id,canonical_path,name,read_only,current_revision,
             vault_key,local_path,visibility,enabled
           ) values($1,$2,$3,$4,true,'graph-1',$5,$3,'PRIVATE',true)`,
          [
            vaultId,
            spaceId,
            "C:/akp/community-index",
            "Community index vault",
            `community-${vaultId.slice(0, 8)}`,
          ],
        );

        for (const key of Object.keys(ids).sort()) {
          const body = `Community fixture ${key}`;
          await db.pool.query(
            `insert into knowledge_documents(
               id,space_id,vault_id,path,external_id,title,type,lifecycle,
               trust_tier,current_revision,body_cache,frontmatter,aliases,
               raw_links,layer,content_hash,token_estimate
             ) values(
               $1,$2,$3,$4,$5,$6,'note','ACTIVE','CURATED','graph-1',$7,
               '{}'::jsonb,'{}','[]'::jsonb,'test',$8,4
             )`,
            [
              ids[key],
              spaceId,
              vaultId,
              `managed/${key}.md`,
              `COMMUNITY-${key.toUpperCase()}`,
              `Community ${key.toUpperCase()}`,
              body,
              digest(body),
            ],
          );
        }

        const relationSpecs = [
          ["ab", "a", "b", 5],
          ["ac", "a", "c", 5],
          ["bc", "b", "c", 5],
          ["de", "d", "e", 5],
          ["df", "d", "f", 5],
          ["ef", "e", "f", 5],
          ["bridge", "c", "d", 0.01],
        ] as const;
        const relationIds = new Map<string, string>();
        for (const [key, from, to, weight] of relationSpecs) {
          const relationId = randomUUID();
          relationIds.set(key, relationId);
          await db.pool.query(
            `insert into knowledge_relations(
               id,space_id,from_document_id,to_document_id,relation_type,
               weight,provenance,metadata
             ) values($1,$2,$3,$4,'supports',$5,'community-test','{}'::jsonb)`,
            [relationId, spaceId, ids[from], ids[to], weight],
          );
        }

        const first = await rebuildCommunityIndex(db, {
          spaceId,
          vaultId,
          graphRevision: "graph-1",
          resolution: 0.5,
          randomSeed: 7,
        });
        expect(first.reused).toBe(false);
        expect(first.communities).toBe(2);
        expect(first.memberships).toBe(6);

        const revision = await db.pool.query<{
          lifecycle: string;
          status: string;
          stale: boolean;
          algorithm: string;
          algorithm_version: string;
          objective: string;
          resolution: number;
          graph_revision: string;
        }>(
          `select lifecycle,status,stale,algorithm,algorithm_version,objective,
                  resolution,graph_revision
             from community_index_revisions where id=$1`,
          [first.revisionId],
        );
        expect(revision.rows[0]).toMatchObject({
          lifecycle: "DERIVED_INDEX",
          status: "ACTIVE",
          stale: false,
          algorithm: "LEIDEN",
          algorithm_version: "ngraph.leiden@0.3.0",
          objective: "CPM",
          resolution: 0.5,
          graph_revision: "graph-1",
        });

        const communities = await db.pool.query<{
          summary_lifecycle: string;
          citable: boolean;
          member_count: number;
          support_set: {
            documentIds: string[];
            relationKeys: string[];
          };
        }>(
          `select summary_lifecycle,citable,member_count,support_set
             from community_index_communities
            where revision_id=$1
            order by ordinal`,
          [first.revisionId],
        );
        expect(communities.rows).toHaveLength(2);
        expect(
          communities.rows.every(
            (community) =>
              community.summary_lifecycle === "DERIVED_INDEX" &&
              community.citable === false &&
              community.member_count === 3,
          ),
        ).toBe(true);
        expect(
          communities.rows.flatMap(
            (community) => community.support_set.relationKeys,
          ),
        ).not.toContain([ids.c, "supports", ids.d, "community-test"].join(":"));

        const repeated = await rebuildCommunityIndex(db, {
          spaceId,
          vaultId,
          graphRevision: "graph-1",
          resolution: 0.5,
          randomSeed: 7,
        });
        expect(repeated.reused).toBe(true);
        expect(repeated.revisionId).toBe(first.revisionId);
        expect(repeated.communityRevision).toBe(first.communityRevision);

        await db.pool.query(
          "update knowledge_relations set weight=10 where id=$1",
          [relationIds.get("bridge")],
        );
        const second = await rebuildCommunityIndex(db, {
          spaceId,
          vaultId,
          graphRevision: "graph-2",
          resolution: 0.5,
          randomSeed: 7,
        });
        expect(second.reused).toBe(false);
        expect(second.communityRevision).not.toBe(first.communityRevision);

        const lifecycle = await db.pool.query<{
          community_revision: string;
          status: string;
          stale: boolean;
        }>(
          `select community_revision,status,stale
             from community_index_revisions
            where space_id=$1 and vault_id=$2
            order by built_at,id`,
          [spaceId, vaultId],
        );
        expect(lifecycle.rows).toEqual([
          {
            community_revision: first.communityRevision,
            status: "STALE",
            stale: true,
          },
          {
            community_revision: second.communityRevision,
            status: "ACTIVE",
            stale: false,
          },
        ]);
      } finally {
        await db.pool.query(
          "delete from community_index_revisions where space_id=$1",
          [spaceId],
        );
        await db.pool.query(
          "delete from knowledge_relations where space_id=$1",
          [spaceId],
        );
        await db.pool.query(
          "delete from knowledge_documents where space_id=$1",
          [spaceId],
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
