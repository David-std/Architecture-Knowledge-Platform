import type { KnowledgeRelation, RelationType } from "@akp/domain";

export interface GraphExpansionOptions {
  seeds: readonly string[];
  maxHops: number;
  allowedTypes: readonly RelationType[];
  relationWeights: Partial<Record<RelationType, number>>;
  decay: number;
}

export interface ExpandedNode {
  id: string;
  score: number;
  paths: string[][];
}

export function expandGraph(
  relations: readonly KnowledgeRelation[],
  options: GraphExpansionOptions,
): ExpandedNode[] {
  const adjacency = new Map<string, KnowledgeRelation[]>();
  for (const relation of relations) {
    if (!options.allowedTypes.includes(relation.type)) continue;
    const list = adjacency.get(relation.from) ?? [];
    list.push(relation);
    adjacency.set(relation.from, list);
  }

  const scores = new Map<string, ExpandedNode>();
  let frontier = options.seeds.map((id) => ({ id, path: [id], score: 1 }));

  for (let hop = 0; hop < options.maxHops; hop += 1) {
    const next: typeof frontier = [];
    for (const current of frontier) {
      for (const edge of adjacency.get(current.id) ?? []) {
        if (current.path.includes(edge.to)) continue;
        const score =
          current.score *
          (options.relationWeights[edge.type] ?? 1) *
          edge.weight *
          Math.pow(options.decay, hop + 1);
        const existing = scores.get(edge.to) ?? {
          id: edge.to,
          score: 0,
          paths: [],
        };
        existing.score += score;
        existing.paths.push([...current.path, edge.to]);
        scores.set(edge.to, existing);
        next.push({ id: edge.to, path: [...current.path, edge.to], score });
      }
    }
    frontier = next;
  }

  return [...scores.values()].sort((a, b) => b.score - a.score);
}
