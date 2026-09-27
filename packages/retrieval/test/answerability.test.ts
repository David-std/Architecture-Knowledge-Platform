import { describe, expect, it } from "vitest";
import type { SearchHit } from "@akp/contracts";
import {
  assessRetrievalAnswerability,
  collectCandidateAnswerabilitySignals,
  resolveRetrievalAnswerabilityPolicy,
} from "../src/answerability.js";

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";

function hit(
  idSuffix: number,
  input: {
    title: string;
    excerpt: string;
    contributions: NonNullable<SearchHit["fusionContributions"]>;
  },
): SearchHit {
  const id = `11111111-1111-4111-8111-${String(idSuffix).padStart(12, "0")}`;
  return {
    documentId: id === DOCUMENT_ID ? DOCUMENT_ID : id,
    vaultId: VAULT_ID,
    document: {
      externalId: `doc-${idSuffix}`,
      path: `docs/doc-${idSuffix}.md`,
      title: input.title,
    },
    revision: "revision-1",
    title: input.title,
    type: "concept",
    trust: "HUMAN_REVIEWED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1,
    reasons: ["test"],
    fusionContributions: input.contributions,
    excerpt: input.excerpt,
    citations: [],
  };
}

function contribution(
  channel: string,
  rawScore?: number,
): NonNullable<SearchHit["fusionContributions"]>[number] {
  return {
    channel,
    rank: 1,
    channelWeight: 1,
    reason: `${channel}:test`,
    ...(rawScore === undefined ? {} : { rawScore }),
  };
}

describe("retrieval answerability", () => {
  it("rejects weak semantic neighbours with no direct or textual support", () => {
    const result = assessRetrievalAnswerability(
      [
        hit(1, {
          title: "Threat model",
          excerpt: "Authentication and trust boundaries.",
          contributions: [
            contribution("vector", 0.7898),
            contribution("graph", 1),
          ],
        }),
        hit(2, {
          title: "Operations runbook",
          excerpt: "Local recovery procedures.",
          contributions: [
            contribution("vector", 0.7714),
            contribution("graph", 1),
          ],
        }),
      ],
      "What is the guaranteed 24/7 telephone support SLA for enterprise customers?",
    );

    expect(result).toMatchObject({
      supported: false,
      reason: "WEAK_SEMANTIC_NEIGHBORS",
    });
    expect(result.vectorMargin).toBeCloseTo(0.0184, 4);
  });

  it("preserves cross-language retrieval when the vector winner is discriminative", () => {
    const result = assessRetrievalAnswerability(
      [
        hit(1, {
          title: "Retry policy",
          excerpt:
            "Transient calls use bounded retries with exponential backoff.",
          contributions: [contribution("vector", 0.8133)],
        }),
        hit(2, {
          title: "Cache policy",
          excerpt: "Cache entries use bounded retention.",
          contributions: [contribution("vector", 0.7366)],
        }),
      ],
      "¿Qué regla limita los reintentos de llamadas transitorias mediante retroceso exponencial?",
    );

    expect(result).toMatchObject({
      supported: true,
      reason: "VECTOR_MARGIN_SUPPORT",
    });
    expect(result.candidateSignals[0]?.textualSupport.salientCoverage).toBe(0);
  });

  it("supports two close semantic neighbours when they separate from background", () => {
    const result = assessRetrievalAnswerability(
      [
        hit(1, {
          title: "Payment replay safety",
          excerpt: "A replay uses the recorded idempotency key before applying a payment.",
          contributions: [contribution("vector", 0.854)],
        }),
        hit(2, {
          title: "Duplicate payment guard",
          excerpt: "Previously processed payment keys are not applied twice.",
          contributions: [contribution("vector", 0.847)],
        }),
        hit(3, {
          title: "Cache retention",
          excerpt: "Cached values expire after a bounded retention window.",
          contributions: [contribution("vector", 0.775)],
        }),
      ],
      "How are duplicate payments prevented when events are replayed?",
    );

    expect(result).toMatchObject({
      supported: true,
      reason: "VECTOR_NEIGHBORHOOD_SUPPORT",
      topVectorScore: 0.854,
      secondVectorScore: 0.847,
      thirdVectorScore: 0.775,
    });
    expect(result.vectorMargin).toBeCloseTo(0.007, 4);
    expect(result.vectorNeighborhoodMargin).toBeCloseTo(0.079, 4);
  });

  it("rejects an unsupported semantic outlier even when the legacy top-two margin passes", () => {
    const result = assessRetrievalAnswerability(
      [
        hit(1, {
          title: "Runtime telemetry",
          excerpt: "Metrics are exported to the observability backend.",
          contributions: [contribution("vector", 0.7522)],
        }),
        hit(2, {
          title: "Cache retention",
          excerpt: "Cached responses expire after a bounded window.",
          contributions: [contribution("vector", 0.7215)],
        }),
        hit(3, {
          title: "Enrollment procedure",
          excerpt: "Students submit a withdrawal request to the registrar.",
          contributions: [contribution("vector", 0.7184)],
        }),
      ],
      "What guaranteed 24/7 telephone support SLA is included for premium customers?",
    );

    expect(result).toMatchObject({
      supported: false,
      reason: "WEAK_SEMANTIC_NEIGHBORS",
      thirdVectorScore: 0.7184,
    });
    expect(result.vectorMargin).toBeGreaterThan(0.03);
    expect(result.vectorNeighborhoodMargin).toBeLessThan(0.06);
  });

  it("preserves a low-margin vector winner with measured salient text support", () => {
    const result = assessRetrievalAnswerability(
      [
        hit(1, {
          title: "Architecture overview",
          excerpt:
            "Approved Markdown is canonical knowledge and indexes are rebuildable projections.",
          contributions: [contribution("vector", 0.7884)],
        }),
        hit(2, {
          title: "C4 architecture",
          excerpt: "Container and module views.",
          contributions: [contribution("vector", 0.7791)],
        }),
      ],
      "¿Qué componente conserva el Markdown aprobado como conocimiento canónico y qué datos se consideran proyecciones reconstruibles?",
    );

    expect(result.supported).toBe(true);
    expect(["VECTOR_TEXT_SUPPORT", "VECTOR_MARGIN_SUPPORT"]).toContain(
      result.reason,
    );
  });

  it("treats exact and other direct channels as support", () => {
    const result = assessRetrievalAnswerability(
      [
        hit(1, {
          title: "Canonical rule",
          excerpt: "Unrelated wording.",
          contributions: [contribution("exact"), contribution("vector", 0.6)],
        }),
        hit(2, {
          title: "Other",
          excerpt: "Other wording.",
          contributions: [contribution("vector", 0.59)],
        }),
      ],
      "RULE-AUTH-001",
    );

    expect(result).toMatchObject({
      supported: true,
      reason: "DIRECT_CHANNEL_SUPPORT",
    });
  });

  it("preserves lexical-only retrieval when no vector candidate participated", () => {
    const result = assessRetrievalAnswerability(
      [
        hit(1, {
          title: "Related workflow",
          excerpt: "Follows the reviewed policy.",
          contributions: [contribution("lexical", 1)],
        }),
      ],
      "What workflow follows the reviewed policy?",
    );

    expect(result).toMatchObject({
      supported: true,
      reason: "LEXICAL_TEXT_SUPPORT",
    });
  });

  it("uses a same-query comparison pool when presentation limit keeps one vector hit", () => {
    const winner = hit(1, {
      title: "Retry policy",
      excerpt: "Transient calls use bounded retries with exponential backoff.",
      contributions: [contribution("vector", 0.8133)],
    });
    const runnerUp = hit(2, {
      title: "Cache policy",
      excerpt: "Cache entries use bounded retention.",
      contributions: [contribution("vector", 0.7366)],
    });
    const query =
      "¿Qué regla limita los reintentos de llamadas transitorias mediante retroceso exponencial?";

    const result = assessRetrievalAnswerability(
      [winner],
      query,
      {},
      {
        comparisonHits: [winner, runnerUp],
      },
    );

    expect(result).toMatchObject({
      supported: true,
      reason: "VECTOR_MARGIN_SUPPORT",
      topVectorScore: 0.8133,
      secondVectorScore: 0.7366,
    });
    expect(result.candidateSignals).toHaveLength(1);
  });

  it("does not invent a vector margin when only one semantic candidate exists", () => {
    const result = assessRetrievalAnswerability(
      [
        hit(1, {
          title: "Threat model",
          excerpt: "Authentication and trust boundaries.",
          contributions: [contribution("vector", 0.91)],
        }),
      ],
      "What is the guaranteed 24/7 telephone support SLA for enterprise customers?",
    );

    expect(result).toMatchObject({
      supported: false,
      reason: "WEAK_SEMANTIC_NEIGHBORS",
      secondVectorScore: null,
      vectorMargin: null,
    });
  });

  it("does not treat community-only orientation as answerability evidence", () => {
    const result = assessRetrievalAnswerability(
      [
        hit(1, {
          title: "Architecture theme",
          excerpt: "A derived cluster summary.",
          contributions: [contribution("community", 1)],
        }),
      ],
      "What contractual support SLA applies to enterprise customers?",
    );

    expect(result).toMatchObject({
      supported: false,
      reason: "WEAK_SEMANTIC_NEIGHBORS",
    });
  });

  it("keeps raw candidate signals available even when the gate rejects them", () => {
    const hits = [
      hit(1, {
        title: "Managed architecture",
        excerpt: "A managed component exists.",
        contributions: [contribution("vector", 0.777)],
      }),
      hit(2, {
        title: "Module guide",
        excerpt: "Module boundaries.",
        contributions: [contribution("vector", 0.772)],
      }),
    ];
    const signals = collectCandidateAnswerabilitySignals(
      hits,
      "Which public cloud region hosts the managed production SaaS service?",
    );
    const result = assessRetrievalAnswerability(
      hits,
      "Which public cloud region hosts the managed production SaaS service?",
    );

    expect(signals).toHaveLength(2);
    expect(result.candidateSignals).toEqual(signals);
    expect(result).toMatchObject({
      supported: false,
      reason: "WEAK_SEMANTIC_NEIGHBORS",
    });
  });

  it("accepts graph evidence only for an explicit graph-oriented intent", () => {
    const hits = [
      hit(1, {
        title: "Threat model",
        excerpt: "Authentication and trust boundaries.",
        contributions: [
          contribution("vector", 0.7898),
          contribution("graph", 1),
        ],
      }),
      hit(2, {
        title: "Operations runbook",
        excerpt: "Local recovery procedures.",
        contributions: [
          contribution("vector", 0.7714),
          contribution("graph", 1),
        ],
      }),
    ];
    const query =
      "Which security document is related to the local operations runbook?";

    expect(assessRetrievalAnswerability(hits, query).supported).toBe(false);
    expect(
      assessRetrievalAnswerability(
        hits,
        query,
        {},
        {
          allowGraphSupport: true,
        },
      ),
    ).toMatchObject({
      supported: true,
      reason: "GRAPH_INTENT_SUPPORT",
    });
  });

  it("validates policy thresholds", () => {
    expect(() =>
      resolveRetrievalAnswerabilityPolicy({ minimumVectorTextMargin: -1 }),
    ).toThrow("minimumVectorTextMargin");
    expect(() =>
      resolveRetrievalAnswerabilityPolicy({ minimumVectorMargin: -1 }),
    ).toThrow("minimumVectorMargin");
    expect(() =>
      resolveRetrievalAnswerabilityPolicy({
        minimumVectorNeighborhoodMargin: 1.1,
      }),
    ).toThrow("minimumVectorNeighborhoodMargin");
    expect(() =>
      resolveRetrievalAnswerabilityPolicy({ minimumSalientCoverage: 1.1 }),
    ).toThrow("minimumSalientCoverage");
  });
});
