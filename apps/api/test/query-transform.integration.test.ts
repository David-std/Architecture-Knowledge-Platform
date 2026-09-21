import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SearchRequest } from "@akp/contracts";
import { Postgres } from "@akp/postgres";
import { DeterministicQueryDecomposer, planQuery } from "@akp/retrieval";
import { queryKnowledge } from "../src/routes/search.js";

const databaseUrl = process.env.DATABASE_URL;

interface Fixture {
  organizationId: string;
  spaceId: string;
  authorizedVaultId: string;
  unauthorizedVaultId: string;
  revision: string;
  tlsDocumentId: string;
  jwtDocumentId: string;
  secretDocumentId: string;
}

function fixture(): Fixture {
  return {
    organizationId: randomUUID(),
    spaceId: randomUUID(),
    authorizedVaultId: randomUUID(),
    unauthorizedVaultId: randomUUID(),
    revision: `query-transform-${randomUUID()}`,
    tlsDocumentId: randomUUID(),
    jwtDocumentId: randomUUID(),
    secretDocumentId: randomUUID(),
  };
}

async function insertDocument(
  db: Postgres,
  value: Fixture,
  input: {
    id: string;
    vaultId: string;
    externalId: string;
    path: string;
    title: string;
    body: string;
  },
): Promise<void> {
  await db.pool.query(
    `
    insert into knowledge_documents(
      id,space_id,vault_id,path,external_id,aliases,title,type,lifecycle,
      trust_tier,current_revision,body_cache,frontmatter,layer,
      content_hash,token_estimate,raw_links
    ) values(
      $1,$2,$3,$4,$5,'{}',$6,'concept','ACTIVE','HUMAN_REVIEWED',
      $7,$8,$9::jsonb,'concept',$10,20,'[]'::jsonb
    )
    `,
    [
      input.id,
      value.spaceId,
      input.vaultId,
      input.path,
      input.externalId,
      input.title,
      value.revision,
      input.body,
      JSON.stringify({ id: input.externalId, title: input.title }),
      createHash("sha256").update(input.body).digest("hex"),
    ],
  );
}

async function seed(db: Postgres, value: Fixture): Promise<void> {
  await db.pool.query(
    "insert into organizations(id,slug,name) values($1,$2,$3)",
    [
      value.organizationId,
      `query-transform-${value.organizationId.slice(0, 8)}`,
      "Query transform integration",
    ],
  );
  await db.pool.query(
    `
    insert into spaces(
      id,organization_id,slug,name,visibility,knowledge_repo_path
    ) values($1,$2,$3,$4,'PRIVATE',$5)
    `,
    [
      value.spaceId,
      value.organizationId,
      `query-transform-${value.spaceId.slice(0, 8)}`,
      "Query transform space",
      `C:/akp/query-transform/${value.spaceId}`,
    ],
  );

  for (const [vaultId, suffix] of [
    [value.authorizedVaultId, "authorized"],
    [value.unauthorizedVaultId, "unauthorized"],
  ] as const) {
    await db.pool.query(
      `
      insert into vaults(
        id,space_id,canonical_path,name,read_only,current_revision,
        vault_key,local_path,visibility,enabled
      ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)
      `,
      [
        vaultId,
        value.spaceId,
        `C:/akp/query-transform/${suffix}`,
        `Query transform ${suffix}`,
        value.revision,
        `query-transform-${suffix}-${vaultId.slice(0, 8)}`,
      ],
    );
    await db.pool.query(
      `
      insert into vault_index_revisions(
        space_id,vault_id,corpus_revision,lexical_revision,status,warnings
      ) values($1,$2,$3,$3,'CONSISTENT','[]'::jsonb)
      `,
      [value.spaceId, vaultId, value.revision],
    );
  }

  await insertDocument(db, value, {
    id: value.tlsDocumentId,
    vaultId: value.authorizedVaultId,
    externalId: "TLS-ROTATION",
    path: "security/tls-rotation.md",
    title: "TLS rotation policy",
    body: "TLS rotation policy defines certificate renewal intervals.",
  });
  await insertDocument(db, value, {
    id: value.jwtDocumentId,
    vaultId: value.authorizedVaultId,
    externalId: "JWT-SIGNING",
    path: "security/jwt-signing.md",
    title: "JWT signing keys",
    body: "JWT signing keys define key rollover responsibilities.",
  });
  await insertDocument(db, value, {
    id: value.secretDocumentId,
    vaultId: value.unauthorizedVaultId,
    externalId: "SECRET-COMBINATION",
    path: "private/secret.md",
    title: "TLS rotation policy JWT signing keys",
    body: "TLS rotation policy and JWT signing keys confidential combined guidance.",
  });
}

function request(value: Fixture, query: string): SearchRequest {
  return {
    query,
    spaceId: value.spaceId,
    vaultId: value.authorizedVaultId,
    vaultIds: [],
    federated: false,
    types: [],
    minimumTrust: "MACHINE_SUPPORTED",
    mode: "SOURCE_BACKED",
    limit: 10,
  };
}

async function cleanup(db: Postgres, value: Fixture): Promise<void> {
  await db.pool.query("delete from retrieval_query_traces where space_id=$1", [
    value.spaceId,
  ]);
  await db.pool.query("delete from knowledge_documents where space_id=$1", [
    value.spaceId,
  ]);
  await db.pool.query("delete from vault_index_revisions where space_id=$1", [
    value.spaceId,
  ]);
  await db.pool.query("delete from vaults where space_id=$1", [value.spaceId]);
  await db.pool.query("delete from spaces where id=$1", [value.spaceId]);
  await db.pool.query("delete from organizations where id=$1", [
    value.organizationId,
  ]);
}

const capabilities = {
  vectorAvailable: false,
  graphConsistent: false,
  communityAvailable: false,
  rawAllowed: false,
  codeAdapterAvailable: false,
  contextPackAvailable: false,
};

describe("query transformation retrieval", () => {
  it.skipIf(!databaseUrl)(
    "persists original+variants and uses variants only inside the authorized vault",
    async () => {
      if (!databaseUrl) return;
      const value = fixture();
      const db = new Postgres(databaseUrl);
      const query = "TLS rotation policy; JWT signing keys";
      try {
        await seed(db, value);
        const plan = planQuery(query, {
          requestedIntent: "CONCEPTUAL",
          capabilities,
        });

        const withoutTransform = await queryKnowledge(
          db,
          request(value, query),
          {
            channels: ["lexical"],
            plan,
            vaultIds: [value.authorizedVaultId],
          },
        );
        expect(withoutTransform).toHaveLength(0);

        const warnings: string[] = [];
        const withTransform = await queryKnowledge(db, request(value, query), {
          channels: ["lexical"],
          plan,
          vaultIds: [value.authorizedVaultId],
          queryTransformer: new DeterministicQueryDecomposer(),
          warningSink: warnings,
        });

        expect(withTransform.map((hit) => hit.documentId).sort()).toEqual(
          [value.jwtDocumentId, value.tlsDocumentId].sort(),
        );
        expect(
          withTransform.some(
            (hit) => hit.documentId === value.secretDocumentId,
          ),
        ).toBe(false);
        expect(
          withTransform.every((hit) =>
            hit.reasons.some((reason) =>
              reason.startsWith("lexical:transformed:DECOMPOSITION:"),
            ),
          ),
        ).toBe(true);
        expect(warnings).not.toContain("QUERY_TRANSFORM_TRACE_NOT_PERSISTED");
        expect(
          withTransform.every(
            (hit) =>
              hit.retrievalTrace?.authorization.decision === "SCOPED_INTERNAL" &&
              hit.retrievalTrace.authorization.spaceId === value.spaceId &&
              hit.retrievalTrace.authorization.vaultId ===
                value.authorizedVaultId &&
              hit.retrievalTrace.authorization.pathRestricted === false &&
              hit.retrievalTrace.truth.state === "UNANNOTATED" &&
              hit.retrievalTrace.truth.consistency === "STRICT",
          ),
        ).toBe(true);
        const transformTraceIds = new Set(
          withTransform.flatMap((hit) =>
            hit.retrievalTrace?.contributions.flatMap((contribution) =>
              contribution.queryTransform
                ? [contribution.queryTransform.traceId]
                : [],
            ) ?? [],
          ),
        );
        expect(transformTraceIds.size).toBe(1);
        expect([...transformTraceIds][0]).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        for (const hit of withTransform) {
          const transformedContribution =
            hit.retrievalTrace?.contributions.find(
              (contribution) => contribution.queryTransform,
            );
          expect(transformedContribution?.queryTransform).toMatchObject({
            transformerId: "deterministic-query-decomposition-v1",
            kind: "DECOMPOSITION",
            reason: "strong-delimiter decomposition",
          });
          expect(
            transformedContribution?.queryTransform?.ordinal,
          ).toBeGreaterThan(0);
          expect(hit.retrievalTrace?.finalSelectionReason).toContain(
            "lexical:transformed:DECOMPOSITION:",
          );
          expect(JSON.stringify(hit.retrievalTrace)).not.toContain(
            value.unauthorizedVaultId,
          );
        }

        const trace = await db.pool.query<{
          original_query: string;
          transformer_id: string;
          transform_kind: string;
          variants: Array<{
            ordinal: number;
            kind: string;
            query: string;
          }>;
          variant_count: number;
          assisted_channels: string[];
          vault_ids: string[];
          truth_snapshot: {
            spaceId?: string;
            vaults?: Array<{ vaultId: string }>;
          };
        }>(
          `
          select original_query,transformer_id,transform_kind,variants,
                 variant_count,assisted_channels,vault_ids,truth_snapshot
            from retrieval_query_traces
           where space_id=$1
           order by created_at desc
           limit 1
          `,
          [value.spaceId],
        );
        expect(trace.rows[0]).toMatchObject({
          original_query: query,
          transformer_id: "deterministic-query-decomposition-v1",
          transform_kind: "DECOMPOSITION",
          variant_count: 2,
          assisted_channels: ["LEXICAL"],
          vault_ids: [value.authorizedVaultId],
        });
        expect(trace.rows[0]?.variants.map((variant) => variant.query)).toEqual(
          ["TLS rotation policy", "JWT signing keys"],
        );
        expect(
          trace.rows[0]?.truth_snapshot.vaults?.map((vault) => vault.vaultId),
        ).toEqual([value.authorizedVaultId]);
      } finally {
        await cleanup(db, value);
        await db.close();
      }
    },
  );
});
