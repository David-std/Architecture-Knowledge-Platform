import { describe, expect, it, vi } from "vitest";
import type { Postgres } from "@akp/postgres";
import { rebuildSpaceProjections } from "../src/projections.js";

describe("vault-scoped structural projections", () => {
  it("persists containers and atomic units without embedding DOCUMENT/SECTION", async () => {
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
    expect(embeddings).toHaveLength(1);
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
});
