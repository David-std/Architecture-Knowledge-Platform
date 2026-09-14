import { describe, expect, it } from "vitest";
import type { KnowledgeRelation } from "@akp/domain";
import { expandGraph } from "../src/index.js";

describe("graph hop decay", () => {
  it("applies one decay factor per traversed edge", () => {
    const relations: KnowledgeRelation[] = [
      {
        from: "A",
        to: "B",
        type: "requires",
        weight: 1,
        source: "deterministic",
      },
      {
        from: "B",
        to: "C",
        type: "requires",
        weight: 1,
        source: "deterministic",
      },
      {
        from: "C",
        to: "D",
        type: "requires",
        weight: 1,
        source: "deterministic",
      },
    ];
    const expanded = expandGraph(relations, {
      seeds: ["A"],
      maxHops: 3,
      allowedTypes: ["requires"],
      relationWeights: {},
      decay: 0.5,
    });
    const score = (id: string) =>
      expanded.find((node) => node.id === id)?.score;
    expect(score("B")).toBeCloseTo(0.5);
    expect(score("C")).toBeCloseTo(0.25);
    expect(score("D")).toBeCloseTo(0.125);
  });
});
