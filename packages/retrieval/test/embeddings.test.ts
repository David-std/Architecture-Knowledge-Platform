import { describe, expect, it } from "vitest";
import { deterministicEmbedding } from "../src/embeddings.js";

describe("deterministic embedding adapter", () => {
  it("is stable, normalized and provider-free", () => {
    const first = deterministicEmbedding("bounded context");
    const second = deterministicEmbedding("bounded context");
    expect(first).toEqual(second);
    expect(first).toHaveLength(64);
    expect(
      Math.sqrt(first.reduce((sum, value) => sum + value * value, 0)),
    ).toBeCloseTo(1);
  });
});
