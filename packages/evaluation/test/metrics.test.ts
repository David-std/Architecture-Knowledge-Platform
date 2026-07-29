import { describe, expect, it } from "vitest";
import { scoreRetrieval } from "../src/index.js";

describe("retrieval metrics", () => {
  it("computes recall and reciprocal rank", () => {
    const score = scoreRetrieval(
      {
        caseId: "x",
        rankedDocumentIds: ["noise", "gold"],
        goldDocumentIds: ["gold"],
      },
      5,
    );
    expect(score.recallAtK).toBe(1);
    expect(score.reciprocalRank).toBe(0.5);
  });
});
