import { describe, expect, it } from "vitest";
import { detectLeidenCommunities } from "../src/community.js";

const nodes = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id }));
const edges = [
  { id: "ab", from: "a", to: "b", weight: 5 },
  { id: "ac", from: "a", to: "c", weight: 5 },
  { id: "bc", from: "b", to: "c", weight: 5 },
  { id: "de", from: "d", to: "e", weight: 5 },
  { id: "df", from: "d", to: "f", weight: 5 },
  { id: "ef", from: "e", to: "f", weight: 5 },
  { id: "bridge", from: "c", to: "d", weight: 0.01 },
];

describe("detectLeidenCommunities", () => {
  it("is deterministic and uses stable membership-derived community identities", () => {
    const first = detectLeidenCommunities(nodes, edges, {
      resolution: 0.5,
      randomSeed: 7,
    });
    const second = detectLeidenCommunities(
      [...nodes].reverse(),
      [...edges].reverse(),
      { resolution: 0.5, randomSeed: 7 },
    );

    expect(first.algorithm).toBe("LEIDEN");
    expect(first.algorithmVersion).toBe("ngraph.leiden@0.3.0");
    expect(first.objective).toBe("CPM");
    expect(first.hierarchy.levelCount).toBeGreaterThan(0);
    expect(first.communities).toHaveLength(2);
    expect(first).toEqual(second);

    const byNode = new Map(
      first.memberships.map((membership) => [
        membership.nodeId,
        membership.communityKey,
      ]),
    );
    expect(byNode.get("a")).toBe(byNode.get("b"));
    expect(byNode.get("a")).toBe(byNode.get("c"));
    expect(byNode.get("d")).toBe(byNode.get("e"));
    expect(byNode.get("d")).toBe(byNode.get("f"));
    expect(byNode.get("a")).not.toBe(byNode.get("d"));
    expect(
      first.communities.every((community) =>
        community.communityKey.startsWith("community:"),
      ),
    ).toBe(true);
    expect(
      first.communities.flatMap((community) => community.supportEdgeIds),
    ).not.toContain("bridge");
  });

  it("represents an empty graph without inventing communities", () => {
    expect(detectLeidenCommunities([], [])).toMatchObject({
      quality: 0,
      hierarchy: { levelCount: 0, finalCommunities: 0 },
      memberships: [],
      communities: [],
    });
  });

  it("rejects invalid rebuild configuration", () => {
    expect(() =>
      detectLeidenCommunities(nodes, edges, { resolution: 0 }),
    ).toThrow("COMMUNITY_RESOLUTION_INVALID");
    expect(() =>
      detectLeidenCommunities(nodes, edges, { randomSeed: 1.5 }),
    ).toThrow("COMMUNITY_RANDOM_SEED_INVALID");
  });
});
