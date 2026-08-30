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
    expect(result[0]?.reasons).toEqual(
      expect.arrayContaining(["lexical", "graph"]),
    );
  });

  it("does not let duplicate rows in one channel inflate a document", () => {
    const withDuplicate = reciprocalRankFusion([
      [
        { id: "a", rank: 1, reason: "lexical-unit-1" },
        { id: "a", rank: 2, reason: "lexical-unit-2" },
        { id: "b", rank: 3, reason: "lexical" },
      ],
      [{ id: "b", rank: 1, reason: "graph" }],
    ]);

    // The second occurrence of `a` is ignored; `b` still wins because it has
    // independent support from the graph channel.
    expect(withDuplicate.map((item) => item.id)).toEqual(["b", "a"]);
    expect(withDuplicate.find((item) => item.id === "a")?.reasons).toEqual([
      "lexical-unit-1",
    ]);
  });

  it("rejects malformed ranks, weights and identifiers", () => {
    expect(() =>
      reciprocalRankFusion([[{ id: "a", rank: 0, reason: "bad" }]]),
    ).toThrow(/positive integer/);
    expect(() =>
      reciprocalRankFusion([[{ id: "a", rank: 1.5, reason: "bad" }]]),
    ).toThrow(/positive integer/);
    expect(() =>
      reciprocalRankFusion([
        [{ id: "a", rank: 1, weight: Number.NaN, reason: "bad" }],
      ]),
    ).toThrow(/finite/);
    expect(() =>
      reciprocalRankFusion([[{ id: "", rank: 1, reason: "bad" }]]),
    ).toThrow(/non-empty/);
  });
});
