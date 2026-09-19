declare module "ngraph.leiden" {
  export interface LeidenOptions {
    quality?: "modularity" | "cpm";
    resolution?: number;
    directed?: boolean;
    randomSeed?: number;
    candidateStrategy?: "neighbors" | "all" | "random" | "random-neighbor";
    allowNewCommunity?: boolean;
    refine?: boolean;
    maxCommunitySize?: number;
    linkWeight?: (link: { data?: { weight?: number } }) => number;
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
    graph: unknown,
    options?: LeidenOptions,
  ): LeidenClusters;
}
