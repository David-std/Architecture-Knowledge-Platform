import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEvaluationPack, REQUIRED_GENERIC_SLICES } from "../src/index.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const temporaryRoots: string[] = [];

async function temporaryRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "akp-evaluation-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("evaluation pack isolation", () => {
  it("loads the corpus-agnostic generic pack", async () => {
    const cases = await loadEvaluationPack(repositoryRoot, "generic");
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((testCase) => testCase.vault === undefined)).toBe(true);
    const slices = new Set(
      cases.map((testCase) => testCase.slice ?? testCase.category),
    );
    for (const slice of REQUIRED_GENERIC_SLICES)
      expect(slices.has(slice)).toBe(true);
  });

  it("allows explicit fixture packs to carry local vault scope", async () => {
    const root = await temporaryRepository();
    const fixtureRoot = path.join(root, "evals", "fixtures", "example-pack");
    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(
      path.join(fixtureRoot, "cases.jsonl"),
      `${JSON.stringify({
        id: "fixture-case",
        category: "fixture",
        query: "fixture query",
        gold_documents: ["fixture.md"],
        vault: "example-vault",
      })}\n`,
      "utf8",
    );

    const cases = await loadEvaluationPack(root, "example-pack");
    expect(cases).toHaveLength(1);
    expect(cases[0]?.vault).toBe("example-vault");
  });

  it("rejects vault scope in the generic pack structurally", async () => {
    const root = await temporaryRepository();
    const genericRoot = path.join(root, "evals", "generic");
    await mkdir(genericRoot, { recursive: true });
    await writeFile(
      path.join(genericRoot, "cases.jsonl"),
      `${JSON.stringify({
        id: "scoped-generic-case",
        category: "exact-identifiers",
        query: "generic query",
        gold_documents: ["generic.md"],
        vault: "should-not-be-here",
      })}\n`,
      "utf8",
    );

    await expect(loadEvaluationPack(root, "generic")).rejects.toThrow(
      "Generic evaluation case cannot declare a vault scope",
    );
  });
});
