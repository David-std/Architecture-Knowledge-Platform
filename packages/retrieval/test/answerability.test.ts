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
          contributions: [contribution("vector", 0.7898), contribution("graph", 1)],
        }),
        hit(2, {
          title: "Operations runbook",
          excerpt: "Local recovery procedures.",
          contributions: [contribution("vector", 0.7714), contribution("graph", 1)],
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
          contributions: [
            contribution("exact"),
            contribution("vector", 0.6),
          ],
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

  it("does not gate retrieval when no vector candidate participated", () => {
    const result = assessRetrievalAnswerability(
      [
        hit(1, {
          title: "Related workflow",
          excerpt: "Follows the reviewed policy.",
          contributions: [contribution("graph", 1)],
        }),
      ],
      "What workflow follows the reviewed policy?",
    );

    expect(result).toMatchObject({
      supported: true,
      reason: "VECTOR_GATE_NOT_APPLICABLE",
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
    expect(result.supported).toBe(false);
  });

  it("validates policy thresholds", () => {
    expect(() =>
      resolveRetrievalAnswerabilityPolicy({ minimumVectorMargin: -1 }),
    ).toThrow("minimumVectorMargin");
    expect(() =>
      resolveRetrievalAnswerabilityPolicy({ minimumSalientCoverage: 1.1 }),
    ).toThrow("minimumSalientCoverage");
  });
});
