/** A ranked candidate emitted by one retrieval channel. */
export interface RankedItem {
  id: string;
  rank: number;
  /** Explicit channel name; useful when several lists share one channel. */
  channel?: string;
  /** Weight of this channel contribution. */
  channelWeight?: number;
  /** Legacy alias retained for existing adapters; never a raw retrieval score. */
  weight?: number;
  reason: string;
  candidateRevision?: string | null;
}

/** Preferred production input: a named ranked list with one channel weight. */
export interface RankedChannel {
  channel: string;
  items: readonly RankedItem[];
  channelWeight?: number;
}

export interface RrfContribution {
  channel: string;
  rank: number;
  channelWeight: number;
  reason: string;
  candidateRevision?: string | null;
}

export interface FusedItem {
  id: string;
  score: number;
  reasons: string[];
  /** One contribution per candidate/channel after within-channel dedupe. */
  contributions: RrfContribution[];
}

export interface RrfOptions {
  /** RRF's stabilizing constant; defaults to 60. */
  k?: number;
}

export type RankedList = readonly RankedItem[] | RankedChannel;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRankedChannel(value: RankedList): value is RankedChannel {
  return !Array.isArray(value) && typeof value === "object" && value !== null;
}

function validateChannelName(channel: unknown): asserts channel is string {
  if (typeof channel !== "string" || channel.trim() === "") {
    throw new Error("channel must be a non-empty string");
  }
}

function validateReason(reason: unknown): asserts reason is string {
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new Error("reason must be a non-empty string");
  }
}

function validateWeight(weight: unknown, fieldName: string): number {
  if (weight === undefined) return 1;
  if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
    throw new Error(`${fieldName} must be finite and non-negative`);
  }
  return weight;
}

function candidateRevisionKey(revision: string | null | undefined): string {
  return revision === undefined
    ? "<undefined>"
    : revision === null
      ? "<null>"
      : revision;
}

interface NormalizedRankedItem extends RankedItem {
  channel: string;
  channelWeight: number;
  k: number;
}

function compareCandidateRecords(
  left: NormalizedRankedItem,
  right: NormalizedRankedItem,
): number {
  // Prefer the strongest RRF contribution. Remaining fields make ties
  // independent from adapter/input order.
  return (
    right.channelWeight / (left.k + right.rank) -
      left.channelWeight / (left.k + left.rank) ||
    left.rank - right.rank ||
    right.channelWeight - left.channelWeight ||
    compareStrings(left.reason, right.reason) ||
    compareStrings(
      candidateRevisionKey(left.candidateRevision),
      candidateRevisionKey(right.candidateRevision),
    ) ||
    compareStrings(left.id, right.id)
  );
}

function normalizeRankedItem(
  item: RankedItem,
  channel: string,
  channelWeight: number | undefined,
  k: number,
): NormalizedRankedItem {
  if (!item || typeof item !== "object") {
    throw new Error("ranked item must be an object");
  }
  if (typeof item.id !== "string" || item.id.trim() === "") {
    throw new Error("id must be a non-empty string");
  }
  if (!Number.isInteger(item.rank) || item.rank < 1) {
    throw new Error("rank must be a positive integer");
  }
  validateReason(item.reason);
  validateChannelName(channel);
  const itemChannel =
    item.channel === undefined
      ? channel.trim()
      : typeof item.channel === "string" && item.channel.trim() !== ""
        ? item.channel.trim()
        : (() => {
            throw new Error("channel must be a non-empty string");
          })();
  if (
    item.candidateRevision !== undefined &&
    item.candidateRevision !== null &&
    (typeof item.candidateRevision !== "string" ||
      item.candidateRevision.trim() === "")
  ) {
    throw new Error("candidateRevision must be a non-empty string or null");
  }

  // Only channelWeight (or the legacy weight alias) enters RRF. Arbitrary raw
  // retrieval scores are intentionally not part of RankedItem and are ignored.
  const weight = validateWeight(
    item.channelWeight ?? item.weight ?? channelWeight,
    "channelWeight",
  );
  return {
    ...item,
    channel: itemChannel,
    channelWeight: weight,
    k,
  };
}

function normalizeLists(
  lists: readonly RankedList[],
  k: number,
): NormalizedRankedItem[] {
  const normalized: NormalizedRankedItem[] = [];
  for (const [listIndex, list] of lists.entries()) {
    if (isRankedChannel(list)) {
      validateChannelName(list.channel);
      if (!Array.isArray(list.items)) {
        throw new Error("channel items must be an array");
      }
      const channelWeight = validateWeight(list.channelWeight, "channelWeight");
      for (const item of list.items) {
        normalized.push(
          normalizeRankedItem(item, list.channel.trim(), channelWeight, k),
        );
      }
      continue;
    }

    // Legacy callers pass one array per channel. A stable synthetic channel
    // keeps duplicate rows in that list from inflating a candidate.
    if (!Array.isArray(list)) {
      throw new Error("ranked channel must be an array");
    }
    const legacyChannel = `legacy-${listIndex + 1}`;
    for (const item of list) {
      normalized.push(normalizeRankedItem(item, legacyChannel, undefined, k));
    }
  }
  return normalized;
}

/**
 * Fuse ranked channel outputs using reciprocal-rank fusion.
 *
 * Raw scores are deliberately absent from the calculation. Each candidate
 * contributes at most once per channel, using channelWeight / (k + rank).
 * Structured RankedChannel inputs are preferred; the legacy array-of-arrays
 * form remains supported for existing adapters.
 */
export function reciprocalRankFusion(
  lists: readonly RankedList[],
  kOrOptions: number | RrfOptions = 60,
): FusedItem[] {
  const k = typeof kOrOptions === "number" ? kOrOptions : (kOrOptions.k ?? 60);
  if (!Number.isFinite(k) || k <= 0) throw new Error("k must be positive");

  const normalized = normalizeLists(lists, k);
  const byChannelAndCandidate = new Map<
    string,
    Map<string, NormalizedRankedItem>
  >();
  for (const item of normalized) {
    const candidates =
      byChannelAndCandidate.get(item.channel) ??
      new Map<string, NormalizedRankedItem>();
    const current = candidates.get(item.id);
    if (!current || compareCandidateRecords(item, current) < 0) {
      candidates.set(item.id, item);
    }
    byChannelAndCandidate.set(item.channel, candidates);
  }

  const fused = new Map<string, FusedItem>();
  for (const [channel, candidates] of byChannelAndCandidate) {
    for (const item of candidates.values()) {
      const contribution: RrfContribution = {
        channel,
        rank: item.rank,
        channelWeight: item.channelWeight,
        reason: item.reason,
        ...(item.candidateRevision !== undefined
          ? { candidateRevision: item.candidateRevision }
          : {}),
      };
      const current = fused.get(item.id) ?? {
        id: item.id,
        score: 0,
        reasons: [],
        contributions: [],
      };
      current.score += item.channelWeight / (k + item.rank);
      current.contributions.push(contribution);
      fused.set(item.id, current);
    }
  }

  for (const item of fused.values()) {
    item.contributions.sort(
      (left, right) =>
        compareStrings(left.channel, right.channel) ||
        left.rank - right.rank ||
        right.channelWeight - left.channelWeight ||
        compareStrings(left.reason, right.reason) ||
        compareStrings(
          candidateRevisionKey(left.candidateRevision),
          candidateRevisionKey(right.candidateRevision),
        ),
    );
    // Sum in canonical contribution order so input channel order cannot
    // change floating-point rounding or tie ordering.
    item.score = item.contributions.reduce(
      (sum, contribution) =>
        sum + contribution.channelWeight / (k + contribution.rank),
      0,
    );
    item.reasons = [
      ...new Set(item.contributions.map((entry) => entry.reason)),
    ];
  }

  return [...fused.values()].sort(
    (left, right) =>
      right.score - left.score || compareStrings(left.id, right.id),
  );
}
