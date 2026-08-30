import { describe, expect, it, vi } from "vitest";
import type { Postgres } from "@akp/postgres";
import {
  GitKnowledgeFileNotFoundError,
  type GitKnowledgeStore,
} from "@akp/git-store";
import { incrementalIndex, synchronizeManagedPaths } from "../src/index.js";

function fakeDatabase(
  options: {
    relationRows?: Array<Record<string, unknown>>;
  } = {},
): {
  db: Postgres;
  calls: Array<{ sql: string; args: unknown[] | undefined }>;
} {
  const calls: Array<{ sql: string; args: unknown[] | undefined }> = [];
  const client = {
    query: vi.fn(async (sql: string, args?: unknown[]) => {
      calls.push({ sql, args });
      if (sql.includes("insert into knowledge_documents")) {
        return { rows: [{ id: "document-a" }], rowCount: 1 };
      }
      if (sql.includes("update knowledge_documents")) {
        return { rows: [{ id: "document-a" }], rowCount: 1 };
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
      if (sql.includes("insert into embedding_generations")) {
        return { rows: [{ id: "generation-a" }], rowCount: 1 };
      }
      if (sql.includes("select id,vault_id,path,external_id")) {
        return { rows: options.relationRows ?? [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
    connect: vi.fn(async () => client),
  };
  return { db: { pool } as unknown as Postgres, calls };
}

function fakeStore(): GitKnowledgeStore {
  return {
    showFile: vi.fn(async (revision: string, relativePath: string) => {
      if (
        relativePath === "missing.md" ||
        relativePath === "managed/missing.md"
      ) {
        throw new GitKnowledgeFileNotFoundError(revision, relativePath);
      }
      return `---\ntitle: ${relativePath}\nid: DOC-${relativePath}\n---\n\nUpdated content.`;
    }),
  } as unknown as GitKnowledgeStore;
}

describe("vault-scoped incremental indexing", () => {
  it("updates and tombstones only the requested vault", async () => {
    const { db, calls } = fakeDatabase();
    const result = await synchronizeManagedPaths(db, fakeStore(), {
      spaceId: "space-a",
      vaultId: "vault-a",
      revision: "revision-1",
      changes: [
        { path: "same.md", operation: "UPDATE" },
        { path: "missing.md" },
      ],
    });

    expect(result.indexedPaths).toEqual(["managed/same.md"]);
    expect(result.tombstonedPaths).toEqual(["managed/missing.md"]);
    const scopedCalls = calls.filter((call) =>
      /knowledge_documents|vault_index_revisions/.test(call.sql),
    );
    expect(scopedCalls.length).toBeGreaterThan(0);
    expect(scopedCalls.every((call) => call.args?.includes("vault-a"))).toBe(
      true,
    );
    expect(scopedCalls.some((call) => call.args?.includes("vault-b"))).toBe(
      false,
    );
  });

  it("preserves existing units and rejects cross-vault relation targets", async () => {
    const { db, calls } = fakeDatabase({
      relationRows: [
        {
          id: "document-a",
          vault_id: "vault-a",
          path: "managed/source.md",
          external_id: "DOC-A",
          aliases: [],
          raw_links: ["target"],
          frontmatter: {},
        },
        {
          id: "document-b",
          vault_id: "vault-b",
          path: "target.md",
          external_id: "DOC-B",
          aliases: [],
          raw_links: [],
          frontmatter: {},
        },
      ],
    });
    const result = await incrementalIndex(db, fakeStore(), {
      spaceId: "space-a",
      vaultId: "vault-a",
      revision: "revision-2",
      changes: [{ path: "source.md", operation: "UPDATE" }],
    });

    expect(result.relationCount).toBe(0);
    expect(
      calls.some((call) => /delete from knowledge_units/i.test(call.sql)),
    ).toBe(false);
    expect(
      calls.some((call) => /insert into knowledge_relations/i.test(call.sql)),
    ).toBe(false);
    expect(
      calls.some((call) => /insert into vault_index_revisions/i.test(call.sql)),
    ).toBe(true);
  });

  it("rejects traversal and non-Markdown paths before reading Git", async () => {
    const { db } = fakeDatabase();
    const store = fakeStore();
    await expect(
      synchronizeManagedPaths(db, store, {
        spaceId: "space-a",
        vaultId: "vault-a",
        revision: "revision-safe-path",
        changes: [{ path: "managed/../README.md" }],
      }),
    ).rejects.toThrow("UNSAFE_MANAGED_PATH");
    expect(store.showFile).not.toHaveBeenCalled();

    await expect(
      synchronizeManagedPaths(db, store, {
        spaceId: "space-a",
        vaultId: "vault-a",
        revision: "revision-safe-path",
        changes: [{ path: "managed/notes.txt" }],
      }),
    ).rejects.toThrow("UNSAFE_MANAGED_PATH");
    expect(store.showFile).not.toHaveBeenCalled();

    await expect(
      synchronizeManagedPaths(db, store, {
        spaceId: "space-a",
        vaultId: "vault-a",
        revision: "revision-safe-path",
        changes: [{ path: "C:/outside/secret.md" }],
      }),
    ).rejects.toThrow("UNSAFE_MANAGED_PATH");
    expect(store.showFile).not.toHaveBeenCalled();
  });
});
