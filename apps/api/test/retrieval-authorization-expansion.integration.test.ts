import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Postgres } from "@akp/postgres";
import { queryKnowledge } from "../src/routes/search.js";

const databaseUrl = process.env.DATABASE_URL;

interface Fixture {
  organizationId: string;
  spaceId: string;
  vaultId: string;
  revision: string;
  targetId: string;
}

function fixture(): Fixture {
  return {
    organizationId: randomUUID(),
    spaceId: randomUUID(),
    vaultId: randomUUID(),
    revision: `authorization-expansion-${randomUUID()}`,
    targetId: randomUUID(),
  };
}

async function seed(db: Postgres, current: Fixture): Promise<void> {
  await db.pool.query(
    `insert into organizations(id,slug,name)
     values($1,$2,'Authorization expansion integration')`,
    [
      current.organizationId,
      `authorization-expansion-${current.organizationId.slice(0, 8)}`,
    ],
  );
  await db.pool.query(
    `insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values($1,$2,$3,'Authorization expansion space','PRIVATE',$4)`,
    [
      current.spaceId,
      current.organizationId,
      `authorization-expansion-${current.spaceId.slice(0, 8)}`,
      `/tmp/authorization-expansion-${current.spaceId}`,
    ],
  );
  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,
       vault_key,local_path,visibility,enabled
     ) values($1,$2,$3,'Authorization expansion vault',true,$4,$5,$3,'PRIVATE',true)`,
    [
      current.vaultId,
      current.spaceId,
      `/tmp/authorization-expansion-${current.vaultId}`,
      current.revision,
      `authorization-expansion-${current.vaultId.slice(0, 8)}`,
    ],
  );

  const insertDocument = async (input: {
    id: string;
    path: string;
    externalId: string;
    aliases: string[];
    title: string;
    body: string;
  }) => {
    await db.pool.query(
      `insert into knowledge_documents(
         id,space_id,vault_id,path,external_id,aliases,title,type,lifecycle,
         trust_tier,current_revision,body_cache,frontmatter,layer,
         content_hash,token_estimate,raw_links
       ) values($1,$2,$3,$4,$5,$6,$7,'concept','ACTIVE','HUMAN_REVIEWED',
                $8,$9,$10::jsonb,'concept',$11,20,'[]'::jsonb)`,
      [
        input.id,
        current.spaceId,
        current.vaultId,
        input.path,
        input.externalId,
        input.aliases,
        input.title,
        current.revision,
        input.body,
        JSON.stringify({ id: input.externalId, title: input.title }),
        createHash("sha256").update(input.body).digest("hex"),
      ],
    );
  };

  // More private candidates than queryKnowledge's lexical candidate budget
  // for limit=10 (30). They deliberately carry the query in high-weight
  // identity fields, so a post-LIMIT authorization filter would starve target.
  for (let index = 0; index < 35; index += 1) {
    await insertDocument({
      id: randomUUID(),
      path: `private/authorization-clipping-${index}.md`,
      externalId: `AUTHORIZATION-CLIPPING-${index}`,
      aliases: ["authorization clipping"],
      title: `Authorization clipping ${index}`,
      body: "authorization clipping private decoy",
    });
  }

  await insertDocument({
    id: current.targetId,
    path: "shared/target.md",
    externalId: "SHARED-TARGET",
    aliases: [],
    title: "Scoped target",
    body: "authorization clipping",
  });

  await db.pool.query(
    `insert into vault_index_revisions(
       space_id,vault_id,corpus_revision,lexical_revision,vector_revision,
       graph_revision,context_pack_revision,status,warnings
     ) values($1,$2,$3,$3,null,null,null,'CONSISTENT','[]'::jsonb)`,
    [current.spaceId, current.vaultId, current.revision],
  );
}

async function cleanup(db: Postgres, current: Fixture): Promise<void> {
  await db.pool.query("delete from knowledge_units where vault_id=$1", [
    current.vaultId,
  ]);
  await db.pool.query("delete from knowledge_documents where vault_id=$1", [
    current.vaultId,
  ]);
  await db.pool.query("delete from vault_index_revisions where vault_id=$1", [
    current.vaultId,
  ]);
  await db.pool.query("delete from vaults where id=$1", [current.vaultId]);
  await db.pool.query("delete from spaces where id=$1", [current.spaceId]);
  await db.pool.query("delete from organizations where id=$1", [
    current.organizationId,
  ]);
}

describe("retrieval authorization expansion boundary", () => {
  it.skipIf(!databaseUrl)(
    "applies path authorization before lexical candidate ranking and LIMIT",
    async () => {
      if (!databaseUrl) return;
      const current = fixture();
      const db = new Postgres(databaseUrl);
      try {
        await seed(db, current);
        const hits = await queryKnowledge(
          db,
          {
            query: "authorization clipping",
            spaceId: current.spaceId,
            vaultId: current.vaultId,
            vaultIds: [],
            federated: false,
            types: [],
            minimumTrust: "MACHINE_SUPPORTED",
            mode: "SOURCE_BACKED",
            limit: 10,
          },
          {
            channels: ["lexical"],
            vaultIds: [current.vaultId],
            expansionScopes: [
              { vaultId: current.vaultId, pathPrefix: "shared" },
            ],
            pathAuthorizer: (documentPath, vaultId) =>
              vaultId === current.vaultId &&
              (documentPath === "shared" ||
                documentPath.startsWith("shared/")),
          },
        );

        expect(hits.map((hit) => hit.documentId)).toContain(current.targetId);
        expect(hits).toHaveLength(1);
        expect(hits[0]?.document.path).toBe("shared/target.md");
      } finally {
        await cleanup(db, current);
        await db.pool.end();
      }
    },
  );
});
