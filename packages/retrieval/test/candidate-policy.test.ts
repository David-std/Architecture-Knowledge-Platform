import { describe, expect, it } from "vitest";

import {
  candidateChannelForRuntimeChannel,
  resolveRetrievalPolicy,
  retrievalCandidatesToRankedChannels,
  runtimeChannelEnabled,
  type RetrievalCandidate,
} from "../src/candidate-policy.js";

const baseCandidate: RetrievalCandidate = {
  candidateId: "11111111-1111-4111-8111-111111111111",
  channel: "VECTOR",
  rank: 1,
  rawScore: 0.99,
  scopeId: "22222222-2222-4222-8222-222222222222",
  documentId: "11111111-1111-4111-8111-111111111111",
  unitId: "33333333-3333-4333-8333-333333333333",
  revision: "revision-1",
  selectionReason: "vector:cosine",
};

describe("retrieval candidate policy", () => {
  it("keeps advanced channels disabled until a policy explicitly enables them", () => {
    const policy = resolveRetrievalPolicy();
    expect(policy.channels.EXACT).toMatchObject({ enabled: true, weight: 3 });
    expect(policy.channels.GRAPH_TYPED).toMatchObject({
      enabled: true,
      weight: 1.4,
    });
    expect(policy.channels.GRAPH_PPR.enabled).toBe(false);
    expect(policy.channels.COMMUNITY.enabled).toBe(false);
    expect(policy.channels.LATE_INTERACTION.enabled).toBe(false);
    expect(runtimeChannelEnabled(policy, "vector")).toBe(true);
    expect(candidateChannelForRuntimeChannel("context-pack")).toBe(
      "CONTEXT_PACK",
    );
  });

  it("normalizes channel candidates without making raw scores commensurate", () => {
    const policy = resolveRetrievalPolicy();
    const ranked = retrievalCandidatesToRankedChannels(
      [
        baseCandidate,
        {
          ...baseCandidate,
          candidateId: "44444444-4444-4444-8444-444444444444",
          channel: "LEXICAL",
          rank: 1,
          rawScore: 200,
          revision: "revision-2",
          selectionReason: "lexical:bm25",
        },
      ],
      policy,
    );

    expect(ranked).toMatchObject([
      {
        channel: "lexical",
        channelWeight: 1.5,
        items: [
          expect.objectContaining({
            id: "44444444-4444-4444-8444-444444444444",
            rawScore: 200,
            candidateRevision: "revision-2",
          }),
        ],
      },
      {
        channel: "vector",
        channelWeight: 1,
        items: [
          expect.objectContaining({
            id: baseCandidate.candidateId,
            rawScore: 0.99,
            candidateRevision: "revision-1",
          }),
        ],
      },
    ]);
  });

  it("supports unweighted RRF and deterministic per-channel caps", () => {
    const policy = resolveRetrievalPolicy({
      fusion: "RRF",
      maxCandidatesPerChannel: 1,
      channels: {
        VECTOR: { weight: 9 },
      },
    });
    const ranked = retrievalCandidatesToRankedChannels(
      [
        { ...baseCandidate, candidateId: "b", rank: 2 },
        { ...baseCandidate, candidateId: "a", rank: 1 },
      ],
      policy,
    );

    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({
      channel: "vector",
      channelWeight: 1,
      items: [expect.objectContaining({ id: "a", rank: 1 })],
    });
  });

  it("filters policy-disabled channels before fusion", () => {
    const policy = resolveRetrievalPolicy({
      channels: {
        VECTOR: { enabled: false },
        GRAPH_PPR: { enabled: true, weight: 0.75 },
      },
    });
    const ranked = retrievalCandidatesToRankedChannels(
      [
        baseCandidate,
        {
          ...baseCandidate,
          candidateId: "graph-ppr-node",
          channel: "GRAPH_PPR",
          rawScore: 0.42,
          selectionReason: { seed: "policy" },
        },
      ],
      policy,
    );

    expect(ranked).toEqual([
      {
        channel: "graph-ppr",
        channelWeight: 0.75,
        items: [
          {
            id: "graph-ppr-node",
            rank: 1,
            reason: "graph-ppr:structured-reason",
            rawScore: 0.42,
            candidateRevision: "revision-1",
          },
        ],
      },
    ]);
  });

  it("rejects malformed policy and candidate inputs", () => {
    expect(() =>
      resolveRetrievalPolicy({ maxCandidatesPerChannel: 0 }),
    ).toThrow("maxCandidatesPerChannel");
    expect(() =>
      resolveRetrievalPolicy({
        channels: { VECTOR: { weight: Number.NaN } },
      }),
    ).toThrow("channels.VECTOR.weight");

    const policy = resolveRetrievalPolicy();
    expect(() =>
      retrievalCandidatesToRankedChannels(
        [{ ...baseCandidate, rank: 0 }],
        policy,
      ),
    ).toThrow("candidate rank");
    expect(() =>
      retrievalCandidatesToRankedChannels(
        [{ ...baseCandidate, rawScore: Number.NaN }],
        policy,
      ),
    ).toThrow("rawScore");
  });
});
