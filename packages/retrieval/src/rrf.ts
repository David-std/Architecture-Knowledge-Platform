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
  if (!Number.isFinite(k) || k <= 0) throw new Error("k must be positive");
  const scores = new Map<string, FusedItem>();

  for (const list of lists) {
    // A retrieval adapter may return a duplicate row when a document has
    // several matching units.  Counting that row twice would make one
    // channel look stronger than it is and can swamp independent signals.
    // Keep the strongest occurrence per document within each ranked list.
    const unique = new Map<string, RankedItem>();
    for (const item of list) {
      if (!Number.isInteger(item.rank) || item.rank < 1)
        throw new Error("rank must be a positive integer");
      if (typeof item.id !== "string" || item.id.trim() === "")
        throw new Error("id must be a non-empty string");
      if (
        item.weight !== undefined &&
        (!Number.isFinite(item.weight) || item.weight < 0)
      )
        throw new Error("weight must be finite and non-negative");
      const current = unique.get(item.id);
      const contribution = (candidate: RankedItem): number =>
        (candidate.weight ?? 1) / (k + candidate.rank);
      if (!current || contribution(item) > contribution(current)) {
        unique.set(item.id, item);
      }
    }
    for (const item of unique.values()) {
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
