import { describe, expect, it } from "vitest";
import { reciprocalRankFusion, type RankedItem } from "../src/rrf.js";

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

  it("uses channel weight and rank, preserving structured provenance", () => {
    const result = reciprocalRankFusion([
      {
        channel: "lexical",
        channelWeight: 2,
        items: [
          {
            id: "a",
            rank: 2,
            reason: "title-term",
            candidateRevision: "rev-1",
          },
        ],
      },
      {
        channel: "graph",
        channelWeight: 4,
        items: [
          {
            id: "a",
            rank: 1,
            reason: "dependency-edge",
            candidateRevision: "rev-2",
          },
        ],
      },
    ]);

    expect(result[0]).toMatchObject({
      id: "a",
      score: 4 / 61 + 2 / 62,
      reasons: ["dependency-edge", "title-term"],
    });
    expect(result[0]?.contributions).toEqual([
      {
        channel: "graph",
        rank: 1,
        channelWeight: 4,
        reason: "dependency-edge",
        candidateRevision: "rev-2",
      },
      {
        channel: "lexical",
        rank: 2,
        channelWeight: 2,
        reason: "title-term",
        candidateRevision: "rev-1",
      },
    ]);
  });

  it("deduplicates a candidate across lists belonging to the same channel", () => {
    const result = reciprocalRankFusion([
      {
        channel: "lexical",
        items: [
          {
            id: "a",
            rank: 4,
            reason: "body-term",
            candidateRevision: "old",
          },
        ],
      },
      {
        channel: "lexical",
        items: [
          {
            id: "a",
            rank: 1,
            reason: "title-term",
            candidateRevision: "new",
          },
        ],
      },
      {
        channel: "graph",
        items: [{ id: "b", rank: 1, reason: "edge" }],
      },
    ]);

    expect(result.find((item) => item.id === "a")).toMatchObject({
      score: 1 / 61,
      reasons: ["title-term"],
      contributions: [
        expect.objectContaining({
          channel: "lexical",
          rank: 1,
          candidateRevision: "new",
        }),
      ],
    });
  });

  it("ignores a raw score and keeps equal-score ties deterministic", () => {
    const withRawScore = {
      id: "a",
      rank: 1,
      channel: "lexical",
      channelWeight: 1,
      reason: "title",
      score: 100000,
    } as unknown as RankedItem;
    const result = reciprocalRankFusion([
      {
        channel: "lexical",
        items: [withRawScore],
      },
      {
        channel: "vector",
        items: [{ id: "b", rank: 1, channelWeight: 1, reason: "embedding" }],
      },
    ]);

    expect(result).toEqual([
      expect.objectContaining({
        id: "a",
        score: 1 / 61,
      }),
      expect.objectContaining({
        id: "b",
        score: 1 / 61,
      }),
    ]);
  });

  it("uses deterministic tie-breakers for duplicate records", () => {
    const forward = reciprocalRankFusion([
      {
        channel: "lexical",
        items: [
          {
            id: "a",
            rank: 1,
            channelWeight: 1,
            reason: "z-reason",
            candidateRevision: "z-revision",
          },
          {
            id: "a",
            rank: 1,
            channelWeight: 1,
            reason: "a-reason",
            candidateRevision: "a-revision",
          },
        ],
      },
    ]);
    const reversed = reciprocalRankFusion([
      {
        channel: "lexical",
        items: [
          {
            id: "a",
            rank: 1,
            channelWeight: 1,
            reason: "a-reason",
            candidateRevision: "a-revision",
          },
          {
            id: "a",
            rank: 1,
            channelWeight: 1,
            reason: "z-reason",
            candidateRevision: "z-revision",
          },
        ],
      },
    ]);

    expect(forward).toEqual(reversed);
    expect(forward[0]?.contributions[0]).toMatchObject({
      reason: "a-reason",
      candidateRevision: "a-revision",
    });
  });

  it("is independent of the order in which channels are supplied", () => {
    const lexical = {
      channel: "lexical",
      items: [{ id: "a", rank: 2, channelWeight: 2, reason: "title" }],
    };
    const graph = {
      channel: "graph",
      items: [{ id: "a", rank: 1, channelWeight: 1, reason: "edge" }],
    };

    expect(reciprocalRankFusion([lexical, graph])).toEqual(
      reciprocalRankFusion([graph, lexical]),
    );
  });
});
