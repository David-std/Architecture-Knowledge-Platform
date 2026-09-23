import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type AnnDecision = {
  status: string;
  registeredCorpus: { documentCount: number };
  decision: { selectedIndex: string | null; winner: string | null };
  runtimeExecution: {
    selectionAuthority: string;
    explicitAccessPathHint: string | null;
    pinnedVectorStrategy: string | null;
    queryContract: string;
    claimBoundary: string;
  };
  supportingEvidence: Array<{ path: string; limitation: string }>;
};

const repositoryFile = (relativePath: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../${relativePath}`, import.meta.url)),
    "utf8",
  );

describe("registered ANN decision", () => {
  it("keeps production vector access-path selection explicitly deferred", () => {
    const decision = JSON.parse(
      repositoryFile("evals/registered/ann-decision.json"),
    ) as AnnDecision;

    expect(decision.status).toBe("DEFERRED");
    expect(decision.registeredCorpus.documentCount).toBe(8);
    expect(decision.decision.selectedIndex).toBeNull();
    expect(decision.decision.winner).toBeNull();
    expect(decision.runtimeExecution).toMatchObject({
      selectionAuthority: "POSTGRES_PLANNER",
      explicitAccessPathHint: null,
      pinnedVectorStrategy: null,
    });
    expect(decision.runtimeExecution.queryContract).toContain(
      "ORDER BY embedding <=> query LIMIT",
    );
    expect(decision.runtimeExecution.claimBoundary).toContain(
      "does not report EXACT_SCAN, HNSW or IVFFlat",
    );
  });

  it("ties the deferred decision to the real query, indexes, and filtered benchmark", () => {
    const decision = JSON.parse(
      repositoryFile("evals/registered/ann-decision.json"),
    ) as AnnDecision;
    const search = repositoryFile("apps/api/src/routes/search.ts");
    const migration = repositoryFile(
      "db/migrations/019_semantic_embedding_generations.sql",
    );
    const filteredBenchmark = repositoryFile(
      "scripts/filtered-ann-baseline.ts",
    );

    expect(search).toContain(
      "order by e.embedding::vector(${dimensions}) <=> $3::vector(${dimensions})",
    );
    expect(search).toContain("and u.vault_id=$4");
    expect(migration).toContain("using hnsw");
    expect(migration).toContain("where embedding_dimensions=384");
    expect(filteredBenchmark).toContain("productionIndexSelected: false");
    expect(filteredBenchmark).toContain(
      '"This measures pgvector filtered ANN behavior on an isolated adversarial fixture.',
    );

    const evidencePaths = new Set(
      decision.supportingEvidence.map((entry) => entry.path),
    );
    expect(evidencePaths).toEqual(
      new Set([
        "scripts/filtered-ann-baseline.ts",
        "db/migrations/019_semantic_embedding_generations.sql",
        "apps/api/src/routes/search.ts",
        "reports/scale/load-scale-benchmark.json",
      ]),
    );
    expect(
      decision.supportingEvidence.every((entry) => entry.limitation.length > 0),
    ).toBe(true);
  });
});
