import { describe, expect, it } from "vitest";
import { channelsConsistentWithIndex } from "../src/routes/search.js";

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

    expect(result.channels).toEqual(["exact", "graph"]);
    expect(result.warnings).toEqual([
      "INDEX_REVISION_MISMATCH:lexical",
      "INDEX_REVISION_MISMATCH:context-pack",
      "INDEX_REVISION_MISMATCH:vector",
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
});
