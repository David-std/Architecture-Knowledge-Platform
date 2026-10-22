import { describe, expect, it, vi } from "vitest";
import { S2BilingualCandidateShadowTransformer } from "../src/s2-bilingual-candidate-shadow.js";
import {
  validateQueryTransformationResult,
  type QueryTransformerPort,
} from "../src/query-transform.js";
const fake = (query: string): QueryTransformerPort => ({
  id: "pinned-translator@revision-1",
  kind: "MULTI_QUERY",
  transform: vi.fn(async ({ originalQuery }) => ({
    originalQuery,
    transformerId: "pinned-translator@revision-1",
    variants: [
      {
        ordinal: 1,
        kind: "MULTI_QUERY" as const,
        query,
        reason: "translated-to-en",
      },
    ],
  })),
});
describe("S2 bilingual candidate shadow adapter", () => {
  it("finds translated core without passing it as evidence", async () => {
    const originalQuery = "¿Dónde almacena Horizon sus carpetas selladas?";
    const x = await new S2BilingualCandidateShadowTransformer(
      fake("Where does Horizon store sealed folders?"),
    ).transform({ originalQuery });
    expect(
      validateQueryTransformationResult(x, originalQuery, 6).variants.map(
        (v) => v.query,
      ),
    ).toContain("Horizon sealed folders");
    expect(
      x.variants.every((v) => v.reason.startsWith("DEV_SHADOW_ONLY:")),
    ).toBe(true);
  });
  it("does not accept translator swapping a named subject", async () => {
    const originalQuery = "¿Cuántas carpetas guarda Nebula?";
    const x = await new S2BilingualCandidateShadowTransformer(
      fake("How many folders does Horizon store?"),
    ).transform({ originalQuery });
    expect(x.variants.every((v) => !v.query.includes("Horizon"))).toBe(true);
  });
  it("does not drop numbers in translations", async () => {
    const x = await new S2BilingualCandidateShadowTransformer(
      fake("Where is Nebula locker 18?"),
    ).transform({ originalQuery: "¿Dónde está Nebula casillero 17?" });
    expect(x.variants.every((v) => !v.query.includes("18"))).toBe(true);
  });
  it("does not treat a numeric substring as an unchanged identifier", async () => {
    const originalQuery = "¿Dónde guarda Nebula el lote 17?";
    const x = await new S2BilingualCandidateShadowTransformer(
      fake("Where does Nebula store batch 117?"),
    ).transform({ originalQuery });
    expect(x.variants.every((v) => !v.query.includes("117"))).toBe(true);
  });
  it("does not translate negative or conditional statements", async () => {
    const p = fake("Where does Nebula store private documents?");
    const x = await new S2BilingualCandidateShadowTransformer(p).transform({
      originalQuery: "¿Dónde guarda Nebula documentos sin autorización?",
    });
    expect(x.variants).toHaveLength(0);
    expect(p.transform).not.toHaveBeenCalled();
  });
  it("refuses comparative directions whose translation might reverse roles", async () => {
    const p = fake("Which actor has lower risk in Nebula?");
    const x = await new S2BilingualCandidateShadowTransformer(p).transform({
      originalQuery: "¿Quién tiene mayor riesgo que Nebula?",
    });
    expect(x.variants).toEqual([]);
    expect(p.transform).not.toHaveBeenCalled();
  });
  it("handles translator outage without making up candidates", async () => {
    const p: QueryTransformerPort = {
      id: "unavailable@v1",
      kind: "MULTI_QUERY",
      transform: async () => {
        throw Error("TIMEOUT");
      },
    };
    const originalQuery = "Where does Nebula archive store sealed folders?";
    const x = await new S2BilingualCandidateShadowTransformer(p).transform({
      originalQuery,
    });
    expect(x.variants.length).toBeGreaterThan(0);
    expect(x.variants.every((v) => !v.query.includes("Horizon"))).toBe(true);
  });
});
