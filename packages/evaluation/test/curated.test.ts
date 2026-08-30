import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCuratedBenchmarkReport,
  RETRIEVAL_BENCHMARK_MATRIX,
  loadCuratedFixture,
  loadEvaluationPack,
  rankCuratedCase,
} from "../src/index.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

describe("curated Level B fixture", () => {
  it("loads three isolated local vaults without reading the private corpus", async () => {
    const fixture = await loadCuratedFixture(repositoryRoot);
    expect(fixture.evidenceLevel).toBe("CURATED_FIXTURE");
    expect(
      new Set(fixture.documents.map((document) => document.vault)),
    ).toEqual(
      new Set(["vault-a-software", "vault-b-handbook", "vault-c-neutral"]),
    );
    expect(fixture.documents).toHaveLength(10);
  });

  it("executes exact, alias, graph, no-answer and citation cases locally", async () => {
    const fixture = await loadCuratedFixture(repositoryRoot);
    const cases = await loadEvaluationPack(repositoryRoot, "curated-level-b");
    const exactLexical = RETRIEVAL_BENCHMARK_MATRIX.find(
      (configuration) => configuration.name === "exact+lexical",
    )!;
    const graph = RETRIEVAL_BENCHMARK_MATRIX.find(
      (configuration) => configuration.name === "graph-only",
    )!;

    const exact = rankCuratedCase(
      fixture,
      cases.find((testCase) => testCase.id === "level-b-a-exact")!,
      exactLexical,
    );
    expect(exact.rankedDocumentIds[0]).toBe("software-api-boundary");

    const alias = rankCuratedCase(
      fixture,
      cases.find((testCase) => testCase.id === "level-b-a-alias")!,
      exactLexical,
    );
    expect(alias.rankedDocumentIds[0]).toBe("software-api-boundary");

    const graphResult = rankCuratedCase(
      fixture,
      cases.find((testCase) => testCase.id === "level-b-a-graph")!,
      graph,
    );
    expect(graphResult.rankedDocumentIds).toContain("software-cache-runbook");

    const noAnswer = rankCuratedCase(
      fixture,
      cases.find((testCase) => testCase.id === "level-b-b-no-answer")!,
      exactLexical,
    );
    expect(noAnswer.rankedDocumentIds).toEqual([]);
    expect(noAnswer.returnedAnswer).toBe(false);

    const source = rankCuratedCase(
      fixture,
      cases.find((testCase) => testCase.id === "level-b-a-source")!,
      exactLexical,
    );
    expect(source.retrievedEvidenceIds).toContain("ev-software-cache");
    expect(source.retrievedCitationIds).toContain(
      "fixture://vault-a/software-cache-policy#L1",
    );
  });

  it("keeps vector-disabled probes deterministic", async () => {
    const fixture = await loadCuratedFixture(repositoryRoot);
    const cases = await loadEvaluationPack(repositoryRoot, "curated-level-b");
    const vector = RETRIEVAL_BENCHMARK_MATRIX.find(
      (configuration) => configuration.name === "vector-only",
    )!;
    const testCase = cases.find(
      (candidate) => candidate.id === "level-b-a-vector-disabled",
    )!;
    const disabled = rankCuratedCase(fixture, testCase, vector);
    const enabled = rankCuratedCase(fixture, testCase, vector, {
      vectorEnabled: true,
    });
    expect(disabled.rankedDocumentIds).toEqual([]);
    expect(enabled.rankedDocumentIds[0]).toBe("software-cache-policy");
  });

  it("reports Level B as fixture evidence and never chooses a runtime default", async () => {
    const fixture = await loadCuratedFixture(repositoryRoot);
    const cases = await loadEvaluationPack(repositoryRoot, "curated-level-b");
    const report = buildCuratedBenchmarkReport(fixture, cases, {
      generatedAt: "2026-08-13T00:00:00.000Z",
    });
    expect(report.evidenceLevel).toBe("CURATED_FIXTURE");
    expect(report.provider.readsPrivateVault).toBe(false);
    expect(report.productionDefault.selected).toBeNull();
    expect(report.runs).toHaveLength(10);
    expect(report.runs.every((run) => run.noAnswerAccuracy === 1)).toBe(true);
  });
});
