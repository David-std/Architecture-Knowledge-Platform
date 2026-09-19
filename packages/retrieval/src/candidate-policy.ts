import type { RankedChannel } from "./rrf.js";
import type { RetrievalChannel } from "./query-planner.js";

export type RetrievalCandidateChannel =
  | "EXACT"
  | "LEXICAL"
  | "VECTOR"
  | "NEURAL_SPARSE"
  | "LATE_INTERACTION"
  | "GRAPH_TYPED"
  | "GRAPH_PPR"
  | "COMMUNITY"
  | "CODE"
  | "TEMPORAL"
  | "RAW"
  | "CONTEXT_PACK";

export interface RetrievalCandidate {
  candidateId: string;
  channel: RetrievalCandidateChannel;
  rank: number;
  rawScore?: number;
  scopeId: string;
  documentId?: string;
  unitId?: string;
  revision: string;
  supportSetId?: string;
  selectionReason: unknown;
}

export interface RetrievalChannelPolicy {
  enabled: boolean;
  weight?: number;
}

export interface RetrievalPolicy {
  channels: Record<RetrievalCandidateChannel, RetrievalChannelPolicy>;
  exactFirst: boolean;
  maxCandidatesPerChannel: number;
  fusion: "RRF" | "WEIGHTED_RRF";
  reranker?: string;
  truthValidation: "STRICT" | "BEST_EFFORT";
  graphMode?: "LOCAL" | "GLOBAL" | "DRIFT" | "ASSOCIATIVE";
  contextLevel: "L0" | "L1" | "L2" | "L3";
}

export type RetrievalPolicyInput = Omit<
  Partial<RetrievalPolicy>,
  "channels"
> & {
  channels?: Partial<
    Record<RetrievalCandidateChannel, Partial<RetrievalChannelPolicy>>
  >;
};

export const RETRIEVAL_CANDIDATE_CHANNELS: readonly RetrievalCandidateChannel[] =
  [
    "EXACT",
    "LEXICAL",
    "VECTOR",
    "NEURAL_SPARSE",
    "LATE_INTERACTION",
    "GRAPH_TYPED",
    "GRAPH_PPR",
    "COMMUNITY",
    "CODE",
    "TEMPORAL",
    "RAW",
    "CONTEXT_PACK",
  ] as const;

const DEFAULT_CHANNELS: Record<
  RetrievalCandidateChannel,
  RetrievalChannelPolicy
> = {
  EXACT: { enabled: true, weight: 3 },
  LEXICAL: { enabled: true, weight: 1.5 },
  VECTOR: { enabled: true, weight: 1 },
  NEURAL_SPARSE: { enabled: false, weight: 1 },
  LATE_INTERACTION: { enabled: false, weight: 1 },
  GRAPH_TYPED: { enabled: true, weight: 1.4 },
  GRAPH_PPR: { enabled: false, weight: 1 },
  COMMUNITY: { enabled: false, weight: 1 },
  CODE: { enabled: true, weight: 1.2 },
  TEMPORAL: { enabled: false, weight: 1 },
  RAW: { enabled: true, weight: 1.2 },
  CONTEXT_PACK: { enabled: true, weight: 2.5 },
};

export const DEFAULT_RETRIEVAL_POLICY: RetrievalPolicy = {
  channels: DEFAULT_CHANNELS,
  exactFirst: true,
  maxCandidatesPerChannel: 1000,
  fusion: "WEIGHTED_RRF",
  truthValidation: "STRICT",
  graphMode: "LOCAL",
  // Compatibility default for the current bounded full-context assembler.
  // Progressive L0-L3 assembly semantics are introduced separately in P6.14.
  contextLevel: "L2",
};

const RUNTIME_TO_CANDIDATE: Record<
  RetrievalChannel,
  RetrievalCandidateChannel
> = {
  "context-pack": "CONTEXT_PACK",
  exact: "EXACT",
  lexical: "LEXICAL",
  vector: "VECTOR",
  graph: "GRAPH_TYPED",
  raw: "RAW",
  code: "CODE",
};

const CANDIDATE_TO_RRF_CHANNEL: Record<
  RetrievalCandidateChannel,
  string
> = {
  EXACT: "exact",
  LEXICAL: "lexical",
  VECTOR: "vector",
  NEURAL_SPARSE: "neural-sparse",
  LATE_INTERACTION: "late-interaction",
  GRAPH_TYPED: "graph",
  GRAPH_PPR: "graph-ppr",
  COMMUNITY: "community",
  CODE: "code",
  TEMPORAL: "temporal",
  RAW: "raw",
  CONTEXT_PACK: "context-pack",
};

const FUSION_VALUES = new Set<RetrievalPolicy["fusion"]>([
  "RRF",
  "WEIGHTED_RRF",
]);
const TRUTH_VALUES = new Set<RetrievalPolicy["truthValidation"]>([
  "STRICT",
  "BEST_EFFORT",
]);
const GRAPH_MODES = new Set<NonNullable<RetrievalPolicy["graphMode"]>>([
  "LOCAL",
  "GLOBAL",
  "DRIFT",
  "ASSOCIATIVE",
]);
const CONTEXT_LEVELS = new Set<RetrievalPolicy["contextLevel"]>([
  "L0",
  "L1",
  "L2",
  "L3",
]);

function validWeight(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be finite and non-negative`);
  }
  return value;
}

function reasonText(
  reason: unknown,
  channel: RetrievalCandidateChannel,
): string {
  if (typeof reason === "string" && reason.trim() !== "") return reason.trim();
  return `${CANDIDATE_TO_RRF_CHANNEL[channel]}:structured-reason`;
}

function validateCandidate(candidate: RetrievalCandidate): void {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("retrieval candidate must be an object");
  }
  if (
    typeof candidate.candidateId !== "string" ||
    candidate.candidateId.trim() === ""
  ) {
    throw new Error("candidateId must be a non-empty string");
  }
  if (!RETRIEVAL_CANDIDATE_CHANNELS.includes(candidate.channel)) {
    throw new Error("candidate channel is invalid");
  }
  if (!Number.isInteger(candidate.rank) || candidate.rank < 1) {
    throw new Error("candidate rank must be a positive integer");
  }
  if (
    candidate.rawScore !== undefined &&
    (typeof candidate.rawScore !== "number" || !Number.isFinite(candidate.rawScore))
  ) {
    throw new Error("rawScore must be finite when provided");
  }
  if (typeof candidate.scopeId !== "string" || candidate.scopeId.trim() === "") {
    throw new Error("scopeId must be a non-empty string");
  }
  if (
    typeof candidate.revision !== "string" ||
    candidate.revision.trim() === ""
  ) {
    throw new Error("revision must be a non-empty string");
  }
}

export function candidateChannelForRuntimeChannel(
  channel: RetrievalChannel,
): RetrievalCandidateChannel {
  return RUNTIME_TO_CANDIDATE[channel];
}

export function runtimeChannelEnabled(
  policy: RetrievalPolicy,
  channel: RetrievalChannel,
): boolean {
  return policy.channels[candidateChannelForRuntimeChannel(channel)].enabled;
}

export function resolveRetrievalPolicy(
  input: RetrievalPolicyInput = {},
): RetrievalPolicy {
  if (input.exactFirst !== undefined && typeof input.exactFirst !== "boolean") {
    throw new Error("exactFirst must be boolean");
  }
  if (
    input.maxCandidatesPerChannel !== undefined &&
    (!Number.isInteger(input.maxCandidatesPerChannel) ||
      input.maxCandidatesPerChannel < 1 ||
      input.maxCandidatesPerChannel > 5000)
  ) {
    throw new Error(
      "maxCandidatesPerChannel must be an integer between 1 and 5000",
    );
  }
  if (input.fusion !== undefined && !FUSION_VALUES.has(input.fusion)) {
    throw new Error("fusion policy is invalid");
  }
  if (
    input.truthValidation !== undefined &&
    !TRUTH_VALUES.has(input.truthValidation)
  ) {
    throw new Error("truthValidation policy is invalid");
  }
  if (input.graphMode !== undefined && !GRAPH_MODES.has(input.graphMode)) {
    throw new Error("graphMode policy is invalid");
  }
  if (
    input.contextLevel !== undefined &&
    !CONTEXT_LEVELS.has(input.contextLevel)
  ) {
    throw new Error("contextLevel policy is invalid");
  }
  if (
    input.reranker !== undefined &&
    (typeof input.reranker !== "string" || input.reranker.trim() === "")
  ) {
    throw new Error("reranker must be a non-empty string");
  }

  const channels = Object.fromEntries(
    RETRIEVAL_CANDIDATE_CHANNELS.map((channel) => {
      const defaults = DEFAULT_CHANNELS[channel];
      const override = input.channels?.[channel];
      if (
        override?.enabled !== undefined &&
        typeof override.enabled !== "boolean"
      ) {
        throw new Error(`channels.${channel}.enabled must be boolean`);
      }
      return [
        channel,
        {
          enabled: override?.enabled ?? defaults.enabled,
          weight:
            validWeight(
              override?.weight ?? defaults.weight,
              `channels.${channel}.weight`,
            ) ?? 1,
        },
      ];
    }),
  ) as Record<RetrievalCandidateChannel, RetrievalChannelPolicy>;

  return {
    channels,
    exactFirst: input.exactFirst ?? DEFAULT_RETRIEVAL_POLICY.exactFirst,
    maxCandidatesPerChannel:
      input.maxCandidatesPerChannel ??
      DEFAULT_RETRIEVAL_POLICY.maxCandidatesPerChannel,
    fusion: input.fusion ?? DEFAULT_RETRIEVAL_POLICY.fusion,
    ...(input.reranker !== undefined
      ? { reranker: input.reranker.trim() }
      : {}),
    truthValidation:
      input.truthValidation ?? DEFAULT_RETRIEVAL_POLICY.truthValidation,
    graphMode: input.graphMode ?? DEFAULT_RETRIEVAL_POLICY.graphMode,
    contextLevel: input.contextLevel ?? DEFAULT_RETRIEVAL_POLICY.contextLevel,
  };
}

export function retrievalCandidatesToRankedChannels(
  candidates: readonly RetrievalCandidate[],
  policy: RetrievalPolicy,
): RankedChannel[] {
  const grouped = new Map<
    RetrievalCandidateChannel,
    RetrievalCandidate[]
  >();
  for (const candidate of candidates) {
    validateCandidate(candidate);
    if (!policy.channels[candidate.channel].enabled) continue;
    const entries = grouped.get(candidate.channel) ?? [];
    entries.push(candidate);
    grouped.set(candidate.channel, entries);
  }

  const orderedChannels = policy.exactFirst
    ? RETRIEVAL_CANDIDATE_CHANNELS
    : [...RETRIEVAL_CANDIDATE_CHANNELS].sort();

  const ranked: RankedChannel[] = [];
  for (const channel of orderedChannels) {
    const entries = grouped.get(channel);
    if (!entries || entries.length === 0) continue;
    const selected = [...entries]
      .sort(
        (left, right) =>
          left.rank - right.rank ||
          left.candidateId.localeCompare(right.candidateId),
      )
      .slice(0, policy.maxCandidatesPerChannel);
    const configuredWeight = policy.channels[channel].weight ?? 1;
    ranked.push({
      channel: CANDIDATE_TO_RRF_CHANNEL[channel],
      channelWeight: policy.fusion === "RRF" ? 1 : configuredWeight,
      items: selected.map((candidate) => ({
        id: candidate.candidateId,
        rank: candidate.rank,
        reason: reasonText(candidate.selectionReason, candidate.channel),
        ...(candidate.rawScore !== undefined
          ? { rawScore: candidate.rawScore }
          : {}),
        candidateRevision: candidate.revision,
      })),
    });
  }
  return ranked;
}
