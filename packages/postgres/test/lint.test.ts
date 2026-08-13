import { describe, expect, it, vi } from "vitest";
import { runKnowledgeLint, type Postgres } from "../src/index.js";

describe("vault-scoped knowledge lint", () => {
  it("filters findings and persists the lint run under one vault", async () => {
    const calls: Array<{ sql: string; args: unknown[] | undefined }> = [];
    const pool = {
      query: vi.fn(async (sql: string, args?: unknown[]) => {
        calls.push({ sql, args });
        if (sql.includes("select coalesce")) {
          return { rows: [{ revision: "corpus-a" }], rowCount: 1 };
        }
        if (sql.includes("insert into knowledge_lint_runs")) {
          return { rows: [{ id: "lint-a" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const result = await runKnowledgeLint(
      { pool } as unknown as Postgres,
      "space-a",
      "vault-a",
      "MANUAL",
    );

    expect(result).toMatchObject({
      id: "lint-a",
      spaceId: "space-a",
      vaultId: "vault-a",
      corpusRevision: "corpus-a",
    });
    expect(calls[0]?.args).toEqual(["space-a", "vault-a"]);
    expect(calls[1]?.args).toEqual(["space-a", "vault-a"]);
    const insert = calls.find((call) =>
      call.sql.includes("insert into knowledge_lint_runs"),
    );
    expect(insert?.args?.slice(0, 2)).toEqual(["space-a", "vault-a"]);
    expect(insert?.sql).toContain("vault_id");
  });

  it("rejects an omitted vault scope before querying", async () => {
    const query = vi.fn();
    await expect(
      runKnowledgeLint(
        { pool: { query } } as unknown as Postgres,
        "space-a",
        "",
        "MANUAL",
      ),
    ).rejects.toThrow("VAULT_SCOPE_REQUIRED");
    expect(query).not.toHaveBeenCalled();
  });
});
