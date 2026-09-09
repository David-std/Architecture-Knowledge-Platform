import { describe, expect, it } from "vitest";
import {
  channelsConsistentWithIndex,
  evidenceLocatorAllowed,
  queryKnowledge,
} from "../src/routes/search.js";

describe("retrieval revision policy", () => {
  it("removes derived channels whose projection revision is stale", () => {
    const result = channelsConsistentWithIndex(
      ["exact", "lexical", "graph", "context-pack", "vector"],
      {
        corpus_revision: "corpus-new",
        lexical_revision: "corpus-old",
        graph_revision: "corpus-new",
        context_pack_revision: null,
        vector_revision: "corpus-old",
      },
      true,
    );

    expect(result.channels).toEqual(["exact", "graph", "vector"]);
    expect(result.warnings).toEqual([
      "INDEX_REVISION_MISMATCH:lexical",
      "INDEX_REVISION_MISMATCH:context-pack",
      "INDEX_REVISION_STALE:vector",
    ]);
  });

  it("does not activate vectors merely because their revision is current", () => {
    const result = channelsConsistentWithIndex(
      ["vector", "lexical"],
      {
        corpus_revision: "corpus-current",
        lexical_revision: "corpus-current",
        vector_revision: "corpus-current",
      },
      false,
    );

    expect(result.channels).toEqual(["lexical"]);
    expect(result.warnings).toEqual(["VECTOR_DISABLED"]);
  });

  it("filters evidence locators outside a path-scoped membership", () => {
    const isAllowed = (value: string) => value.startsWith("shared/");
    expect(
      evidenceLocatorAllowed(
        { kind: "markdown", path: "shared/source.md" },
        isAllowed,
      ),
    ).toBe(true);
    expect(
      evidenceLocatorAllowed(
        { kind: "markdown", path: "private/secret.md" },
        isAllowed,
      ),
    ).toBe(false);
    expect(
      evidenceLocatorAllowed(
        { kind: "source", path: "source:11111111-1111-4111-8111-111111111111" },
        isAllowed,
      ),
    ).toBe(true);
    expect(
      evidenceLocatorAllowed(
        { kind: "source", path: "source:C:/private/secret.pdf" },
        isAllowed,
      ),
    ).toBe(false);
    expect(
      evidenceLocatorAllowed({
        kind: "source",
        path: "source:11111111-1111-4111-8111-11111111111",
      }),
    ).toBe(false);
    expect(
      evidenceLocatorAllowed(
        {
          kind: "source",
          path: "shared/source.md",
          source_uri: "C:\\Users\\david\\Downloads\\secret.pdf",
        },
        isAllowed,
      ),
    ).toBe(false);
    expect(
      evidenceLocatorAllowed(
        { kind: "source", path: "shared/source.md", notes: ["/tmp/secret"] },
        isAllowed,
      ),
    ).toBe(false);
    expect(evidenceLocatorAllowed(null, isAllowed)).toBe(false);
  });

  it("does not expose cross-space citations or out-of-prefix evidence", async () => {
    const spaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const otherSpaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const vaultId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const documentId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const calls: string[] = [];
    const db = {
      pool: {
        query: async (sql: string) => {
          calls.push(sql);
          if (sql.includes("from vault_index_revisions")) {
            return { rows: [] };
          }
          if (sql.includes("lower(external_id)")) {
            return { rows: [{ id: documentId }] };
          }
          if (sql.includes("select d.id,")) {
            return {
              rows: [
                {
                  id: documentId,
                  space_id: spaceId,
                  vault_id: vaultId,
                  path: "shared/claim.md",
                  title: "Claim",
                  type: "claim",
                  layer: "claim",
                  trust_tier: "HUMAN_REVIEWED",
                  lifecycle: "ACTIVE",
                  current_revision: "rev-1",
                  body_cache: "A claim",
                  refresh_status: "CURRENT",
                  citations: [
                    {
                      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                      spaceId: otherSpaceId,
                      vaultId,
                      path: "shared/foreign.md",
                      revision: "foreign",
                    },
                    {
                      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
                      spaceId,
                      vaultId,
                      path: "shared/local-source.md",
                      revision: "local",
                    },
                  ],
                  evidence_locators: [
                    { kind: "markdown", path: "private/secret.md" },
                    { kind: "markdown", path: "shared/local.md" },
                  ],
                },
              ],
            };
          }
          return { rows: [] };
        },
      },
    } as never;

    const hits = await queryKnowledge(
      db,
      {
        query: "DOC-001",
        spaceId,
        vaultId,
        vaultIds: [],
        federated: false,
        types: [],
        minimumTrust: "MACHINE_SUPPORTED",
        mode: "SOURCE_BACKED",
        limit: 20,
      },
      {
        vaultIds: [vaultId],
        pathAuthorizer: (value) => value.startsWith("shared/"),
        channels: ["exact"],
      },
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]?.citations).toEqual([
      "shared/local-source.md@local",
      'evidence:{"kind":"markdown","path":"shared/local.md"}',
    ]);
    expect(hits[0]?.warnings).toContain("UNTRUSTED_RETRIEVED_CONTENT");
    const detailsSql = calls.find((sql) => sql.includes("select d.id,"));
    expect(detailsSql).toContain("cited.space_id = d.space_id");
    expect(detailsSql).toContain(
      "cited.vault_id is not distinct from d.vault_id",
    );
    expect(detailsSql).toContain("e.space_id = d.space_id");
  });
});
