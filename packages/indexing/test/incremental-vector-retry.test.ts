import { describe, expect, it, vi } from "vitest";
import type { Postgres } from "@akp/postgres";
import type { GitKnowledgeStore } from "@akp/git-store";

vi.mock("../src/embedding-index.js", () => ({
  buildEmbeddingIndex: vi.fn(),
}));

import { buildEmbeddingIndex } from "../src/embedding-index.js";
import { incrementalIndex } from "../src/index.js";

interface FakeDatabaseOptions {
  indexRevision: Record<string, unknown>;
}

function fakeDatabase(options: FakeDatabaseOptions): {
  db: Postgres;
  calls: Array<{ sql: string; args: unknown[] | undefined }>;
} {
  const calls: Array<{ sql: string; args: unknown[] | undefined }> = [];
  const pool = {
    query: vi.fn(async (sql: string, args?: unknown[]) => {
      calls.push({ sql, args });
      if (sql.includes("select current_revision from vaults")) {
        return { rows: [{ current_revision: "vault-revision" }], rowCount: 1 };
      }
      if (
        sql.includes("select corpus_revision,lexical_revision,vector_revision")
      ) {
        return { rows: [options.indexRevision], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  return { db: { pool } as unknown as Postgres, calls };
}

function fakeStore(): GitKnowledgeStore {
  return { showFile: vi.fn() } as unknown as GitKnowledgeStore;
}

function marker(vectorRevision: string): Record<string, unknown> {
  const corpusRevision = "composite:vault-revision+managed:revision-current";
  return {
    corpus_revision: corpusRevision,
    lexical_revision: corpusRevision,
    vector_revision: vectorRevision,
    graph_revision: corpusRevision,
    context_pack_revision: corpusRevision,
  };
}

function setProviderEnvironment(): Map<string, string | undefined> {
  const keys = ["NODE_ENV", "AKP_VECTOR_ENABLED", "AKP_EMBEDDING_PROVIDER"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = "test";
  process.env.AKP_VECTOR_ENABLED = "true";
  process.env.AKP_EMBEDDING_PROVIDER = "deterministic-test";
  return previous;
}

function restoreEnvironment(previous: Map<string, string | undefined>): void {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("incremental vector retry reconciliation", () => {
  it("retries a provider that reappears without reading managed files", async () => {
    const previousEnvironment = setProviderEnvironment();
    const { db, calls } = fakeDatabase({ indexRevision: marker("old-vector") });
    const store = fakeStore();
    vi.mocked(buildEmbeddingIndex).mockResolvedValue({
      generation: {} as never,
      unitCount: 1,
      embeddingsReused: 1,
      embeddingsCreated: 0,
      activated: true,
    });
    try {
      const result = await incrementalIndex(db, store, {
        spaceId: "space-a",
        vaultId: "vault-a",
        revision: "revision-current",
        changes: [{ path: "new.md", operation: "UPDATE" }],
        eventId: "11111111-1111-4111-8111-111111111111",
      });

      expect(result.embeddingsReused).toBe(1);
      expect(buildEmbeddingIndex).toHaveBeenCalledTimes(1);
      expect(store.showFile).not.toHaveBeenCalled();
      const runQueries = calls
        .map((call) => call.sql)
        .filter((sql) => /incremental_index_runs/i.test(sql));
      expect(runQueries.length).toBeGreaterThan(0);
      expect(
        runQueries.every(
          (sql) => /space_id/i.test(sql) && /vault_id/i.test(sql),
        ),
      ).toBe(true);
      expect(
        runQueries.some((sql) =>
          /on conflict\(space_id,vault_id,event_id\)/i.test(sql),
        ),
      ).toBe(true);
    } finally {
      restoreEnvironment(previousEnvironment);
    }
  });

  it("keeps the prior vector revision when replacement construction fails", async () => {
    const previousEnvironment = setProviderEnvironment();
    const { db, calls } = fakeDatabase({ indexRevision: marker("old-vector") });
    vi.mocked(buildEmbeddingIndex).mockRejectedValue(
      new Error("controlled provider failure"),
    );
    try {
      const result = await incrementalIndex(db, fakeStore(), {
        spaceId: "space-a",
        vaultId: "vault-a",
        revision: "revision-current",
        changes: [{ path: "new.md", operation: "UPDATE" }],
      });

      expect(result.embeddingsCreated).toBe(0);
      const markerWrites = calls.filter((call) =>
        /insert into vault_index_revisions/i.test(call.sql),
      );
      expect(markerWrites.length).toBe(2);
      expect(
        markerWrites.every((call) => call.args?.includes("old-vector")),
      ).toBe(true);
      expect(
        markerWrites.some((call) =>
          JSON.stringify(call.args).includes("VECTOR_BUILD_FAILED"),
        ),
      ).toBe(true);
    } finally {
      restoreEnvironment(previousEnvironment);
    }
  });
});
