import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "../src/rrf.js";

describe("reciprocalRankFusion", () => {
  it("rewards documents supported by multiple signals", () => {
    const result = reciprocalRankFusion([
      [
        { id: "a", rank: 1, reason: "lexical" },
        { id: "b", rank: 2, reason: "lexical" },
      ],
      [
        { id: "b", rank: 1, reason: "graph" },
        { id: "c", rank: 2, reason: "graph" },
      ],
    ]);

    expect(result[0]?.id).toBe("b");
    expect(result[0]?.reasons).toEqual(expect.arrayContaining(["lexical", "graph"]));
  });
});
