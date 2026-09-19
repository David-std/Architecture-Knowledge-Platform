import { describe, expect, it } from "vitest";
import {
  DeterministicQueryDecomposer,
  validateQueryTransformationResult,
} from "../src/query-transform.js";

describe("query transformation port", () => {
  it("decomposes only on strong technical delimiters", async () => {
    const transformer = new DeterministicQueryDecomposer();
    const result = await transformer.transform({
      originalQuery:
        "TLS rotation policy; JWT signing keys vs OAuth client secrets",
      maxVariants: 4,
    });

    expect(result).toEqual({
      transformerId: "deterministic-query-decomposition-v1",
      originalQuery:
        "TLS rotation policy; JWT signing keys vs OAuth client secrets",
      variants: [
        {
          ordinal: 1,
          kind: "DECOMPOSITION",
          query: "TLS rotation policy",
          reason: "strong-delimiter decomposition",
        },
        {
          ordinal: 2,
          kind: "DECOMPOSITION",
          query: "JWT signing keys",
          reason: "strong-delimiter decomposition",
        },
        {
          ordinal: 3,
          kind: "DECOMPOSITION",
          query: "OAuth client secrets",
          reason: "strong-delimiter decomposition",
        },
      ],
    });
  });

  it("does not rewrite a simple query merely because it contains prose conjunctions", async () => {
    const transformer = new DeterministicQueryDecomposer();
    const result = await transformer.transform({
      originalQuery: "authentication and authorization boundaries",
    });
    expect(result.variants).toEqual([]);
  });

  it("rejects a transformer that changes the original query", () => {
    expect(() =>
      validateQueryTransformationResult(
        {
          transformerId: "unsafe",
          originalQuery: "changed",
          variants: [],
        },
        "original",
      ),
    ).toThrow("QUERY_TRANSFORM_ORIGINAL_QUERY_CHANGED");
  });

  it("rejects duplicate transformed variants", () => {
    expect(() =>
      validateQueryTransformationResult(
        {
          transformerId: "unsafe",
          originalQuery: "original query",
          variants: [
            {
              ordinal: 1,
              kind: "DECOMPOSITION",
              query: "TLS policy",
              reason: "test",
            },
            {
              ordinal: 2,
              kind: "DECOMPOSITION",
              query: "tls policy",
              reason: "test",
            },
          ],
        },
        "original query",
      ),
    ).toThrow("QUERY_TRANSFORM_VARIANT_DUPLICATE");
  });
});
