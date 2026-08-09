export interface RankedItem {
  id: string;
  rank: number;
  weight?: number;
  reason: string;
}

export interface FusedItem {
  id: string;
  score: number;
  reasons: string[];
}

export function reciprocalRankFusion(
  lists: readonly (readonly RankedItem[])[],
  k = 60,
): FusedItem[] {
  if (k <= 0) throw new Error("k must be positive");
  const scores = new Map<string, FusedItem>();

  for (const list of lists) {
    for (const item of list) {
      if (item.rank < 1) throw new Error("rank must start at 1");
      const current = scores.get(item.id) ?? {
        id: item.id,
        score: 0,
        reasons: [],
      };
      current.score += (item.weight ?? 1) / (k + item.rank);
      current.reasons.push(item.reason);
      scores.set(item.id, current);
    }
  }

  return [...scores.values()].sort(
    (a, b) => b.score - a.score || a.id.localeCompare(b.id),
  );
}
