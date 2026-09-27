import { describe, expect, it } from "vitest";
import type { SearchHit } from "@akp/contracts";
import {
  assessRetrievalAnswerability,
  collectCandidateAnswerabilitySignals,
  resolveRetrievalAnswerabilityPolicy,
} from "../src/answerability.js";

const VAULT_ID = "22222222-2222-4222-8222-222222222222";

function hit(
  idSuffix: number,
  input: {
    title: string;
    excerpt: string;
    parentContext?: string;
    contributions: NonNullable<SearchHit["fusionContributions"]>;
  },
): SearchHit {
  const documentId = `11111111-1111-4111-8111-${String(idSuffix).padStart(12, "0")}`;
  const unitId = `33333333-3333-4333-8333-${String(idSuffix).padStart(12, "0")}`;
  return {
    documentId,
    vaultId: VAULT_ID,
    unitId,
    unitType: "PARAGRAPH",
    document: {
      externalId: `public-fixture-${idSuffix}`,
      path: `docs/public-${idSuffix}.md`,
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
    ...(input.parentContext ? { parentContext: input.parentContext } : {}),
    excerpt: input.excerpt,
    citations: [],
  };
}

function contribution(
  channel: string,
  rawScore?: number,
  rank = 1,
): NonNullable<SearchHit["fusionContributions"]>[number] {
  return {
    channel,
    rank,
    channelWeight: 1,
    reason: `${channel}:test`,
    ...(rawScore === undefined ? {} : { rawScore }),
  };
}

describe("retrieval answerability", () => {
  it("accepts multiple answer-bearing passages even when the vector neighbourhood is dense", () => {
    const hits = [
      hit(1, {
        title: "Webhook replay safety",
        excerpt:
          "Before applying a duplicate webhook delivery, the consumer checks a persisted idempotency key and suppresses the repeated side effect.",
        contributions: [contribution("vector", 0.865113, 1)],
      }),
      hit(2, {
        title: "Duplicate delivery guard",
        excerpt:
          "Duplicate webhook attempts reuse the same durable processing record, so the handler does not apply the side effect twice.",
        contributions: [contribution("vector", 0.861647, 2)],
      }),
      hit(3, {
        title: "Replay processing rule",
        excerpt:
          "A duplicate webhook replay checks the recorded delivery key before executing the handler again.",
        contributions: [contribution("vector", 0.859263, 3)],
      }),
    ];

    const result = assessRetrievalAnswerability(
      hits,
      "How are duplicate webhook deliveries prevented during redelivery?",
    );

    expect(result.supported).toBe(true);
    expect(result.supportedDocumentIds).toEqual(
      hits.map((candidate) => candidate.documentId),
    );
    expect(result.vectorMargin).toBeCloseTo(0.003466, 6);
    expect(result.vectorNeighborhoodMargin).toBeCloseTo(0.00585, 5);
  });

  it("does not use vector separation as support when no passage answers the question", () => {
    const result = assessRetrievalAnswerability(
      [
        hit(1, {
          title: "Runtime telemetry",
          excerpt: "Metrics are exported to the observability backend.",
          contributions: [contribution("vector", 0.91, 1)],
        }),
        hit(2, {
          title: "Cache retention",
          excerpt: "Cached responses expire after a bounded window.",
          contributions: [contribution("vector", 0.72, 2)],
        }),
      ],
      "What guaranteed telephone support number is provided to premium customers?",
    );

    expect(result).toMatchObject({
      supported: false,
      reason: "SUPPORT_NOT_DEMONSTRATED",
      supportedDocumentIds: [],
    });
    expect(result.vectorMargin).toBeCloseTo(0.19, 4);
  });

  it("accepts a passage paraphrase with no shared salient words when answer cues align", () => {
    const query = "How can recurring charges be stopped after redelivery?";
    const candidate = hit(1, {
      title: "Idempotent consumer",
      excerpt:
        "A persisted idempotency key is checked before applying a payment again.",
      contributions: [contribution("vector", 0.84, 1)],
    });
    const result = assessRetrievalAnswerability([candidate], query);

    expect(
      result.candidateSignals[0]?.textualSupport.salientOverlapTokens,
    ).toEqual([]);
    expect(result).toMatchObject({
      supported: true,
      reason: "PASSAGE_CUE_SUPPORT",
      supportedDocumentIds: [candidate.documentId],
    });
  });

  it("accepts a cross-language answer-bearing passage without relying on a vector margin", () => {
    const query =
      "¿Cómo puede un alumno darse de baja antes de la fecha límite?";
    const candidate = hit(1, {
      title: "Enrollment withdrawal",
      excerpt:
        "The student files a withdrawal request through the registrar before the deadline.",
      contributions: [contribution("vector", 0.83, 2)],
    });
    const result = assessRetrievalAnswerability([candidate], query);

    expect(
      result.candidateSignals[0]?.textualSupport.salientOverlapTokens,
    ).toEqual([]);
    expect(result).toMatchObject({
      supported: true,
      reason: "PASSAGE_CUE_SUPPORT",
    });
  });

  it("rejects a semantic neighbour that is relevant to the topic but does not answer", () => {
    const result = assessRetrievalAnswerability(
      [
        hit(1, {
          title: "Replay observability",
          excerpt:
            "The replay worker records delivery latency and emits telemetry after processing.",
          contributions: [contribution("vector", 0.88, 1)],
        }),
      ],
      "How can recurring charges be stopped after redelivery?",
    );

    expect(result).toMatchObject({
      supported: false,
      reason: "SUPPORT_NOT_DEMONSTRATED",
    });
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      supported: false,
      reason: "ANSWER_CUE_MISMATCH",
    });
  });

  it("uses structural parent context when the presentation excerpt omits the decisive passage", () => {
    const candidate = hit(1, {
      title: "Durable publication",
      excerpt: "Publication overview.",
      parentContext:
        "A publication is committed only after the durable outbox record is written. The durable outbox record preserves recovery after a process crash.",
      contributions: [contribution("vector", 0.8, 1)],
    });
    const result = assessRetrievalAnswerability(
      [candidate],
      "How does the durable outbox preserve publication recovery after a crash?",
    );

    expect(result).toMatchObject({
      supported: true,
      reason: "PASSAGE_TEXT_SUPPORT",
    });
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      passageSource: "STRUCTURAL_CONTEXT",
      supportSurfaceExtendsExcerpt: true,
    });
  });

  it("treats exact and other direct channels as candidate-specific support", () => {
    const direct = hit(1, {
      title: "Canonical rule",
      excerpt: "Unrelated wording.",
      contributions: [contribution("exact"), contribution("vector", 0.6, 1)],
    });
    const neighbour = hit(2, {
      title: "Nearby topic",
      excerpt: "A nearby topic with no direct match.",
      contributions: [contribution("vector", 0.59, 2)],
    });
    const result = assessRetrievalAnswerability(
      [direct, neighbour],
      "RULE-AUTH-001",
    );

    expect(result).toMatchObject({
      supported: true,
      reason: "DIRECT_CHANNEL_SUPPORT",
      supportedDocumentIds: [direct.documentId],
    });
    expect(result.candidateSignals[1]?.passageSupport.supported).toBe(false);
  });

  it("requires lexical candidates to demonstrate support in their passage", () => {
    const supported = hit(1, {
      title: "Reviewed workflow",
      excerpt: "The workflow follows the reviewed policy.",
      contributions: [contribution("lexical", 1)],
    });
    const unsupported = hit(2, {
      title: "Policy archive",
      excerpt: "Archived policy documents are listed by year.",
      contributions: [contribution("lexical", 0.8)],
    });
    const query = "What workflow follows the reviewed policy?";

    expect(assessRetrievalAnswerability([supported], query)).toMatchObject({
      supported: true,
      reason: "PASSAGE_TEXT_SUPPORT",
      supportedDocumentIds: [supported.documentId],
    });
    expect(assessRetrievalAnswerability([unsupported], query)).toMatchObject({
      supported: false,
      reason: "SUPPORT_NOT_DEMONSTRATED",
    });
  });

  it("accepts graph evidence only for an explicit graph-oriented intent", () => {
    const candidate = hit(1, {
      title: "Dependency relation",
      excerpt: "A graph neighbour discovered through an authorized path.",
      contributions: [
        contribution("vector", 0.78, 1),
        contribution("graph", 1, 1),
      ],
    });
    const query = "Which component is related to this dependency?";

    expect(assessRetrievalAnswerability([candidate], query).supported).toBe(
      false,
    );
    expect(
      assessRetrievalAnswerability(
        [candidate],
        query,
        {},
        { allowGraphSupport: true },
      ),
    ).toMatchObject({
      supported: true,
      reason: "GRAPH_INTENT_SUPPORT",
      supportedDocumentIds: [candidate.documentId],
    });
  });

  it("keeps authorized candidate diagnostics even when support is not demonstrated", () => {
    const hits = [
      hit(1, {
        title: "Managed architecture",
        excerpt: "A managed component exists.",
        contributions: [contribution("vector", 0.777, 1)],
      }),
      hit(2, {
        title: "Module guide",
        excerpt: "Module boundaries.",
        contributions: [contribution("vector", 0.772, 2)],
      }),
    ];
    const query =
      "Which public cloud region hosts the managed production service?";
    const signals = collectCandidateAnswerabilitySignals(hits, query);
    const result = assessRetrievalAnswerability(hits, query);

    expect(signals).toHaveLength(2);
    expect(result.candidateSignals).toEqual(signals);
    expect(result).toMatchObject({
      supported: false,
      reason: "SUPPORT_NOT_DEMONSTRATED",
    });
  });

  it("uses the comparison pool only for vector diagnostics, never as implicit support", () => {
    const winner = hit(1, {
      title: "Observability",
      excerpt: "Metrics are exported to a monitoring backend.",
      contributions: [contribution("vector", 0.9, 1)],
    });
    const distant = hit(2, {
      title: "Cache",
      excerpt: "Cached values expire.",
      contributions: [contribution("vector", 0.4, 2)],
    });
    const result = assessRetrievalAnswerability(
      [winner],
      "What is the unpublished emergency support telephone number?",
      {},
      { comparisonHits: [winner, distant] },
    );

    expect(result.supported).toBe(false);
    expect(result.vectorMargin).toBeCloseTo(0.5, 4);
    expect(result.supportedDocumentIds).toEqual([]);
  });

  it("validates passage support policy thresholds", () => {
    expect(() =>
      resolveRetrievalAnswerabilityPolicy({ minimumSalientCoverage: 1.1 }),
    ).toThrow("minimumSalientCoverage");
    expect(() =>
      resolveRetrievalAnswerabilityPolicy({ minimumSalientOverlap: 0 }),
    ).toThrow("minimumSalientOverlap");
    expect(() =>
      resolveRetrievalAnswerabilityPolicy({ semanticCueMaxVectorRank: 0 }),
    ).toThrow("semanticCueMaxVectorRank");
  });
});
