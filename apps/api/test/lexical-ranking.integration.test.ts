import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type SearchRequest } from "@akp/contracts";
import { Postgres } from "@akp/postgres";
import { assessRetrievalAnswerability, planQuery } from "@akp/retrieval";
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
    "measures EN/ES answer-unit eviction at sibling depths 1, 2 and 4 on identical authorized PostgreSQL units",
    async () => {
      if (!databaseUrl) return;
      const metrics: Array<{
        language: string;
        depth: number;
        correctUnitPresent: boolean;
        wrongUnitCount: number;
        readerPoolHasCorrect: boolean;
      }> = [];
      for (const language of ["ES", "EN"] as const) {
        const fixture = lexicalFixture();
        const db = new Postgres(databaseUrl);
        try {
          await seedLexical(db, fixture);
          const es = language === "ES";
          const query = es
            ? "¿Quién aprobó la ampliación de acceso tras la auditoría?"
            : "Who approved the access expansion after the audit?";
          const approved = es
            ? "Lira aprobó la ampliación de acceso después de la auditoría."
            : "Lira approved the access expansion after the audit.";
          const denied = es
            ? "Lira NO aprobó la ampliación de acceso tras la auditoría."
            : "Lira did NOT approve the access expansion after the audit.";
          const wrongActor = es
            ? "Miro aprobó la ampliación de acceso tras la auditoría, no Lira."
            : "Miro approved the access expansion after the audit, not Lira.";
          const wrongDate = es
            ? "Lira aprobó la ampliación de acceso, pero ANTES de la auditoría."
            : "Lira approved the access expansion, but BEFORE the audit.";
          const originals = [
            { id: fixture.units.titleTerms, text: approved, kind: "CORRECT" },
            { id: randomUUID(), text: denied, kind: "NEGATION" },
            { id: randomUUID(), text: wrongActor, kind: "ACTOR" },
            { id: randomUUID(), text: wrongDate, kind: "TIME" },
          ];
          await db.pool.query(
            `update knowledge_documents
                set title='Technical notes',type='concept',
                    body_cache=$2,content_hash=$3
              where id=$1`,
            [
              fixture.documents.titleTerms,
              originals.map((item) => item.text).join("\n"),
              createHash("sha256")
                .update(originals.map((item) => item.text).join("\n"))
                .digest("hex"),
            ],
          );
          for (let index = 0; index < originals.length; index++) {
            const item = originals[index]!;
            const hash = createHash("sha256").update(item.text).digest("hex");
            const heading =
              index === 0
                ? ["Technical notes"]
                : es
                  ? ["Quién aprobó ampliación acceso auditoría"]
                  : ["Who approved access expansion after audit"];
            if (index === 0) {
              await db.pool.query(
                "update knowledge_units set heading_path=$2,body=$3,content_hash=$4 where id=$1",
                [item.id, heading, item.text, hash],
              );
            } else {
              await db.pool.query(
                `insert into knowledge_units(
                  id,document_id,space_id,vault_id,unit_key,unit_type,
                  heading_path,body,content_hash,corpus_revision,lifecycle,
                  trust_tier,source_ids,token_estimate,parent_unit_id,
                  document_revision,permissions,locator,structural_order,
                  container_only,embedding_eligible
                ) select $1,document_id,space_id,vault_id,$2,'PARAGRAPH',
                    $3,$4,$5,corpus_revision,lifecycle,trust_tier,
                    source_ids,24,parent_unit_id,document_revision,
                    permissions,locator,structural_order+$6,false,true
                  from knowledge_units where id=$7`,
                [
                  item.id,
                  item.kind,
                  heading,
                  item.text,
                  hash,
                  index * 100,
                  fixture.units.titleTerms,
                ],
              );
            }
          }
          for (const depth of [1, 2, 4] as const) {
            const poolIds: string[] = [];
            const hits = await queryKnowledge(
              db,
              {
                ...searchRequest(fixture),
                query,
                limit: 1,
              },
              {
                channels: ["lexical"],
                vaultIds: [fixture.vaultId],
                experimentalBoundedUnitLexicalRecall: true,
                experimentalBoundedUnitPerDocumentLimit: depth,
                answerabilityCandidateSink: (hits) =>
                  poolIds.push(...hits.map((hit) => hit.unitId ?? "")),
              },
            );
            const sourceHits = poolIds.filter((id) =>
              originals.some((item) => item.id === id),
            );
            metrics.push({
              language,
              depth,
              correctUnitPresent: sourceHits.includes(originals[0]!.id),
              wrongUnitCount: sourceHits.filter((id) => id !== originals[0]!.id)
                .length,
              readerPoolHasCorrect: sourceHits.includes(originals[0]!.id),
            });
            expect(sourceHits.length).toBeLessThanOrEqual(depth);
            // These results are candidates even when the HTTP presentation
            // limit is one. None becomes a SOURCE entailment verdict.
            expect(hits.length).toBeLessThanOrEqual(1);
          }
          const scoped = await queryKnowledge(
            db,
            { ...searchRequest(fixture), query },
            {
              channels: ["lexical"],
              vaultIds: [fixture.vaultId],
              experimentalBoundedUnitLexicalRecall: true,
              experimentalBoundedUnitPerDocumentLimit: 4,
              graphScopes: [
                { vaultId: fixture.vaultId, pathPrefix: "docs/body.md" },
              ],
              pathAuthorizer: (path) => path === "docs/body.md",
            },
          );
          expect(
            scoped.some(
              (hit) => hit.documentId === fixture.documents.titleTerms,
            ),
          ).toBe(false);
        } finally {
          await cleanupLexical(db, fixture);
          await db.close();
        }
      }
      console.log("S2_SIBLING_DEPTH_DEV_ONLY", JSON.stringify(metrics));
      for (const language of ["ES", "EN"]) {
        const rows = metrics.filter((row) => row.language === language);
        expect(rows.map((row) => row.depth)).toEqual([1, 2, 4]);
        // The source unit is intact, but 1/2 admit only higher-scoring
        // near-misses. Widening to four trades false candidates for recall.
        expect(rows[0]?.correctUnitPresent).toBe(false);
        expect(rows[1]?.correctUnitPresent).toBe(false);
        expect(rows[2]?.correctUnitPresent).toBe(true);
        expect(rows[2]?.wrongUnitCount).toBe(3);
      }
    },
  );

  it("rejects sibling-depth overrides without the internal experimental recall gate", async () => {
    const db = {
      pool: {
        query: () => {
          throw new Error("UNEXPECTED_DB_CALL");
        },
      },
    } as unknown as Postgres;
    const request = {
      ...searchRequest(lexicalFixture()),
      query: "Which source was approved?",
    };
    await expect(
      queryKnowledge(db, request, {
        channels: ["lexical"],
        experimentalBoundedUnitPerDocumentLimit: 4,
      }),
    ).rejects.toThrow("EXPERIMENTAL_BOUNDED_UNIT_DEPTH_INVALID");
    await expect(
      queryKnowledge(db, request, {
        channels: ["lexical"],
        experimentalBoundedUnitLexicalRecall: true,
        experimentalBoundedUnitPerDocumentLimit: 3 as 4,
      }),
    ).rejects.toThrow("EXPERIMENTAL_BOUNDED_UNIT_DEPTH_INVALID");
  });

  it.skipIf(!databaseUrl)(
    "retains an answer-bearing sibling SOURCE unit even when a negated sibling has stronger lexical overlap",
    async () => {
      if (!databaseUrl) return;
      const fixture = lexicalFixture();
      const db = new Postgres(databaseUrl);
      try {
        await seedLexical(db, fixture);
        const good =
          "Lira aprobó la ampliación de acceso después de la auditoría.";
        const wrong =
          "Lira NO aprobó la ampliación de acceso después de la auditoría. " +
          "La ampliación de acceso quedó pendiente después de la auditoría.";
        const goodHash = createHash("sha256").update(good).digest("hex");
        const badHash = createHash("sha256").update(wrong).digest("hex");
        const siblingId = randomUUID();
        await db.pool.query(
          `update knowledge_documents
              set type='concept',title='Technical notes',
                  body_cache=$2,content_hash=$3
            where id=$1`,
          [fixture.documents.titleTerms, good + "\n" + wrong, goodHash],
        );
        await db.pool.query(
          `update knowledge_units
              set heading_path=ARRAY['Technical notes'],body=$2,content_hash=$3
            where id=$1`,
          [fixture.units.titleTerms, good, goodHash],
        );
        await db.pool.query(
          `insert into knowledge_units(
              id,document_id,space_id,vault_id,unit_key,unit_type,
              heading_path,body,content_hash,corpus_revision,lifecycle,
              trust_tier,source_ids,token_estimate,parent_unit_id,
              document_revision,permissions,locator,structural_order,
              container_only,embedding_eligible
            ) select $1,document_id,space_id,vault_id,'negated-sibling',
                'PARAGRAPH',ARRAY['Ampliación acceso auditoría'],$2,$3,
                corpus_revision,lifecycle,trust_tier,source_ids,24,
                parent_unit_id,document_revision,permissions,locator,
                structural_order+100,false,true
              from knowledge_units where id=$4`,
          [siblingId, wrong, badHash, fixture.units.titleTerms],
        );
        const request = {
          ...searchRequest(fixture),
          query: "¿Quién aprobó la ampliación de acceso tras la auditoría?",
        };
        const options = {
          channels: ["lexical"] as const,
          vaultIds: [fixture.vaultId],
          experimentalBoundedUnitLexicalRecall: true,
        };
        const ordinary = await queryKnowledge(db, request, {
          channels: ["lexical"] as const,
          vaultIds: [fixture.vaultId],
        });
        expect(
          ordinary.some(
            (hit) =>
              hit.unitId === fixture.units.titleTerms ||
              hit.unitId === siblingId,
          ),
        ).toBe(false);
        const hits = await queryKnowledge(db, request, options);
        const siblings = hits.filter(
          (hit) => hit.documentId === fixture.documents.titleTerms,
        );
        expect(siblings.some((hit) => hit.unitId === siblingId)).toBe(true);
        // RED before the repair: a one-unit-per-document LATERAL chooses only
        // the higher-scoring negative and drops this correct original unit.
        expect(
          siblings.some((hit) => hit.unitId === fixture.units.titleTerms),
        ).toBe(true);
        // Both are *retrieval candidates*, not certified semantic answers.
        expect(
          siblings.every((hit) =>
            hit.reasons.some((reason) =>
              reason.includes("lexical:bounded-unit-recall:"),
            ),
          ),
        ).toBe(true);
        const scoped = await queryKnowledge(db, request, {
          ...options,
          graphScopes: [
            { vaultId: fixture.vaultId, pathPrefix: "docs/body.md" },
          ],
          pathAuthorizer: (path) => path === "docs/body.md",
        });
        expect(
          scoped.some((hit) => hit.documentId === fixture.documents.titleTerms),
        ).toBe(false);
        // The public response limit is not the Reader/answerability pool.
        const readerCandidates: string[] = [];
        await queryKnowledge(
          db,
          { ...request, limit: 1 },
          {
            ...options,
            answerabilityCandidateSink: (pool) => {
              readerCandidates.push(...pool.map((hit) => hit.unitId ?? ""));
            },
          },
        );
        expect(readerCandidates).toContain(fixture.units.titleTerms);
        expect(readerCandidates).toContain(siblingId);
      } finally {
        await cleanupLexical(db, fixture);
        await db.close();
      }
    },
  );

  it.skipIf(!databaseUrl)(
    "recovers the original answer-bearing unit for an ordinary ES Markdown question only with bounded unit recall",
    async () => {
      if (!databaseUrl) return;
      const fixture = lexicalFixture();
      const db = new Postgres(databaseUrl);
      try {
        await seedLexical(db, fixture);
        const positive =
          "Lira aprobó la ampliación de acceso después de la auditoría.";
        const negative =
          "Lira no aprobó la ampliación de acceso después de la auditoría.";
        const generic =
          "La auditoría revisó la ampliación de acceso y presentó un informe.";
        const replacements = [
          {
            doc: fixture.documents.titleTerms,
            unit: fixture.units.titleTerms,
            text: positive,
          },
          {
            doc: fixture.documents.bodyTerms,
            unit: fixture.units.bodyTerms,
            text: negative,
          },
          {
            doc: fixture.documents.alias,
            unit: fixture.units.alias,
            text: generic,
          },
        ];
        for (const item of replacements) {
          const hash = createHash("sha256").update(item.text).digest("hex");
          await db.pool.query(
            "update knowledge_documents set title='Technical notes',body_cache=$2,content_hash=$3,type='concept' where id=$1",
            [item.doc, item.text, hash],
          );
          await db.pool.query(
            "update knowledge_units set heading_path=ARRAY['Technical notes'],body=$2,content_hash=$3 where id=$1",
            [item.unit, item.text, hash],
          );
        }
        const query =
          "¿Quién aprobó la ampliación de acceso tras la auditoría?";
        // Two terms in different original units must not be interpreted as
        // co-occurring in one answer-bearing passage.
        const separated = "ampliación auditoría";
        await db.pool.query(
          "update knowledge_documents set title='Separate terms',body_cache=$2,content_hash=$3 where id=$1",
          [
            fixture.documents.externalId,
            separated,
            createHash("sha256").update(separated).digest("hex"),
          ],
        );
        for (const item of [
          { id: fixture.structuralParentId, body: "ampliación" },
          { id: fixture.units.externalId, body: "auditoría" },
        ]) {
          await db.pool.query(
            "update knowledge_units set heading_path=ARRAY['Separate'],body=$2,content_hash=$3 where id=$1",
            [
              item.id,
              item.body,
              createHash("sha256").update(item.body).digest("hex"),
            ],
          );
        }
        const request = { ...searchRequest(fixture), query };
        const options = {
          channels: ["lexical"] as const,
          vaultIds: [fixture.vaultId],
        };
        const strict = await queryKnowledge(db, request, options);
        expect(
          strict.some((hit) => hit.unitId === fixture.units.titleTerms),
        ).toBe(false);
        const relaxed = await queryKnowledge(db, request, {
          ...options,
          experimentalBoundedUnitLexicalRecall: true,
        });
        expect(
          relaxed.some((hit) => hit.unitId === fixture.units.titleTerms),
        ).toBe(true);
        expect(
          relaxed.some((hit) => hit.unitId === fixture.units.bodyTerms),
        ).toBe(true);
        expect(relaxed.some((hit) => hit.unitId === fixture.units.alias)).toBe(
          true,
        );
        expect(
          relaxed.some(
            (hit) => hit.documentId === fixture.documents.externalId,
          ),
        ).toBe(false);
        const positiveHit = relaxed.find(
          (hit) => hit.unitId === fixture.units.titleTerms,
        );
        expect(positiveHit?.excerpt).toContain("Lira aprobó");
        expect(
          positiveHit?.reasons.some((reason) =>
            reason.includes("lexical:bounded-unit-recall:"),
          ),
        ).toBe(true);
        const restricted = await queryKnowledge(db, request, {
          ...options,
          experimentalBoundedUnitLexicalRecall: true,
          graphScopes: [
            { vaultId: fixture.vaultId, pathPrefix: "docs/title-terms.md" },
          ],
          pathAuthorizer: (path) => path === "docs/title-terms.md",
        });
        expect(restricted.map((hit) => hit.documentId)).toEqual([
          fixture.documents.titleTerms,
        ]);
        // Same physical unit identifiers and revision; swap only the
        // fixture language to verify that this mechanism is not ES-specific.
        const english = [
          {
            doc: fixture.documents.titleTerms,
            unit: fixture.units.titleTerms,
            text: "Lira approved the access expansion following the audit.",
          },
          {
            doc: fixture.documents.bodyTerms,
            unit: fixture.units.bodyTerms,
            text: "Lira did not approve the access expansion after the audit.",
          },
        ];
        for (const item of english) {
          const hash = createHash("sha256").update(item.text).digest("hex");
          await db.pool.query(
            "update knowledge_documents set body_cache=$2,content_hash=$3 where id=$1",
            [item.doc, item.text, hash],
          );
          await db.pool.query(
            "update knowledge_units set body=$2,content_hash=$3 where id=$1",
            [item.unit, item.text, hash],
          );
        }
        const englishQuery =
          "Who approved the access expansion after the audit?";
        const englishStrict = await queryKnowledge(
          db,
          { ...request, query: englishQuery },
          options,
        );
        expect(
          englishStrict.some((hit) => hit.unitId === fixture.units.titleTerms),
        ).toBe(false);
        const englishRelaxed = await queryKnowledge(
          db,
          { ...request, query: englishQuery },
          { ...options, experimentalBoundedUnitLexicalRecall: true },
        );
        expect(
          englishRelaxed.some((hit) => hit.unitId === fixture.units.titleTerms),
        ).toBe(true);
        // A disjoint technical domain uses the exact same generic grammar,
        // not an added term alias or a special-case question template.
        const observatory = [
          {
            doc: fixture.documents.titleTerms,
            unit: fixture.units.titleTerms,
            text: "Vela calibrated the telescope after sunrise.",
          },
          {
            doc: fixture.documents.bodyTerms,
            unit: fixture.units.bodyTerms,
            text: "Vela did not calibrate the telescope after sunrise.",
          },
        ];
        for (const item of observatory) {
          const hash = createHash("sha256").update(item.text).digest("hex");
          await db.pool.query(
            "update knowledge_documents set body_cache=$2,content_hash=$3 where id=$1",
            [item.doc, item.text, hash],
          );
          await db.pool.query(
            "update knowledge_units set body=$2,content_hash=$3 where id=$1",
            [item.unit, item.text, hash],
          );
        }
        const observatoryQuery =
          "Who calibrated the telescope during night operations?";
        const ordinaryObservatory = await queryKnowledge(
          db,
          { ...request, query: observatoryQuery },
          options,
        );
        expect(
          ordinaryObservatory.some(
            (hit) => hit.unitId === fixture.units.titleTerms,
          ),
        ).toBe(false);
        const relaxedObservatory = await queryKnowledge(
          db,
          { ...request, query: observatoryQuery },
          { ...options, experimentalBoundedUnitLexicalRecall: true },
        );
        expect(
          relaxedObservatory.some(
            (hit) => hit.unitId === fixture.units.titleTerms,
          ),
        ).toBe(true);
      } finally {
        await cleanupLexical(db, fixture);
        await db.close();
      }
    },
  );

  it.skipIf(!databaseUrl)(
    "recovers a scoped canonical document from an explicit question acronym",
    async () => {
      if (!databaseUrl) return;
      const fixture = lexicalFixture();
      const db = new Postgres(databaseUrl);
      try {
        await seedLexical(db, fixture);
        await db.pool.query(
          "update knowledge_documents set external_id='CON-SRP' where id=$1",
          [fixture.documents.titleTerms],
        );
        const hits = await queryKnowledge(
          db,
          {
            ...searchRequest(fixture),
            query: "principio de responsabilidad única SRP",
          },
          { channels: ["exact", "lexical"], vaultIds: [fixture.vaultId] },
        );
        expect(hits[0]?.documentId).toBe(fixture.documents.titleTerms);
        expect(hits[0]?.reasons).toContain("exact:query-acronym");

        const plainAcronym = await queryKnowledge(
          db,
          { ...searchRequest(fixture), query: "SRP" },
          { channels: ["exact", "lexical"], vaultIds: [fixture.vaultId] },
        );
        expect(
          plainAcronym.every(
            (hit) => !hit.reasons.includes("exact:query-acronym"),
          ),
        ).toBe(true);
      } finally {
        await cleanupLexical(db, fixture);
        await db.pool.end();
      }
    },
  );
  it.skipIf(!databaseUrl)(
    "does not treat an ambiguous question acronym as an exact document locator",
    async () => {
      if (!databaseUrl) return;
      const fixture = lexicalFixture();
      const db = new Postgres(databaseUrl);
      try {
        await seedLexical(db, fixture);
        await db.pool.query(
          `update knowledge_documents
              set external_id=case id when $1 then 'CLM-OPTIONAL-CQRS'
                                      else 'CLM-PATTERN-CQRS' end
            where id in ($1,$2)`,
          [fixture.documents.titleTerms, fixture.documents.bodyTerms],
        );
        const hits = await queryKnowledge(
          db,
          { ...searchRequest(fixture), query: "Can CQRS share a database?" },
          { channels: ["exact", "lexical"], vaultIds: [fixture.vaultId] },
        );
        expect(
          hits.every((hit) => !hit.reasons.includes("exact:query-acronym")),
        ).toBe(true);
        const scoped = await queryKnowledge(
          db,
          { ...searchRequest(fixture), query: "Can CQRS share a database?" },
          {
            channels: ["exact", "lexical"],
            vaultIds: [fixture.vaultId],
            graphScopes: [
              { vaultId: fixture.vaultId, pathPrefix: "docs/title-terms.md" },
            ],
            graphScopes: [
              { vaultId: fixture.vaultId, pathPrefix: "docs/title-terms.md" },
            ],
            pathAuthorizer: (path) => path === "docs/title-terms.md",
          },
        );
        expect(scoped[0]?.documentId).toBe(fixture.documents.titleTerms);
        expect(scoped[0]?.reasons).toContain("exact:query-acronym");
      } finally {
        await cleanupLexical(db, fixture);
        await db.pool.end();
      }
    },
  );
  it.skipIf(!databaseUrl)(
    "includes drafts only on request and keeps lexical search independent of vector eligibility",
    async () => {
      if (!databaseUrl) return;
      const fixture = lexicalFixture();
      const db = new Postgres(databaseUrl);
      try {
        await seedLexical(db, fixture);
        await db.pool.query(
          "update knowledge_documents set lifecycle='DRAFT' where id=$1",
          [fixture.documents.bodyTerms],
        );
        await db.pool.query(
          "update knowledge_units set lifecycle='DRAFT',embedding_eligible=false where id=$1",
          [fixture.units.bodyTerms],
        );
        const options = {
          channels: ["lexical"] as const,
          vaultIds: [fixture.vaultId],
          deterministicRerank: false,
        };
        const normal = await queryKnowledge(
          db,
          { ...searchRequest(fixture), query: "evidence" },
          options,
        );
        expect(
          normal.some((hit) => hit.documentId === fixture.documents.bodyTerms),
        ).toBe(false);
        const drafts = await queryKnowledge(
          db,
          {
            ...searchRequest(fixture),
            query: "evidence",
            mode: "DRAFT_INCLUDED",
          },
          options,
        );
        expect(
          drafts.some((hit) => hit.documentId === fixture.documents.bodyTerms),
        ).toBe(true);

        await db.pool.query(
          "update knowledge_documents set lifecycle='ACTIVE' where id=$1",
          [fixture.documents.bodyTerms],
        );
        await db.pool.query(
          "update knowledge_units set lifecycle='ACTIVE' where id=$1",
          [fixture.units.bodyTerms],
        );
        const nonVectorUnit = await queryKnowledge(
          db,
          { ...searchRequest(fixture), query: "evidence" },
          options,
        );
        expect(
          nonVectorUnit.some((hit) => hit.unitId === fixture.units.bodyTerms),
        ).toBe(true);
      } finally {
        await cleanupLexical(db, fixture);
        await db.pool.end();
      }
    },
  );

  it.skipIf(!databaseUrl)(
    "orders field signals and preserves the matched unit context",
    async () => {
      if (!databaseUrl) return;
      const fixture = lexicalFixture();
      const db = new Postgres(databaseUrl);
      try {
        await seedLexical(db, fixture);
        await db.pool.query(
          `update knowledge_documents
              set refresh_status='STALE_PENDING_REVIEW'
            where id=$1`,
          [fixture.documents.externalId],
        );
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
          refreshStatus: "STALE_PENDING_REVIEW",
        });
        expect(best?.warnings).toContain("STALE_PENDING_REVIEW");

        expect(best?.parentUnitType).toBe("SECTION");
        expect(best?.headingPath).toEqual(["Canonical identity", "Child"]);
        expect(best?.document).toEqual({
          externalId: "RANKING",
          path: "docs/identity.md",
          title: "Canonical identity",
          aliases: ["identity alias"],
        });

        const reranked = await queryKnowledge(db, searchRequest(fixture), {
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
          retrievalPolicy: {
            reranker: "deterministic-lexical-v1",
          },
        });
        expect(reranked).toHaveLength(expectedOrder.length);
        expect(
          reranked.every(
            (hit, index) =>
              hit.rerankTrace?.reranker === "deterministic-lexical-v1" &&
              hit.rerankTrace.postRank === index + 1 &&
              hit.rerankTrace.preRank >= 1,
          ),
        ).toBe(true);
        expect(
          new Set(reranked.map((hit) => hit.rerankTrace?.preRank)).size,
        ).toBe(reranked.length);
        const originalById = new Map(
          hits.map((hit) => [
            hit.documentId,
            {
              trust: hit.trust,
              lifecycle: hit.lifecycle,
              citations: hit.citations,
              warnings: hit.warnings,
              revision: hit.revision,
              document: hit.document,
            },
          ]),
        );
        for (const hit of reranked) {
          expect({
            trust: hit.trust,
            lifecycle: hit.lifecycle,
            citations: hit.citations,
            warnings: hit.warnings,
            revision: hit.revision,
            document: hit.document,
          }).toEqual(originalById.get(hit.documentId));
        }
      } finally {
        await cleanupLexical(db, fixture);
        await db.close();
      }
    },
  );
});

describe("structured TABLE_ROW lexical context", () => {
  it.skipIf(!databaseUrl)(
    "keeps canonical row bodies unchanged while opt-in context selects the matching row",
    async () => {
      if (!databaseUrl) return;
      const fixture = lexicalFixture();
      const db = new Postgres(databaseUrl);
      const secondRowId = randomUUID();
      try {
        await seedLexical(db, fixture);
        const documentId = fixture.documents.bodyTerms;
        const firstRowId = fixture.units.bodyTerms;
        const rowBody = "| API | Mira Chen | SlotA |";
        const documentBody = [
          "Blue release matrix",
          "Green release matrix",
          "Component API Owner Mira Chen Slot SlotA",
        ].join("\n");
        const rowHash = createHash("sha256").update(rowBody).digest("hex");
        const documentHash = createHash("sha256")
          .update(documentBody)
          .digest("hex");
        await db.pool.query(
          `update knowledge_documents
              set title='Release matrices',body_cache=$2,content_hash=$3
            where id=$1`,
          [documentId, documentBody, documentHash],
        );
        await db.pool.query(
          `update knowledge_units
              set unit_type='TABLE_ROW',heading_path=$2,body=$3,content_hash=$4,
                  structural_order=1,lexical_context=$5
            where id=$1`,
          [
            firstRowId,
            ["Release matrices", "Table columns: Component | Owner | Slot"],
            rowBody,
            rowHash,
            [
              "Release matrices",
              "Blue release matrix",
              "Component = API",
              "Owner = Mira Chen",
              "Slot = SlotA",
            ].join("\n"),
          ],
        );
        await db.pool.query(
          `insert into knowledge_units(
             id,document_id,space_id,vault_id,unit_key,unit_type,heading_path,body,
             content_hash,corpus_revision,lifecycle,trust_tier,source_ids,
             token_estimate,parent_unit_id,document_revision,permissions,locator,
             structural_order,container_only,embedding_eligible,lexical_context
           ) values($1,$2,$3,$4,'structured-row-two','TABLE_ROW',$5,$6,$7,$8,
                    'ACTIVE','HUMAN_REVIEWED','{}',8,null,$8,'{}'::jsonb,
                    '{}'::jsonb,2,false,true,$9)`,
          [
            secondRowId,
            documentId,
            fixture.spaceId,
            fixture.vaultId,
            ["Release matrices", "Table columns: Component | Owner | Slot"],
            rowBody,
            rowHash,
            fixture.corpusRevision,
            [
              "Release matrices",
              "Green release matrix",
              "Component = API",
              "Owner = Mira Chen",
              "Slot = SlotA",
            ].join("\n"),
          ],
        );

        const query =
          "Green release matrix Component API Owner Mira Chen Slot SlotA";
        const request = { ...searchRequest(fixture), query, limit: 5 };
        const sharedOptions = {
          channels: ["lexical"] as const,
          vaultIds: [fixture.vaultId],
          deterministicRerank: false,
        };

        const baseline = await queryKnowledge(db, request, sharedOptions);
        expect(baseline[0]?.documentId).toBe(documentId);
        expect(baseline[0]?.unitId).toBe(firstRowId);

        const candidate = await queryKnowledge(db, request, {
          ...sharedOptions,
          experimentalStructuredRowLexicalContext: true,
        });
        expect(candidate[0]?.documentId).toBe(documentId);
        expect(candidate[0]?.unitId).toBe(secondRowId);
        expect(candidate[0]?.reasons).toContain(
          "lexical:structured-context-terms",
        );

        const stored = await db.pool.query<{
          id: string;
          body: string;
          lexical_context: string;
          augmented_match: boolean;
        }>(
          `select id,body,lexical_context,
                  lexical_augmented_search_vector @@ plainto_tsquery('simple',$2)
                    augmented_match
             from knowledge_units
            where id=any($1::uuid[])
            order by structural_order`,
          [[firstRowId, secondRowId], query],
        );
        expect(stored.rows.map((row) => row.body)).toEqual([rowBody, rowBody]);
        expect(stored.rows[0]?.lexical_context).toContain(
          "Blue release matrix",
        );
        expect(stored.rows[1]?.lexical_context).toContain(
          "Green release matrix",
        );
        expect(stored.rows[0]?.augmented_match).toBe(false);
        expect(stored.rows[1]?.augmented_match).toBe(true);
      } finally {
        await cleanupLexical(db, fixture);
        await db.close();
      }
    },
  );
});

describe("atomic lexical selection and indexed lexemes", () => {
  it.skipIf(!databaseUrl)(
    "keeps a matching leaf when its container ranks higher",
    async () => {
      if (!databaseUrl) return;
      const fixture = lexicalFixture();
      const db = new Postgres(databaseUrl);
      try {
        await seedLexical(db, fixture);
        for (const [id, body] of [
          [fixture.structuralParentId, "Ranking ".repeat(50)],
          [fixture.units.externalId, "Ranking approved atomic answer."],
        ] as const) {
          await db.pool.query(
            "update knowledge_units set body=$2,content_hash=$3 where id=$1",
            [id, body, createHash("sha256").update(body).digest("hex")],
          );
        }
        const hits = await queryKnowledge(db, searchRequest(fixture), {
          channels: ["lexical"],
          vaultIds: [fixture.vaultId],
          graphScopes: [
            { vaultId: fixture.vaultId, pathPrefix: "docs/identity.md" },
          ],
          pathAuthorizer: (path) => path === "docs/identity.md",
        });
        expect(hits[0]?.unitId).toBe(fixture.units.externalId);
        expect(hits[0]?.unitType).not.toBe("SECTION");
        expect(hits[0]?.excerpt).toContain("approved atomic answer");
      } finally {
        await cleanupLexical(db, fixture);
        await db.close();
      }
    },
  );

  it.skipIf(!databaseUrl)(
    "matches accented Spanish terms through assertion recall",
    async () => {
      if (!databaseUrl) return;
      const fixture = lexicalFixture();
      const db = new Postgres(databaseUrl);
      try {
        await seedLexical(db, fixture);
        const body = "La nómina pública se registra en el sistema autorizado.";
        const hash = createHash("sha256").update(body).digest("hex");
        await db.pool.query(
          "update knowledge_documents set type='claim',title='Nómina pública',body_cache=$2,content_hash=$3 where id=$1",
          [fixture.documents.titleTerms, body, hash],
        );
        await db.pool.query(
          "update knowledge_units set heading_path=$2,body=$3,content_hash=$4 where id=$1",
          [fixture.units.titleTerms, ["Nómina pública"], body, hash],
        );
        const hits = await queryKnowledge(
          db,
          {
            ...searchRequest(fixture),
            query: "¿Cómo se registra la nómina pública?",
          },
          {
            channels: ["lexical"],
            vaultIds: [fixture.vaultId],
            graphScopes: [
              { vaultId: fixture.vaultId, pathPrefix: "docs/title-terms.md" },
            ],
            pathAuthorizer: (path) => path === "docs/title-terms.md",
          },
        );
        expect(hits[0]?.documentId).toBe(fixture.documents.titleTerms);
        expect(hits[0]?.unitId).toBe(fixture.units.titleTerms);
        expect(
          hits[0]?.reasons.some((reason) =>
            reason.includes("assertion-recall"),
          ),
        ).toBe(true);
      } finally {
        await cleanupLexical(db, fixture);
        await db.close();
      }
    },
  );
});

describe("bounded assertion recall", () => {
  it.skipIf(!databaseUrl)(
    "recovers a direct approved claim without admitting a same-topic wrong relation",
    async () => {
      if (!databaseUrl) return;
      const fixture = lexicalFixture();
      const db = new Postgres(databaseUrl);
      try {
        await seedLexical(db, fixture);
        const updates = [
          {
            documentId: fixture.documents.titleTerms,
            unitId: fixture.units.titleTerms,
            externalId: "CLM-BLUE-WIDGET-STORAGE",
            title: "Blue widget requires a storage engine",
            body: "A blue widget requires a storage engine to keep its state.",
            type: "claim",
          },
          {
            documentId: fixture.documents.bodyTerms,
            unitId: fixture.units.bodyTerms,
            externalId: "RUL-BLUE-WIDGET-QUEUE",
            title: "Blue widget requires a transport queue",
            body: "A blue widget requires a transport queue for delivery.",
            type: "decision-rule",
          },
          {
            documentId: fixture.documents.alias,
            unitId: fixture.units.alias,
            externalId: "PRO-BLUE-WIDGET",
            title: "Blue widget storage engine practice guide",
            body: "In practice, a blue widget deployment guide uses a storage engine. The guide does not require the widget itself.",
            type: "profile",
          },
        ] as const;
        for (const item of updates) {
          const hash = createHash("sha256").update(item.body).digest("hex");
          await db.pool.query(
            `update knowledge_documents
                set external_id=$2,title=$3,body_cache=$4,type=$5,
                    content_hash=$6
              where id=$1`,
            [
              item.documentId,
              item.externalId,
              item.title,
              item.body,
              item.type,
              hash,
            ],
          );
          await db.pool.query(
            `update knowledge_units
                set heading_path=$2,body=$3,content_hash=$4
              where id=$1`,
            [item.unitId, [item.title], item.body, hash],
          );
        }
        const query =
          "Does a blue widget require a storage engine in practice?";
        const hits = await queryKnowledge(
          db,
          { ...searchRequest(fixture), query },
          { channels: ["lexical"], vaultIds: [fixture.vaultId] },
        );
        expect(
          hits.some((hit) => hit.documentId === fixture.documents.titleTerms),
        ).toBe(true);
        expect(
          hits.some((hit) => hit.documentId === fixture.documents.alias),
        ).toBe(true);
        expect(
          hits
            .find((hit) => hit.documentId === fixture.documents.alias)
            ?.reasons.some((reason) =>
              reason.includes("lexical:assertion-recall:"),
            ),
        ).toBe(false);
        expect(
          hits
            .find((hit) => hit.documentId === fixture.documents.titleTerms)
            ?.reasons.some((reason) =>
              reason.includes("lexical:assertion-recall:"),
            ),
        ).toBe(true);
        const answerability = assessRetrievalAnswerability(hits, query);
        const accepted = answerability.candidateSignals
          .filter((signal) => signal.passageSupport.supported)
          .map((signal) => signal.externalId);
        expect(
          hits.some((hit) => hit.documentId === fixture.documents.bodyTerms),
        ).toBe(true);
        expect(accepted).toContain("CLM-BLUE-WIDGET-STORAGE");
        expect(accepted).not.toContain("RUL-BLUE-WIDGET-QUEUE");
        expect(accepted).not.toContain("PRO-BLUE-WIDGET");
      } finally {
        await cleanupLexical(db, fixture);
        await db.close();
      }
    },
  );
});
