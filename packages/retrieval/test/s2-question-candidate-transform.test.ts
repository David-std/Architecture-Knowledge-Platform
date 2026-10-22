import { describe, expect, it } from "vitest";
import {
  S2BoundedQuestionCandidateTransformer,
  S2_QUESTION_CANDIDATE_TRANSFORMER_ID,
} from "../src/s2-question-candidate-transform.js";
import { validateQueryTransformationResult } from "../src/query-transform.js";

const transformer = new S2BoundedQuestionCandidateTransformer();
describe("S2 question candidate probes (shadow only)", () => {
  it("retains original question and emits bounded lexical probes for an English open question", async () => {
    const originalQuery = "How many sealed folders does Nebula store?";
    const transformed = await transformer.transform({ originalQuery });
    const validated = validateQueryTransformationResult(
      transformed,
      originalQuery,
      2,
    );
    expect(transformed.transformerId).toBe(
      S2_QUESTION_CANDIDATE_TRANSFORMER_ID,
    );
    expect(validated.variants.map((v) => v.query)).toContain(
      "Nebula sealed folders",
    );
    expect(validated.variants).toHaveLength(2);
    expect(validated.variants.every((v) => v.kind === "MULTI_QUERY")).toBe(
      true,
    );
  });
  it("handles Spanish interrogatives without generating translated facts", async () => {
    const originalQuery = "¿Dónde almacena Horizon sus carpetas selladas?";
    const transformed = await transformer.transform({ originalQuery });
    expect(transformed.variants.map((v) => v.query)).toContain(
      "Horizon carpetas selladas",
    );
    expect(
      transformed.variants.every((v) =>
        originalQuery.includes(v.query.split(" ")[0]!),
      ),
    ).toBe(true);
  });
  it("does not arbitrarily pick a subject across several named entities", async () => {
    const result = await transformer.transform({
      originalQuery: "What are the obligations of Nebula and Horizon?",
    });
    expect(result.variants).toEqual([]);
  });
  it("does not drop negations, scope exclusions or temporal qualifications", async () => {
    for (const originalQuery of [
      "Why does Nebula never send sealed folders?",
      "How many sealed folders does Nebula hold unless approved?",
      "¿Dónde conserva Horizon las carpetas después de 2031?",
    ]) {
      expect((await transformer.transform({ originalQuery })).variants).toEqual(
        [],
      );
    }
  });
  it("cannot silently discard exact identifiers or quantities", async () => {
    const result = await transformer.transform({
      originalQuery: "How many 42 folders does Nebula store?",
    });
    expect(result.variants.every((v) => v.query.includes("42"))).toBe(true);
  });
  it("caps variants and fails closed on unbounded input", async () => {
    const originalQuery = "Where does Horizon archive store sealed folders?";
    expect(
      (await transformer.transform({ originalQuery, maxVariants: 1 })).variants,
    ).toHaveLength(1);
    expect(
      (await transformer.transform({ originalQuery, maxVariants: 100 }))
        .variants,
    ).toEqual([]);
    expect(
      (await transformer.transform({ originalQuery: "word ".repeat(900) }))
        .variants,
    ).toEqual([]);
  });
  it("does not produce an unsupported generic variant without unique anchor", async () => {
    const result = await transformer.transform({
      originalQuery: "How many sealed folders are in the archive?",
    });
    expect(result.variants).toEqual([]);
  });
});
