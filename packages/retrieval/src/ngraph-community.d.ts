declare module "ngraph.graph" {
  export interface NGraphLinkData {
    weight?: number;
  }

  export interface NGraphLink {
    data?: NGraphLinkData;
  }

  export interface NGraph {
    addNode(id: string): unknown;
    addLink(fromId: string, toId: string, data?: NGraphLinkData): unknown;
  }

  export default function createGraph(): NGraph;
}

declare module "ngraph.leiden" {
  import type { NGraph, NGraphLink } from "ngraph.graph";

  export interface LeidenOptions {
    quality?: "modularity" | "cpm";
    resolution?: number;
    directed?: boolean;
    randomSeed?: number;
    candidateStrategy?: "neighbors" | "all" | "random" | "random-neighbor";
    allowNewCommunity?: boolean;
    refine?: boolean;
    maxCommunitySize?: number;
    linkWeight?: (link: NGraphLink) => number;
  }

  export interface LeidenClusters {
    getClass(nodeId: string): number | undefined;
    getCommunities(): Map<number, string[]>;
    quality(): number;
    toJSON(): {
      membership: Record<string, number>;
      meta: {
        levels: number;
        quality: number;
        options: LeidenOptions;
      };
    };
  }

  export function detectClusters(
    graph: NGraph,
    options?: LeidenOptions,
  ): LeidenClusters;
}
