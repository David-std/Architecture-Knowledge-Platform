import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import createGraph from "ngraph.graph";

interface LeidenLink {
  data?: { weight?: number };
}

interface LeidenClusters {
  getClass(nodeId: string): number | undefined;
  getCommunities(): Map<number, string[]>;
  quality(): number;
  toJSON(): {
    membership: Record<string, number>;
    meta: {
      levels: number;
      quality: number;
      options: Record<string, unknown>;
    };
  };
}

interface LeidenModule {
  detectClusters(
    graph: unknown,
    options: {
      quality: "cpm";
      resolution: number;
      randomSeed: number;
      refine: boolean;
      candidateStrategy: "neighbors";
      directed: boolean;
      linkWeight: (link: LeidenLink) => number;
    },
  ): LeidenClusters;
}

const requireForResolution = createRequire(import.meta.url);
const leidenPackageEntry = requireForResolution.resolve("ngraph.leiden");
const leidenEsmEntry = join(dirname(leidenPackageEntry), "ngraph-leiden.es.js");
const { detectClusters } = (await import(
  pathToFileURL(leidenEsmEntry).href
)) as LeidenModule;

export const COMMUNITY_ALGORITHM = "LEIDEN";
export const COMMUNITY_ALGORITHM_VERSION = "ngraph.leiden@0.3.0";
export const COMMUNITY_OBJECTIVE = "CPM" as const;
export const DEFAULT_COMMUNITY_RESOLUTION = 0.5;
export const DEFAULT_COMMUNITY_RANDOM_SEED = 42;

export interface CommunityGraphNode {
  id: string;
}

export interface CommunityGraphEdge {
  id: string;
  from: string;
  to: string;
  weight?: number;
}

export interface CommunityPartitionOptions {
  resolution?: number;
  randomSeed?: number;
}

export interface CommunityMembership {
  nodeId: string;
  communityKey: string;
  rawCommunity: number;
}

export interface DetectedCommunity {
  communityKey: string;
  ordinal: number;
  memberNodeIds: string[];
  supportEdgeIds: string[];
  hierarchy: {
    levelCount: number;
    finalOrdinal: number;
  };
}

export interface CommunityPartition {
  algorithm: typeof COMMUNITY_ALGORITHM;
  algorithmVersion: typeof COMMUNITY_ALGORITHM_VERSION;
  objective: typeof COMMUNITY_OBJECTIVE;
  resolution: number;
  randomSeed: number;
  quality: number;
  hierarchy: {
    levelCount: number;
    finalCommunities: number;
  };
  memberships: CommunityMembership[];
  communities: DetectedCommunity[];
}

function stableCommunityKey(memberNodeIds: readonly string[]): string {
  const digest = createHash("sha256")
    .update([...memberNodeIds].sort().join("\n"))
    .digest("hex")
    .slice(0, 20);
  return `community:${digest}`;
}

function positiveWeight(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.max(0, value);
}

/**
 * Deterministic Leiden partition over an already-authorized graph projection.
 *
 * Community ids emitted by the upstream algorithm are ephemeral. Durable
 * identities are derived from sorted member ids so rebuilds with identical
 * inputs produce the same community keys.
 */
export function detectLeidenCommunities(
  nodes: readonly CommunityGraphNode[],
  edges: readonly CommunityGraphEdge[],
  options: CommunityPartitionOptions = {},
): CommunityPartition {
  const resolution = options.resolution ?? DEFAULT_COMMUNITY_RESOLUTION;
  const randomSeed = options.randomSeed ?? DEFAULT_COMMUNITY_RANDOM_SEED;
  if (!Number.isFinite(resolution) || resolution <= 0) {
    throw new Error("COMMUNITY_RESOLUTION_INVALID");
  }
  if (!Number.isInteger(randomSeed)) {
    throw new Error("COMMUNITY_RANDOM_SEED_INVALID");
  }

  const graph = createGraph();
  const nodeIds = [
    ...new Set(nodes.map((node) => node.id).filter(Boolean)),
  ].sort();
  for (const nodeId of nodeIds) graph.addNode(nodeId);

  const knownNodes = new Set(nodeIds);
  const normalizedEdges = edges
    .filter(
      (edge) =>
        edge.id &&
        knownNodes.has(edge.from) &&
        knownNodes.has(edge.to) &&
        edge.from !== edge.to,
    )
    .map((edge) => ({ ...edge, weight: positiveWeight(edge.weight) }))
    .filter((edge) => edge.weight > 0)
    .sort((left, right) =>
      [left.from, left.to, left.id]
        .join("\0")
        .localeCompare([right.from, right.to, right.id].join("\0")),
    );

  for (const edge of normalizedEdges) {
    graph.addLink(edge.from, edge.to, { weight: edge.weight });
  }

  if (nodeIds.length === 0) {
    return {
      algorithm: COMMUNITY_ALGORITHM,
      algorithmVersion: COMMUNITY_ALGORITHM_VERSION,
      objective: COMMUNITY_OBJECTIVE,
      resolution,
      randomSeed,
      quality: 0,
      hierarchy: { levelCount: 0, finalCommunities: 0 },
      memberships: [],
      communities: [],
    };
  }

  const clusters = detectClusters(graph, {
    quality: "cpm",
    resolution,
    randomSeed,
    refine: true,
    candidateStrategy: "neighbors",
    directed: false,
    linkWeight: (link) => positiveWeight(link.data?.weight),
  });
  const serialized = clusters.toJSON();

  const grouped = [...clusters.getCommunities().entries()]
    .map(([rawCommunity, members]) => ({
      rawCommunity,
      members: [...members].sort(),
    }))
    .sort((left, right) =>
      left.members.join("\0").localeCompare(right.members.join("\0")),
    );

  const communities = grouped.map((group, ordinal) => {
    const communityKey = stableCommunityKey(group.members);
    const memberSet = new Set(group.members);
    const supportEdgeIds = normalizedEdges
      .filter((edge) => memberSet.has(edge.from) && memberSet.has(edge.to))
      .map((edge) => edge.id)
      .sort();
    return {
      communityKey,
      ordinal,
      memberNodeIds: group.members,
      supportEdgeIds,
      hierarchy: {
        levelCount: serialized.meta.levels,
        finalOrdinal: ordinal,
      },
    };
  });

  const stableByRaw = new Map(
    grouped.map((group, ordinal) => [
      group.rawCommunity,
      communities[ordinal]!.communityKey,
    ]),
  );
  const memberships = nodeIds.map((nodeId) => {
    const rawCommunity = clusters.getClass(nodeId);
    if (rawCommunity === undefined) {
      throw new Error(`COMMUNITY_MEMBERSHIP_MISSING:${nodeId}`);
    }
    const communityKey = stableByRaw.get(rawCommunity);
    if (!communityKey) {
      throw new Error(`COMMUNITY_IDENTITY_MISSING:${rawCommunity}`);
    }
    return { nodeId, communityKey, rawCommunity };
  });

  return {
    algorithm: COMMUNITY_ALGORITHM,
    algorithmVersion: COMMUNITY_ALGORITHM_VERSION,
    objective: COMMUNITY_OBJECTIVE,
    resolution,
    randomSeed,
    quality: clusters.quality(),
    hierarchy: {
      levelCount: serialized.meta.levels,
      finalCommunities: communities.length,
    },
    memberships,
    communities,
  };
}
