import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type SearchRequest } from "@akp/contracts";
import { Postgres } from "@akp/postgres";
import { planQuery } from "@akp/retrieval";
import { queryKnowledge } from "../src/routes/search.js";

const databaseUrl = process.env.DATABASE_URL;

type LexicalCase =
  | "externalId"
  | "alias"
  | "exactTitle"
  | "path"
  | "titleTerms"
  | "headingTerms"
  | "bodyTerms";

interface LexicalFixture {
  organizationId: string;
  spaceId: string;
  vaultId: string;
  corpusRevision: string;
  documents: Record<LexicalCase, string>;
  units: Record<LexicalCase, string>;
  structuralParentId: string;
}

function lexicalFixture(): LexicalFixture {
  return {
    organizationId: randomUUID(),
    spaceId: randomUUID(),
    vaultId: randomUUID(),
    corpusRevision: `lexical-integration-${randomUUID()}`,
    documents: {
      externalId: randomUUID(),
      alias: randomUUID(),
      exactTitle: randomUUID(),
      path: randomUUID(),
      titleTerms: randomUUID(),
      headingTerms: randomUUID(),
      bodyTerms: randomUUID(),
    },
    units: {
      externalId: randomUUID(),
      alias: randomUUID(),
      exactTitle: randomUUID(),
      path: randomUUID(),
      titleTerms: randomUUID(),
      headingTerms: randomUUID(),
      bodyTerms: randomUUID(),
    },
    structuralParentId: randomUUID(),
  };
}

async function seedLexical(
  db: Postgres,
  fixture: LexicalFixture,
): Promise<void> {
  await db.pool.query(
    `insert into organizations(id,slug,name)
     values($1,$2,'Lexical ranking integration')`,
    [
      fixture.organizationId,
      `lexical-integration-${fixture.organizationId.slice(0, 8)}`,
    ],
  );
  await db.pool.query(
    `insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values($1,$2,$3,'Lexical ranking space','PRIVATE',$4)`,
    [
      fixture.spaceId,
      fixture.organizationId,
      `lexical-integration-${fixture.spaceId.slice(0, 8)}`,
      `C:/akp/lexical-ranking/${fixture.spaceId}`,
    ],
  );
  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,
       vault_key,local_path,visibility,enabled
     ) values($1,$2,$3,'Lexical ranking vault',true,$4,$5,$3,'PRIVATE',true)`,
    [
      fixture.vaultId,
      fixture.spaceId,
      `C:/akp/lexical-ranking/${fixture.vaultId}`,
      fixture.corpusRevision,
      `lexical-${fixture.vaultId.slice(0, 8)}`,
    ],
  );

  const documents: Array<{
    key: LexicalCase;
    externalId: string;
    aliases: string[];
    title: string;
    path: string;
    body: string;
  }> = [
    {
      key: "externalId",
      externalId: "RANKING",
      aliases: ["identity alias"],
      title: "Canonical identity",
      path: "docs/identity.md",
      body: "Canonical identity document.",
    },
    {
      key: "alias",
      externalId: "DOC-ALIAS",
      aliases: ["ranking"],
      title: "Alias candidate",
      path: "docs/alias.md",
      body: "Alias candidate document.",
    },
    {
      key: "exactTitle",
      externalId: "DOC-EXACT-TITLE",
      aliases: ["title candidate"],
      title: "Ranking",
      path: "docs/title.md",
      body: "Exact title candidate document.",
    },
    {
      key: "path",
      externalId: "DOC-PATH",
      aliases: ["path candidate"],
      title: "Path candidate",
      path: "topics/ranking.md",
      body: "Path candidate document.",
    },
    {
      key: "titleTerms",
      externalId: "DOC-TITLE-TERMS",
      aliases: ["title terms candidate"],
      title: "Ranking architecture",
      path: "docs/title-terms.md",
      body: "Title terms candidate document.",
    },
    {
      key: "headingTerms",
      externalId: "DOC-HEADING",
      aliases: ["heading candidate"],
      title: "Heading candidate",
      path: "docs/heading.md",
      body: "Heading candidate document.",
    },
    {
      key: "bodyTerms",
      externalId: "DOC-BODY",
      aliases: ["body candidate"],
      title: "Body candidate",
      path: "docs/body.md",
      body: "Body candidate document.",
    },
  ];

  for (const document of documents) {
    const documentId = fixture.documents[document.key];
    const contentHash = createHash("sha256")
      .update(document.body)
      .digest("hex");
    await db.pool.query(
      `insert into knowledge_documents(
         id,space_id,vault_id,path,external_id,aliases,title,type,lifecycle,
         trust_tier,current_revision,body_cache,frontmatter,layer,
         content_hash,token_estimate,raw_links
       ) values($1,$2,$3,$4,$5,$6,$7,'concept','ACTIVE','HUMAN_REVIEWED',
                $8,$9,$10::jsonb,'concept',$11,20,'[]'::jsonb)`,
      [
        documentId,
        fixture.spaceId,
        fixture.vaultId,
        document.path,
        document.externalId,
        document.aliases,
        document.title,
        fixture.corpusRevision,
        document.body,
        JSON.stringify({ id: document.externalId, title: document.title }),
        contentHash,
      ],
    );
  }

  const units: Array<{
    key: LexicalCase;
    headingPath: string[];
    body: string;
  }> = [
    {
      key: "alias",
      headingPath: ["Alias candidate"],
      body: "Alias unit content.",
    },
    {
      key: "exactTitle",
      headingPath: ["Exact title candidate"],
      body: "Exact title unit content.",
    },
    {
      key: "path",
      headingPath: ["Path candidate"],
      body: "Path unit content.",
    },
    {
      key: "titleTerms",
      headingPath: ["Title terms candidate"],
      body: "Title terms unit content.",
    },
    {
      key: "headingTerms",
      headingPath: ["Ranking heading", "Unit terms"],
      body: "Heading unit content.",
    },
    {
      key: "bodyTerms",
      headingPath: ["Body candidate"],
      body: "Ranking body evidence.",
    },
  ];
  for (const unit of units) {
    const unitHash = createHash("sha256").update(unit.body).digest("hex");
    await db.pool.query(
      `insert into knowledge_units(
         id,document_id,space_id,vault_id,unit_key,unit_type,heading_path,body,
         content_hash,corpus_revision,lifecycle,trust_tier,source_ids,
         token_estimate,parent_unit_id,document_revision,permissions,locator,
         structural_order,container_only,embedding_eligible
       ) values($1,$2,$3,$4,$5,'PARAGRAPH',$6,$7,$8,$9,'ACTIVE',
                'HUMAN_REVIEWED','{}',20,null,$9,'{}'::jsonb,'{}'::jsonb,
                $10,false,true)`,
      [
        fixture.units[unit.key],
        fixture.documents[unit.key],
        fixture.spaceId,
        fixture.vaultId,
        `${unit.key}-unit`,
        unit.headingPath,
        unit.body,
        unitHash,
        fixture.corpusRevision,
        units.indexOf(unit) + 1,
      ],
    );
  }

  const parentBody = "Parent structural context.";
  const childBody = "Canonical identity child content.";
  await db.pool.query(
    `insert into knowledge_units(
       id,document_id,space_id,vault_id,unit_key,unit_type,heading_path,body,
       content_hash,corpus_revision,lifecycle,trust_tier,source_ids,
       token_estimate,parent_unit_id,document_revision,permissions,locator,
       structural_order,container_only,embedding_eligible
     ) values($1,$2,$3,$4,'identity-parent','SECTION',$5,$6,$7,$8,'ACTIVE',
              'HUMAN_REVIEWED','{}',4,null,$8,'{}'::jsonb,'{}'::jsonb,0,true,false),
            ($9,$2,$3,$4,'identity-child','PARAGRAPH',$10,$11,$12,$8,'ACTIVE',
              'HUMAN_REVIEWED','{}',4,$1,$8,'{}'::jsonb,'{}'::jsonb,1,false,true)`,
    [
      fixture.structuralParentId,
      fixture.documents.externalId,
      fixture.spaceId,
      fixture.vaultId,
      ["Canonical identity", "Parent"],
      parentBody,
      createHash("sha256").update(parentBody).digest("hex"),
      fixture.corpusRevision,
      fixture.units.externalId,
      ["Canonical identity", "Child"],
      childBody,
      createHash("sha256").update(childBody).digest("hex"),
    ],
  );

  await db.pool.query(
    `insert into vault_index_revisions(
       space_id,vault_id,corpus_revision,lexical_revision,vector_revision,
       graph_revision,context_pack_revision,status,warnings
     ) values($1,$2,$3,$3,$3,$3,$3,'CONSISTENT','[]'::jsonb)`,
    [fixture.spaceId, fixture.vaultId, fixture.corpusRevision],
  );
}

async function cleanupLexical(
  db: Postgres,
  fixture: LexicalFixture,
): Promise<void> {
  await db.pool.query("delete from knowledge_units where vault_id=$1", [
    fixture.vaultId,
  ]);
  await db.pool.query("delete from knowledge_documents where vault_id=$1", [
    fixture.vaultId,
  ]);
  await db.pool.query("delete from vault_index_revisions where vault_id=$1", [
    fixture.vaultId,
  ]);
  await db.pool.query("delete from vaults where id=$1", [fixture.vaultId]);
  await db.pool.query("delete from spaces where id=$1", [fixture.spaceId]);
  await db.pool.query("delete from organizations where id=$1", [
    fixture.organizationId,
  ]);
}

function searchRequest(fixture: LexicalFixture): SearchRequest {
  return {
    query: "ranking",
    spaceId: fixture.spaceId,
    vaultId: fixture.vaultId,
    vaultIds: [],
    federated: false,
    types: [],
    minimumTrust: "MACHINE_SUPPORTED",
    mode: "SOURCE_BACKED",
    limit: 20,
  };
}

describe("production lexical ranking", () => {
  it.skipIf(!databaseUrl)(
    "orders field signals and preserves the matched unit context",
    async () => {
      if (!databaseUrl) return;
      const fixture = lexicalFixture();
      const db = new Postgres(databaseUrl);
      try {
        await seedLexical(db, fixture);
        const hits = await queryKnowledge(db, searchRequest(fixture), {
          channels: ["exact", "lexical"],
          plan: planQuery("ranking", {
            requestedIntent: "CONCEPTUAL",
            capabilities: {
              vectorAvailable: false,
              graphConsistent: false,
              rawAllowed: false,
              codeAdapterAvailable: false,
              contextPackAvailable: false,
            },
          }),
          vaultIds: [fixture.vaultId],
          deterministicRerank: false,
        });

        const expectedOrder: LexicalCase[] = [
          "externalId",
          "alias",
          "exactTitle",
          "path",
          "titleTerms",
          "headingTerms",
          "bodyTerms",
        ];
        expect(hits).toHaveLength(expectedOrder.length);
        expect(hits.map((hit) => hit.documentId)).toEqual(
          expectedOrder.map((key) => fixture.documents[key]),
        );
        expect(
          hits.every((hit) =>
            hit.reasons.some((reason) => reason.startsWith("lexical:")),
          ),
        ).toBe(true);

        const best = hits[0];
        expect(best).toMatchObject({
          documentId: fixture.documents.externalId,
          unitId: fixture.units.externalId,
          unitType: "PARAGRAPH",
          parentUnitId: fixture.structuralParentId,
          revision: fixture.corpusRevision,
        });

        expect(best?.parentUnitType).toBe("SECTION");
        expect(best?.headingPath).toEqual(["Canonical identity", "Child"]);
        expect(best?.document).toEqual({
          externalId: "RANKING",
          path: "docs/identity.md",
          title: "Canonical identity",
        });
      } finally {
        await cleanupLexical(db, fixture);
        await db.close();
      }
    },
  );
});
