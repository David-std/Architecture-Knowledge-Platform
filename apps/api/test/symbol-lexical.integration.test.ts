import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type SearchRequest } from "@akp/contracts";
import { Postgres } from "@akp/postgres";
import { planQuery } from "@akp/retrieval";
import { queryKnowledge } from "../src/routes/search.js";

const databaseUrl = process.env.DATABASE_URL;

interface SymbolFixture {
  organizationId: string;
  spaceId: string;
  vaultId: string;
  corpusRevision: string;
  documents: Record<string, string>;
}

function fixture(): SymbolFixture {
  return {
    organizationId: randomUUID(),
    spaceId: randomUUID(),
    vaultId: randomUUID(),
    corpusRevision: `symbol-lexical-${randomUUID()}`,
    documents: {
      camel: randomUUID(),
      snake: randomUUID(),
      qualified: randomUUID(),
      path: randomUUID(),
      adr: randomUUID(),
      uuid: randomUUID(),
      mixed: randomUUID(),
    },
  };
}

async function seed(db: Postgres, value: SymbolFixture): Promise<void> {
  await db.pool.query(
    `insert into organizations(id,slug,name)
     values($1,$2,'Symbol lexical integration')`,
    [value.organizationId, `symbol-${value.organizationId.slice(0, 8)}`],
  );
  await db.pool.query(
    `insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values($1,$2,$3,'Symbol lexical space','PRIVATE',$4)`,
    [
      value.spaceId,
      value.organizationId,
      `symbol-${value.spaceId.slice(0, 8)}`,
      `C:/akp/symbol-lexical/${value.spaceId}`,
    ],
  );
  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,
       vault_key,local_path,visibility,enabled
     ) values($1,$2,$3,'Symbol lexical vault',true,$4,$5,$3,'PRIVATE',true)`,
    [
      value.vaultId,
      value.spaceId,
      `C:/akp/symbol-lexical/${value.vaultId}`,
      value.corpusRevision,
      `symbol-${value.vaultId.slice(0, 8)}`,
    ],
  );

  const rows = [
    {
      key: "camel",
      externalId: "DOC-CAMEL",
      aliases: [],
      title: "Camel symbol",
      path: "docs/camel.md",
      body: "The InvoicePaymentService owns settlement orchestration.",
    },
    {
      key: "snake",
      externalId: "DOC-SNAKE",
      aliases: ["refund_processor_queue"],
      title: "Snake symbol",
      path: "docs/snake.md",
      body: "Queue ownership reference.",
    },
    {
      key: "qualified",
      externalId: "DOC-QUALIFIED",
      aliases: [],
      title: "Billing.Core.InvoiceGateway",
      path: "docs/qualified.md",
      body: "Qualified namespace reference.",
    },
    {
      key: "path",
      externalId: "DOC-PATH-SYMBOL",
      aliases: [],
      title: "Path symbol",
      path: "src/security/JwtTokenStore.ts",
      body: "Source path reference.",
    },
    {
      key: "adr",
      externalId: "ADR-042-session-hardening",
      aliases: [],
      title: "Session hardening decision",
      path: "adr/042-session-hardening.md",
      body: "Architecture decision record.",
    },
    {
      key: "uuid",
      externalId: "7a907d4c-2b4c-4f2c-b441-c4f2edb3ef64",
      aliases: [],
      title: "UUID identity",
      path: "docs/uuid.md",
      body: "Stable UUID identity reference.",
    },
    {
      key: "mixed",
      externalId: "DOC-MIXED",
      aliases: [],
      title: "Validación bilingüe",
      path: "docs/mixed.md",
      body: "Validación del PaymentGateway para conciliación empresarial.",
    },
  ] as const;

  for (const row of rows) {
    const bodyHash = createHash("sha256").update(row.body).digest("hex");
    await db.pool.query(
      `insert into knowledge_documents(
         id,space_id,vault_id,path,external_id,aliases,title,type,lifecycle,
         trust_tier,current_revision,body_cache,frontmatter,layer,
         content_hash,token_estimate,raw_links
       ) values($1,$2,$3,$4,$5,$6,$7,'concept','ACTIVE','HUMAN_REVIEWED',
                $8,$9,$10::jsonb,'concept',$11,20,'[]'::jsonb)`,
      [
        value.documents[row.key],
        value.spaceId,
        value.vaultId,
        row.path,
        row.externalId,
        [...row.aliases],
        row.title,
        value.corpusRevision,
        row.body,
        JSON.stringify({ id: row.externalId, title: row.title }),
        bodyHash,
      ],
    );
  }

  await db.pool.query(
    `insert into vault_index_revisions(
       space_id,vault_id,corpus_revision,lexical_revision,status,warnings
     ) values($1,$2,$3,$3,'CONSISTENT','[]'::jsonb)`,
    [value.spaceId, value.vaultId, value.corpusRevision],
  );
}

async function cleanup(db: Postgres, value: SymbolFixture): Promise<void> {
  await db.pool.query("delete from knowledge_documents where vault_id=$1", [
    value.vaultId,
  ]);
  await db.pool.query("delete from vault_index_revisions where vault_id=$1", [
    value.vaultId,
  ]);
  await db.pool.query("delete from vaults where id=$1", [value.vaultId]);
  await db.pool.query("delete from spaces where id=$1", [value.spaceId]);
  await db.pool.query("delete from organizations where id=$1", [
    value.organizationId,
  ]);
}

function request(value: SymbolFixture, query: string): SearchRequest {
  return {
    query,
    spaceId: value.spaceId,
    vaultId: value.vaultId,
    vaultIds: [],
    federated: false,
    types: [],
    minimumTrust: "MACHINE_SUPPORTED",
    mode: "SOURCE_BACKED",
    limit: 10,
  };
}

const capabilities = {
  vectorAvailable: false,
  graphConsistent: false,
  rawAllowed: false,
  codeAdapterAvailable: false,
  contextPackAvailable: false,
};

describe("symbol-aware lexical retrieval", () => {
  it.skipIf(!databaseUrl)(
    "retrieves code/project identifiers without replacing exact or simple lexical search",
    async () => {
      if (!databaseUrl) return;
      const value = fixture();
      const db = new Postgres(databaseUrl);
      try {
        await seed(db, value);

        const snakeSymbolProjection = await db.pool.query<{ matches: boolean }>(
          `select lexical_symbol_vector @@
                    plainto_tsquery('simple', akp_lexical_symbol_text($2)) matches
             from knowledge_documents
            where id=$1`,
          [value.documents.snake, "refund processor queue"],
        );
        expect(snakeSymbolProjection.rows[0]?.matches).toBe(true);

        const cases = [
          ["camel", "invoice payment service", true],
          ["snake", "refund processor queue", false],
          ["qualified", "billing core invoice gateway", true],
          ["path", "jwt token store", true],
          ["adr", "adr 042 session hardening", false],
          ["uuid", "7a907d4c-2b4c-4f2c-b441-c4f2edb3ef64", false],
          ["mixed", "validación payment gateway conciliación", true],
        ] as const;

        for (const [key, query, requiresSymbolReason] of cases) {
          const hits = await queryKnowledge(db, request(value, query), {
            channels: ["lexical"],
            plan: planQuery(query, {
              requestedIntent: "PROJECT_CODE",
              capabilities,
            }),
            vaultIds: [value.vaultId],
            deterministicRerank: false,
          });
          const hit = hits.find(
            (candidate) => candidate.documentId === value.documents[key],
          );
          expect(
            hit,
            `${key} query should retrieve its document`,
          ).toBeDefined();
          if (requiresSymbolReason) {
            expect(hit?.reasons).toContain("lexical:symbol-terms");
          } else if (key === "snake") {
            expect(hit?.reasons).toContain("lexical:alias-terms");
          }
        }
      } finally {
        await cleanup(db, value);
        await db.close();
      }
    },
  );
});
