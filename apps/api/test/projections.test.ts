import { describe, expect, it, vi } from "vitest";
import type { Postgres } from "@akp/postgres";
import { rebuildSpaceProjections } from "../src/projections.js";

describe("vault-scoped structural projections", () => {
  it("persists containers and atomic units without selecting an implicit vector provider", async () => {
    const calls: Array<{ sql: string; args: unknown[] | undefined }> = [];
    let unitNumber = 0;
    const client = {
      query: vi.fn(async (sql: string, args?: unknown[]) => {
        calls.push({ sql, args });
        if (sql.includes("insert into embedding_generations")) {
          return { rows: [{ id: "generation-a" }], rowCount: 1 };
        }
        if (sql.includes("insert into knowledge_units")) {
          unitNumber += 1;
          return { rows: [{ id: `unit-${unitNumber}` }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async (sql: string, args?: unknown[]) => {
        calls.push({ sql, args });
        if (sql.includes("select current_revision from vaults")) {
          return {
            rows: [{ current_revision: "vault-revision" }],
            rowCount: 1,
          };
        }
        if (sql.includes("from knowledge_documents")) {
          return {
            rows: [
              {
                id: "document-a",
                path: "10-sources/rule.md",
                vault_id: "vault-a",
                external_id: "DOC-A",
                title: "Cache rule",
                lifecycle: "ACTIVE",
                trust_tier: "HUMAN_REVIEWED",
                body_cache: "# Cache rule\n\nA rule must hold.",
                content_hash: "hash-a",
                permissions: { "knowledge:read": ["team"] },
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
      connect: vi.fn(async () => client),
    };

    const result = await rebuildSpaceProjections(
      { pool } as unknown as Postgres,
      "space-a",
      "vault-a",
      "managed-revision",
    );

    expect(result.documentCount).toBe(1);
    expect(result.unitCount).toBeGreaterThanOrEqual(2);
    const unitInserts = calls.filter((call) =>
      /insert into knowledge_units/i.test(call.sql),
    );
    expect(unitInserts.length).toBe(result.unitCount);
    expect(unitInserts[0]?.sql).toMatch(
      /vault_id[\s\S]*parent_unit_id[\s\S]*document_revision[\s\S]*permissions[\s\S]*locator[\s\S]*structural_order[\s\S]*container_only[\s\S]*embedding_eligible/i,
    );
    const embeddings = calls.filter((call) =>
      /insert into unit_embeddings/i.test(call.sql),
    );
    expect(embeddings).toHaveLength(0);
    const revisionInsert = calls.find((call) =>
      /insert into vault_index_revisions/i.test(call.sql),
    );
    expect(revisionInsert?.args).toContain(null);
    expect(JSON.stringify(revisionInsert?.args)).toContain(
      "VECTOR_DISABLED_PENDING_BENCHMARK",
    );
    expect(
      calls.some((call) => /insert into vault_index_revisions/i.test(call.sql)),
    ).toBe(true);
    expect(
      calls.some((call) => /insert into index_revisions/i.test(call.sql)),
    ).toBe(false);
    expect(
      calls
        .filter((call) =>
          /delete from (knowledge_units|context_packets)/i.test(call.sql),
        )
        .every((call) => call.args?.includes("vault-a")),
    ).toBe(true);
  });

  /**
   * The served channels (lexical, graph, context-pack) are written at the current
   * corpus revision in the same statement, so they are consistent by construction.
   * Vector is the only channel that can lag, and it only counts as an index defect
   * when the deployment actually serves it. Reporting a permanently DEGRADED index
   * while vector stays off pending the benchmark decision would mark every answer
   * degraded and make the signal meaningless.
   */
  it.each([
    {
      vectorEnabled: false,
      expectedStatus: "CONSISTENT",
      expectedWarning: "VECTOR_DISABLED_PENDING_BENCHMARK",
    },
    {
      vectorEnabled: true,
      expectedStatus: "DEGRADED",
      expectedWarning: "VECTOR_BUILD_PENDING",
    },
  ])(
    "marks the index status from the channels it serves (vector enabled: $vectorEnabled)",
    async ({ vectorEnabled, expectedStatus, expectedWarning }) => {
      const previous = process.env.AKP_VECTOR_ENABLED;
      if (vectorEnabled) process.env.AKP_VECTOR_ENABLED = "true";
      else delete process.env.AKP_VECTOR_ENABLED;
      try {
        const { calls } = await runProjection();
        const revisionInsert = calls.find((call) =>
          /insert into vault_index_revisions/i.test(call.sql),
        );
        expect(revisionInsert).toBeDefined();
        expect(revisionInsert?.args).toContain(expectedStatus);
        expect(JSON.stringify(revisionInsert?.args)).toContain(expectedWarning);
      } finally {
        if (previous === undefined) delete process.env.AKP_VECTOR_ENABLED;
        else process.env.AKP_VECTOR_ENABLED = previous;
      }
    },
  );
});

async function runProjection(): Promise<{
  calls: Array<{ sql: string; args: unknown[] | undefined }>;
}> {
  const calls: Array<{ sql: string; args: unknown[] | undefined }> = [];
  let unitNumber = 0;
  const client = {
    query: vi.fn(async (sql: string, args?: unknown[]) => {
      calls.push({ sql, args });
      if (sql.includes("insert into embedding_generations")) {
        return { rows: [{ id: "generation-a" }], rowCount: 1 };
      }
      if (sql.includes("insert into knowledge_units")) {
        unitNumber += 1;
        return { rows: [{ id: `unit-${unitNumber}` }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(async (sql: string, args?: unknown[]) => {
      calls.push({ sql, args });
      if (sql.includes("select current_revision from vaults")) {
        return { rows: [{ current_revision: "vault-revision" }], rowCount: 1 };
      }
      if (sql.includes("from knowledge_documents")) {
        return {
          rows: [
            {
              id: "document-a",
              path: "10-sources/rule.md",
              vault_id: "vault-a",
              external_id: "DOC-A",
              title: "Cache rule",
              lifecycle: "ACTIVE",
              trust_tier: "HUMAN_REVIEWED",
              body_cache: "# Cache rule\n\nA rule must hold.",
              content_hash: "hash-a",
              permissions: { "knowledge:read": ["team"] },
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }),
    connect: vi.fn(async () => client),
  };
  await rebuildSpaceProjections(
    { pool } as unknown as Postgres,
    "space-a",
    "vault-a",
    "managed-revision",
  );
  return { calls };
}
