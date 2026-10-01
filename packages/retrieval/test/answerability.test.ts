import { describe, expect, it } from "vitest";
import { ReaderEvidenceVerifier } from "../src/evidence-reader.js";
import type { SearchHit } from "@akp/contracts";
import {
  assessRetrievalAnswerability,
  assessRetrievalAnswerabilityWithVerifier,
  collectCandidateAnswerabilitySignals,
  resolveRetrievalAnswerabilityPolicy,
  retrievalAnswerabilityCandidateKey,
} from "../src/answerability.js";

const VAULT_ID = "22222222-2222-4222-8222-222222222222";

function hit(
  idSuffix: number,
  input: {
    title: string;
    excerpt: string;
    parentContext?: string;
    contributions: NonNullable<SearchHit["fusionContributions"]>;
    type?: string;
    trust?: SearchHit["trust"];
    externalId?: string;
    structuralOrder?: number;
    headingPath?: string[];
    unitType?: string;
    aliases?: string[];
  },
): SearchHit {
  const documentId = `11111111-1111-4111-8111-${String(idSuffix).padStart(12, "0")}`;
  const unitId = `33333333-3333-4333-8333-${String(idSuffix).padStart(12, "0")}`;
  return {
    documentId,
    vaultId: VAULT_ID,
    unitId,
    unitType: input.unitType ?? "PARAGRAPH",
    ...(input.structuralOrder === undefined
      ? {}
      : { structuralOrder: input.structuralOrder }),
    ...(input.headingPath ? { headingPath: input.headingPath } : {}),
    document: {
      externalId: input.externalId ?? `public-fixture-${idSuffix}`,
      path: `docs/public-${idSuffix}.md`,
      title: input.title,
      ...(input.aliases ? { aliases: input.aliases } : {}),
    },
    revision: "revision-1",
    title: input.title,
    type: input.type ?? "concept",
    trust: input.trust ?? "HUMAN_REVIEWED",
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
  it("does not infer a relation from a catalog sentence that lists both entities", () => {
    const catalog = hit(904, {
      title: "FINP and LEDG catalog",
      type: "dashboard",
      excerpt:
        "FINP and LEDG have separate reports; the review requires owner approval.",
      contributions: [contribution("vector", 0.91, 1)],
    });
    const result = assessRetrievalAnswerability(
      [catalog],
      "Does FINP require LEDG?",
    );
    expect(result.supported).toBe(false);
  });
  it("rejects a proposition with the same entities but a different unrecognized relation", () => {
    const topicalClaim = hit(905, {
      title: "NEXO and QARO documentation",
      type: "claim",
      excerpt: "NEXO and QARO are documented in separate reports.",
      contributions: [contribution("vector", 0.92, 1)],
    });
    const direct = hit(906, {
      title: "NEXO integration",
      type: "claim",
      excerpt: "NEXO can use QARO for delivery.",
      contributions: [contribution("vector", 0.9, 2)],
    });

    const result = assessRetrievalAnswerability(
      [topicalClaim, direct],
      "Can NEXO use QARO?",
    );

    expect(result.supportedCandidateKeys).toEqual([
      retrievalAnswerabilityCandidateKey(direct),
    ]);
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      supported: false,
    });
    expect(result.candidateSignals[1]?.passageSupport).toMatchObject({
      supported: true,
      boundedRelationRoleMatched: true,
    });
  });

  it("rejects the reverse direction for an unrecognized relation", () => {
    const reverse = hit(907, {
      title: "QARO integration",
      type: "decision-rule",
      excerpt: "QARO can use NEXO for delivery.",
      contributions: [contribution("vector", 0.93, 1)],
    });

    const result = assessRetrievalAnswerability(
      [reverse],
      "Can NEXO use QARO?",
    );

    expect(result.supported).toBe(false);
  });

  it("does not let title scope substitute for the subject of an unrecognized relation", () => {
    const anaphoric = hit(908, {
      title: "NEXO integration",
      type: "rule",
      excerpt: "It can use QARO for delivery.",
      contributions: [contribution("vector", 0.91, 1)],
    });
    const otherSubject = hit(911, {
      title: "NEXO integration",
      type: "claim",
      excerpt: "Reviewers can use QARO while checking NEXO reports.",
      contributions: [contribution("vector", 0.9, 2)],
    });

    const result = assessRetrievalAnswerability(
      [anaphoric, otherSubject],
      "Can NEXO use QARO?",
    );

    expect(result.supported).toBe(false);
    expect(result.supportedCandidateKeys).toEqual([]);
  });

  it("keeps catalog mentions and wrong entities exploratory for yes/no relations", () => {
    const catalog = hit(901, {
      title: "NEXO and QARO catalog",
      type: "dashboard",
      excerpt:
        "NEXO and QARO have separate reports; the audit can add examples after review.",
      contributions: [contribution("vector", 0.91, 1)],
    });
    const wrongEntity = hit(902, {
      title: "VEXO integration",
      type: "claim",
      excerpt: "VEXO can use QARO for delivery.",
      contributions: [contribution("vector", 0.9, 2)],
    });
    const direct = hit(903, {
      title: "NEXO integration",
      type: "claim",
      excerpt: "NEXO can use QARO for delivery.",
      contributions: [contribution("vector", 0.89, 3)],
    });
    const result = assessRetrievalAnswerability(
      [catalog, wrongEntity, direct],
      "Can NEXO use QARO?",
    );
    expect(result.supportedCandidateKeys).toEqual([
      retrievalAnswerabilityCandidateKey(direct),
    ]);
  });

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

  it("keeps support passage-specific when sibling units belong to the same document", () => {
    const supported = hit(10, {
      title: "Replay safety",
      excerpt:
        "The handler checks a persisted idempotency key before applying the side effect again.",
      contributions: [contribution("vector", 0.88, 1)],
    });
    const siblingBase = hit(11, {
      title: "Replay observability",
      excerpt: "The worker emits latency telemetry after each replay attempt.",
      contributions: [contribution("vector", 0.87, 2)],
    });
    const sibling: SearchHit = {
      ...siblingBase,
      documentId: supported.documentId,
      document: supported.document,
    };

    const result = assessRetrievalAnswerability(
      [supported, sibling],
      "How can a replay avoid repeating an external side effect?",
    );

    expect(result.supportedDocumentIds).toEqual([supported.documentId]);
    expect(result.supportedCandidateKeys).toEqual([
      retrievalAnswerabilityCandidateKey(supported),
    ]);
    expect(result.candidateSignals).toEqual([
      expect.objectContaining({
        candidateKey: retrievalAnswerabilityCandidateKey(supported),
        unitId: supported.unitId,
        passageSupport: expect.objectContaining({ supported: true }),
      }),
      expect.objectContaining({
        candidateKey: retrievalAnswerabilityCandidateKey(sibling),
        unitId: sibling.unitId,
        passageSupport: expect.objectContaining({ supported: false }),
      }),
    ]);
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

  it("accepts a bounded copular definition without treating topic proximity as evidence", () => {
    const candidate = hit(30, {
      title: "Canonical knowledge",
      parentContext:
        "Approved Markdown in managed Git is canonical knowledge. PostgreSQL, vector indexes, graphs, packets and caches are derived operational projections.",
      excerpt:
        "Approved Markdown in managed Git is canonical knowledge. PostgreSQL, vector indexes, graphs, packets and caches are derived operational projections.",
      contributions: [contribution("vector", 0.86, 1)],
    });
    const result = assessRetrievalAnswerability(
      [candidate],
      "What is canonical knowledge in the platform, and which stores are derived projections?",
    );

    expect(result).toMatchObject({
      supported: true,
      supportedCandidateKeys: [retrievalAnswerabilityCandidateKey(candidate)],
    });
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      supported: true,
      requiredAnswerCues: ["DEFINITION"],
    });
  });

  it("accepts a bilingual functional description only from the introductory concept unit", () => {
    const candidate = hit(920, {
      title: "Adaptive failover routing",
      type: "concept",
      trust: "MACHINE_SUPPORTED",
      structuralOrder: 2,
      headingPath: ["Adaptive failover routing"],
      aliases: ["enrutamiento adaptativo"],
      excerpt:
        "El enrutamiento adaptativo selecciona un destino saludable y conserva una alternativa determinista cuando falla la ruta principal.",
      contributions: [contribution("vector", 0.84, 4)],
    });

    const result = assessRetrievalAnswerability(
      [candidate],
      "What is adaptive failover routing?",
    );

    expect(result).toMatchObject({
      supported: true,
      reason: "CONCEPT_DEFINITION_SUPPORT",
      supportedCandidateKeys: [retrievalAnswerabilityCandidateKey(candidate)],
    });
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      supported: true,
      reason: "CONCEPT_DEFINITION_SUPPORT",
      requiredAnswerCues: ["DEFINITION"],
      matchedAnswerCues: ["DEFINITION"],
    });
  });

  it("does not treat a thematic introductory concept paragraph as a definition when it never names the concept", () => {
    const candidate = hit(923, {
      title: "Adaptive failover routing",
      type: "concept",
      trust: "MACHINE_SUPPORTED",
      structuralOrder: 2,
      headingPath: ["Adaptive failover routing"],
      aliases: ["enrutamiento adaptativo"],
      excerpt:
        "Latency, availability, and error counters are recorded every minute for operations.",
      contributions: [contribution("vector", 0.93, 1)],
    });

    const result = assessRetrievalAnswerability(
      [candidate],
      "What is adaptive failover routing?",
    );

    expect(result.supported).toBe(false);
  });

  it("does not treat a later paragraph from the same concept as its definition", () => {
    const candidate = hit(921, {
      title: "Adaptive failover routing",
      type: "concept",
      trust: "MACHINE_SUPPORTED",
      structuralOrder: 7,
      headingPath: ["Adaptive failover routing", "Operations"],
      excerpt:
        "The dashboard records latency and availability for adaptive failover routing.",
      contributions: [contribution("vector", 0.91, 1)],
    });

    const result = assessRetrievalAnswerability(
      [candidate],
      "What is adaptive failover routing?",
    );

    expect(result.supported).toBe(false);
  });

  it("does not grant definition support to a non-concept introductory document", () => {
    const candidate = hit(922, {
      title: "Adaptive failover routing",
      type: "dashboard",
      trust: "HUMAN_REVIEWED",
      structuralOrder: 2,
      headingPath: ["Adaptive failover routing"],
      excerpt:
        "The dashboard records latency and availability for adaptive failover routing.",
      contributions: [contribution("vector", 0.92, 1)],
    });

    const result = assessRetrievalAnswerability(
      [candidate],
      "What is adaptive failover routing?",
    );

    expect(result.supported).toBe(false);
  });

  it("rejects a topical definition when the query asks for an avoidance condition, even on a direct channel", () => {
    const definition = hit(1, {
      title: "Checksum validation definition",
      excerpt:
        "Periodic checksum validation recomputes digests to detect accidental data corruption during storage.",
      contributions: [contribution("exact"), contribution("vector", 0.91, 1)],
    });
    const query =
      "When should periodic checksum validation be avoided on battery-constrained sensors?";

    const result = assessRetrievalAnswerability([definition], query);

    expect(result).toMatchObject({
      supported: false,
      reason: "SUPPORT_NOT_DEMONSTRATED",
      supportedCandidateKeys: [],
    });
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      supported: false,
      reason: "ANSWER_CUE_MISMATCH",
      answerCueCoverage: 0,
    });
    expect(
      result.candidateSignals[0]?.passageSupport.requiredAnswerCues,
    ).toEqual(expect.arrayContaining(["PREVENTION", "CONDITION"]));
    expect(
      result.candidateSignals[0]?.textualSupport.salientCoverage,
    ).toBeGreaterThanOrEqual(0.4);
  });

  it("admits the condition-bearing unit instead of a topical definition from the same document", () => {
    const definition = hit(1, {
      title: "Checksum validation definition",
      excerpt:
        "Periodic checksum validation recomputes digests to detect accidental data corruption during storage.",
      contributions: [contribution("exact"), contribution("vector", 0.91, 1)],
    });
    const conditionBase = hit(2, {
      title: "Checksum validation trade-off",
      excerpt:
        "Periodic checksum validation is a poor fit for battery-constrained sensors because repeated digest computation drains limited power.",
      contributions: [contribution("vector", 0.89, 2)],
    });
    const condition: SearchHit = {
      ...conditionBase,
      documentId: definition.documentId,
      document: definition.document,
    };
    const query =
      "When should periodic checksum validation be avoided on battery-constrained sensors?";

    const result = assessRetrievalAnswerability([definition, condition], query);

    expect(result.supported).toBe(true);
    expect(result.supportedCandidateKeys).toEqual([
      retrievalAnswerabilityCandidateKey(condition),
    ]);
    expect(result.candidateSignals).toEqual([
      expect.objectContaining({
        candidateKey: retrievalAnswerabilityCandidateKey(definition),
        passageSupport: expect.objectContaining({
          supported: false,
          reason: "ANSWER_CUE_MISMATCH",
        }),
      }),
      expect.objectContaining({
        candidateKey: retrievalAnswerabilityCandidateKey(condition),
        passageSupport: expect.objectContaining({
          supported: true,
        }),
      }),
    ]);
  });

  it("uses a scoped title and an explicitly linked continuation for an avoidance condition", () => {
    const candidate = hit(31, {
      title: "Reject durable change logs for simple record editing",
      parentContext:
        "Durable change logs are justified by replay, temporal reconstruction, or compliance traceability. Without those drivers, the log adds unjustified operational overhead.",
      excerpt:
        "Without those drivers, the log adds unjustified operational overhead.",
      contributions: [contribution("vector", 0.86, 5)],
    });
    const query =
      "When should a durable change log be avoided because of operating costs?";
    const result = assessRetrievalAnswerability([candidate], query);

    expect(result).toMatchObject({
      supported: true,
      supportedCandidateKeys: [retrievalAnswerabilityCandidateKey(candidate)],
    });
    expect(["PASSAGE_TEXT_SUPPORT", "PASSAGE_CUE_SUPPORT"]).toContain(
      result.reason,
    );
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      supported: true,
      requiredAnswerCues: expect.arrayContaining(["PREVENTION", "CONDITION"]),
    });
    expect(
      result.candidateSignals[0]?.passageSupport.requiredAnswerCues,
    ).not.toContain("QUANTITY");

    const topical = hit(32, {
      title: "Durable change log operating overhead",
      excerpt:
        "The durable change log adds operational overhead while recording each update.",
      contributions: [contribution("vector", 0.85, 1)],
    });
    const rejected = assessRetrievalAnswerability([topical], query);
    expect(rejected).toMatchObject({
      supported: false,
      reason: "SUPPORT_NOT_DEMONSTRATED",
    });
    expect(rejected.candidateSignals[0]?.passageSupport).toMatchObject({
      supported: false,
      reason: "ANSWER_CUE_MISMATCH",
    });

    const monthly = assessRetrievalAnswerability(
      [candidate],
      "What is the monthly operating cost of the durable change log?",
    );
    expect(monthly.supported).toBe(false);
    expect(
      monthly.candidateSignals[0]?.passageSupport.requiredAnswerCues,
    ).toContain("QUANTITY");
  });

  it("accepts a bilingual architecture paraphrase without lowering the global overlap threshold", () => {
    const candidate = hit(33, {
      title: "Local patterns are not system architecture",
      type: "claim",
      trust: "MACHINE_SUPPORTED",
      externalId: "CLM-33",
      excerpt:
        "Mediator y Facade no determinan el conjunto de módulos, límites ni la dirección global de dependencias.",
      contributions: [contribution("vector", 0.9, 1)],
    });
    const result = assessRetrievalAnswerability(
      [candidate],
      "Do Mediator and Facade patterns define the overall system architecture?",
    );

    expect(result).toMatchObject({
      supported: true,
      supportedCandidateKeys: [retrievalAnswerabilityCandidateKey(candidate)],
    });
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      supported: true,
      requiredAnswerCues: ["YES_NO"],
    });
  });

  it("maps diagram-view and mandatory-require language inside one bounded evidence unit", () => {
    const candidate = hit(34, {
      title: "AtlasKit selective views",
      excerpt:
        "Las vistas de AtlasKit se seleccionan según la necesidad; no son una lista obligatoria de entregables.",
      contributions: [contribution("vector", 0.87, 4)],
    });
    const result = assessRetrievalAnswerability(
      [candidate],
      "Does AtlasKit require every level of diagram?",
    );

    expect(result).toMatchObject({
      supported: true,
      supportedCandidateKeys: [retrievalAnswerabilityCandidateKey(candidate)],
    });
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      supported: true,
      requiredAnswerCues: ["YES_NO"],
    });
  });

  it("does not treat policy as a rule request when policy is the object of a rationale question", () => {
    const candidate = hit(35, {
      title: "Dependency direction",
      excerpt:
        "Las dependencias apuntan hacia las políticas del dominio para mantenerlas independientes de frameworks y mecanismos externos.",
      contributions: [contribution("vector", 0.88, 3)],
    });
    const result = assessRetrievalAnswerability(
      [candidate],
      "Why do dependencies point inward toward domain policies?",
    );

    expect(result).toMatchObject({
      supported: true,
      supportedCandidateKeys: [retrievalAnswerabilityCandidateKey(candidate)],
    });
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      supported: true,
      requiredAnswerCues: ["RATIONALE"],
    });
  });

  it("still recognizes an explicit policy request as a rule predicate", () => {
    const candidate = hit(36, {
      title: "Retry policy",
      excerpt:
        "The retry policy requires a bounded delay before another attempt.",
      contributions: [contribution("vector", 0.82, 2)],
    });
    const result = assessRetrievalAnswerability(
      [candidate],
      "Which policy governs retry windows?",
    );

    expect(result).toMatchObject({
      supported: true,
      supportedCandidateKeys: [retrievalAnswerabilityCandidateKey(candidate)],
    });
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      supported: true,
      requiredAnswerCues: ["RULE"],
    });
  });

  it("lets a title scope the subject but requires predicate and object in the evidence sentence", () => {
    const candidate = hit(152, {
      title: "Blue widget requirement",
      type: "profile",
      excerpt: "It requires a storage engine for durable state.",
      contributions: [contribution("vector", 0.73, 5)],
    });

    const result = assessRetrievalAnswerability(
      [candidate],
      "Does a blue widget require a storage engine?",
    );

    expect(result).toMatchObject({
      supported: true,
      supportedCandidateKeys: [retrievalAnswerabilityCandidateKey(candidate)],
    });
  });

  it("does not synthesize a relation by taking the object from the title and the predicate from another sentence", () => {
    const candidate = hit(153, {
      title: "Blue widget storage engine practice guide",
      type: "profile",
      excerpt:
        "In practice, a blue widget deployment guide uses a storage engine. The guide does not require the widget itself.",
      contributions: [contribution("vector", 0.72, 4)],
    });

    const result = assessRetrievalAnswerability(
      [candidate],
      "Does a blue widget require a storage engine in practice?",
    );

    expect(result).toMatchObject({
      supported: false,
      supportedCandidateKeys: [],
      reason: "SUPPORT_NOT_DEMONSTRATED",
    });
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      supported: false,
      reason: "ANSWER_CUE_MISMATCH",
      boundedRelationRoleMatched: false,
    });
  });

  it("rejects the same vocabulary when subject, predicate and object form a different relation", () => {
    const correctRelation = hit(38, {
      title: "Local patterns are not architecture",
      excerpt:
        "Strategy and Adapter are local patterns; they do not determine the overall system architecture.",
      contributions: [contribution("vector", 0.91, 1)],
    });
    const wrongRelation = hit(37, {
      title: "Java adapter profile",
      excerpt:
        "The persistence adapter defines a uniqueness strategy for generated record keys.",
      contributions: [contribution("vector", 0.61, 51)],
    });
    const query =
      "Do Strategy and Adapter patterns define the overall system architecture?";

    const result = assessRetrievalAnswerability(
      [correctRelation, wrongRelation],
      query,
    );

    expect(result.supported).toBe(true);
    expect(result.supportedCandidateKeys).toEqual([
      retrievalAnswerabilityCandidateKey(correctRelation),
    ]);
    expect(result.candidateSignals).toEqual([
      expect.objectContaining({
        candidateKey: retrievalAnswerabilityCandidateKey(correctRelation),
        passageSupport: expect.objectContaining({
          supported: true,
          vectorRank: 1,
        }),
      }),
      expect.objectContaining({
        candidateKey: retrievalAnswerabilityCandidateKey(wrongRelation),
        passageSupport: expect.objectContaining({
          supported: false,
          vectorRank: 51,
        }),
      }),
    ]);
  });

  it("keeps vector rank diagnostic instead of using it as a truth boundary", () => {
    const candidate = hit(39, {
      title: "Avoid durable change logs without explicit drivers",
      parentContext:
        "Durable change logs are justified by replay or audit requirements. Without those drivers, they add unjustified operational cost.",
      excerpt: "Without those drivers, they add unjustified operational cost.",
      contributions: [contribution("vector", 0.79, 6)],
    });
    const result = assessRetrievalAnswerability(
      [candidate],
      "When should a durable change log be avoided because of operating cost?",
    );

    expect(result.supported).toBe(true);
    expect(result.supportedCandidateKeys).toEqual([
      retrievalAnswerabilityCandidateKey(candidate),
    ]);
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      supported: true,
      vectorRank: 6,
      requiredAnswerCues: expect.arrayContaining(["PREVENTION", "CONDITION"]),
    });
  });

  it("rescues a machine-supported claim from its atomic passage without treating metadata as evidence", () => {
    const correctClaim = hit(40, {
      title: "Local pattern scope",
      type: "claim",
      trust: "MACHINE_SUPPORTED",
      externalId: "CLM-40",
      excerpt:
        "Strategy y Adapter son patrones locales. No determinan módulos, límites ni la dirección global de dependencias.",
      contributions: [contribution("vector", 0.91, 1)],
    });
    const incidentalProfile = hit(41, {
      title: "Java persistence profile",
      type: "profile",
      externalId: "PRO-41",
      excerpt:
        "The persistence adapter defines a uniqueness strategy for generated record keys.",
      contributions: [contribution("vector", 0.62, 51)],
    });
    const query =
      "Do Strategy and Adapter patterns define the overall system architecture?";

    const result = assessRetrievalAnswerability(
      [correctClaim, incidentalProfile],
      query,
    );

    expect(result.supported).toBe(true);
    expect(result.reason).toBe("CLAIM_RELATION_SUPPORT");
    expect(result.supportedCandidateKeys).toEqual([
      retrievalAnswerabilityCandidateKey(correctClaim),
    ]);
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      supported: true,
      reason: "CLAIM_RELATION_SUPPORT",
      vectorRank: 1,
    });
    expect(result.candidateSignals[1]?.passageSupport).toMatchObject({
      supported: false,
      vectorRank: 51,
    });
  });

  it("parses grammatical modifiers around a yes-no relation without inflating subject overlap", () => {
    const correctClaim = hit(147, {
      title: "Mediator and Facade scope",
      type: "claim",
      trust: "MACHINE_SUPPORTED",
      externalId: "CLM-147",
      excerpt:
        "Mediator y Facade son patrones locales. No determinan módulos, límites ni la dirección global de dependencias.",
      contributions: [contribution("vector", 0.9, 1)],
    });
    const lexicalProfile = hit(148, {
      title: "Facade routing profile",
      type: "profile",
      externalId: "PRO-148",
      excerpt:
        "A facade adapter defines a routing strategy for downstream calls.",
      contributions: [contribution("vector", 0.61, 44)],
    });

    const result = assessRetrievalAnswerability(
      [correctClaim, lexicalProfile],
      "Does using Mediator or Facade define the overall architecture?",
    );

    expect(result.supported).toBe(true);
    expect(result.supportedCandidateKeys).toEqual([
      retrievalAnswerabilityCandidateKey(correctClaim),
    ]);
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      supported: true,
      reason: "CLAIM_RELATION_SUPPORT",
      claimRelationDiagnostics: {
        eligibleClaim: true,
        relationExtracted: true,
        predicateMatched: true,
        subjectAnchorCount: 2,
        subjectOverlap: 2,
        subjectMatched: true,
        queryGlobalScope: true,
        excerptGlobalScope: true,
        objectOrScopeMatched: true,
        supported: true,
      },
    });
    expect(result.candidateSignals[1]?.passageSupport).toMatchObject({
      supported: false,
      claimRelationDiagnostics: expect.objectContaining({
        eligibleClaim: false,
        supported: false,
      }),
    });
  });

  it("matches a specific subject core without treating its generic model head as identity", () => {
    const correctClaim = hit(150, {
      title: "Orion policy selection",
      type: "claim",
      trust: "MACHINE_SUPPORTED",
      externalId: "CLM-150",
      excerpt:
        "Las políticas de Orion se seleccionan según la necesidad; no son obligatorias para cada despliegue.",
      contributions: [contribution("vector", 0.7, 34)],
    });
    const otherModelClaim = hit(151, {
      title: "Atlas policy selection",
      type: "claim",
      trust: "MACHINE_SUPPORTED",
      externalId: "CLM-151",
      excerpt:
        "Las políticas de Atlas se seleccionan según la necesidad; no son obligatorias para cada despliegue.",
      contributions: [contribution("vector", 0.69, 35)],
    });

    const result = assessRetrievalAnswerability(
      [correctClaim, otherModelClaim],
      "Does the Orion model require every policy for each deployment?",
    );

    expect(result.supported).toBe(true);
    expect(result.supportedCandidateKeys).toEqual([
      retrievalAnswerabilityCandidateKey(correctClaim),
    ]);
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      supported: true,
      claimRelationDiagnostics: expect.objectContaining({
        subjectAnchorCount: 1,
        subjectOverlap: 1,
        subjectMatched: true,
        objectOrScopeMatched: true,
        supported: true,
      }),
    });
    expect(result.candidateSignals[1]?.passageSupport).toMatchObject({
      supported: false,
      claimRelationDiagnostics: expect.objectContaining({
        subjectAnchorCount: 1,
        subjectOverlap: 0,
        subjectMatched: false,
        supported: false,
      }),
    });
  });

  it("rejects a reviewed claim with the same subject and predicate but a different object", () => {
    const wrongClaim = hit(42, {
      title: "Local pattern deployment scope",
      type: "claim",
      trust: "MACHINE_SUPPORTED",
      externalId: "CLM-42",
      excerpt:
        "Strategy and Adapter patterns do not determine deployment schedules.",
      contributions: [contribution("vector", 0.9, 1)],
    });
    const result = assessRetrievalAnswerability(
      [wrongClaim],
      "Do Strategy and Adapter patterns define the overall system architecture?",
    );

    expect(result.supported).toBe(false);
    expect(result.supportedCandidateKeys).toEqual([]);
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      supported: false,
      reason: "ANSWER_CUE_MISMATCH",
    });
  });

  it("accepts a machine-supported selective-view claim even at a deep vector rank", () => {
    const claim = hit(145, {
      title: "Atlas selective views",
      type: "claim",
      trust: "MACHINE_SUPPORTED",
      externalId: "CLM-145",
      excerpt:
        "Las vistas de Atlas se seleccionan según la necesidad; no son entregables obligatorios.",
      contributions: [contribution("vector", 0.66, 34)],
    });

    const result = assessRetrievalAnswerability(
      [claim],
      "Does Atlas require every level of diagram for each project?",
    );

    expect(result).toMatchObject({
      supported: true,
      supportedCandidateKeys: [retrievalAnswerabilityCandidateKey(claim)],
    });
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      supported: true,
      vectorRank: 34,
    });
    expect(["PASSAGE_CUE_SUPPORT", "CLAIM_RELATION_SUPPORT"]).toContain(
      result.candidateSignals[0]?.passageSupport.reason,
    );
  });

  it("supports rationale split across an explicitly linked adjacent sentence", () => {
    const claim = hit(146, {
      title: "Dependency direction",
      type: "claim",
      trust: "MACHINE_SUPPORTED",
      externalId: "CLM-146",
      parentContext:
        "Dependencies point toward domain rules rather than framework details. This keeps domain decisions isolated from external mechanisms.",
      excerpt:
        "Dependencies point toward domain rules rather than framework details. This keeps domain decisions isolated from external mechanisms.",
      contributions: [contribution("vector", 0.81, 8)],
    });

    const result = assessRetrievalAnswerability(
      [claim],
      "Why should implementation dependencies point toward domain rules instead of infrastructure details?",
    );

    expect(result).toMatchObject({
      supported: true,
      supportedCandidateKeys: [retrievalAnswerabilityCandidateKey(claim)],
    });
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      supported: true,
      vectorRank: 8,
      requiredAnswerCues: ["RATIONALE"],
    });
  });

  it("accepts a bounded rationale expressed as preventing external detail leakage", () => {
    const claim = hit(149, {
      title: "Dependency boundary",
      type: "claim",
      trust: "MACHINE_SUPPORTED",
      externalId: "CLM-149",
      excerpt:
        "Las dependencias apuntan hacia las políticas del dominio. Los detalles externos no deben filtrar sus nombres o formatos hacia el interior.",
      contributions: [contribution("vector", 0.79, 8)],
    });

    const result = assessRetrievalAnswerability(
      [claim],
      "Why should code dependencies point toward policy rather than external details?",
    );

    expect(result).toMatchObject({
      supported: true,
      supportedCandidateKeys: [retrievalAnswerabilityCandidateKey(claim)],
    });
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      supported: true,
      vectorRank: 8,
      requiredAnswerCues: ["RATIONALE"],
      matchedAnswerCues: ["RATIONALE"],
    });
    expect(
      result.candidateSignals[0]?.passageSupport.boundedAnchorCoverage,
    ).toBeGreaterThanOrEqual(0.4);
  });

  it.each(["rule", "decision-rule"] as const)(
    "applies the same bounded relation proof to support-eligible %s documents",
    (type) => {
      const proposition = hit(type === "rule" ? 909 : 910, {
        title: "Local filters and system architecture",
        type,
        trust: "MACHINE_SUPPORTED",
        externalId: type === "rule" ? "RUL-909" : "DRL-910",
        excerpt:
          "Local filters do not determine modules, boundaries, or global dependency direction.",
        contributions: [contribution("vector", 0.88, 6)],
      });

      const result = assessRetrievalAnswerability(
        [proposition],
        "Do local filters define the overall system architecture?",
      );

      expect(result).toMatchObject({
        supported: true,
        supportedCandidateKeys: [
          retrievalAnswerabilityCandidateKey(proposition),
        ],
      });
      expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
        supported: true,
        reason: "CLAIM_RELATION_SUPPORT",
      });
    },
  );

  it.each([
    {
      name: "shared resource refers to other subjects",
      query: "Can intake and dispatch share a queue?",
      direct: "Intake and dispatch share a durable queue.",
      unrelated:
        "Intake and dispatch monitor two processors, although both processors use the same queue.",
    },
    {
      name: "optionality refers to another component",
      query: "Is a scheduler mandatory for processing jobs?",
      direct: "A scheduler is not mandatory for processing jobs.",
      unrelated: "Jobs run on a scheduler with an optional audit collector.",
    },
    {
      name: "insufficiency is asserted about another subject",
      query: "Does a gateway prove that the architecture is secure?",
      direct: "A gateway does not prove that the architecture is secure.",
      unrelated:
        "A gateway displays notices that a proxy alone is insufficient to establish security of the architecture.",
    },
  ])(
    "keeps $name exploratory while accepting a direct relation",
    ({ query, direct, unrelated }) => {
      const supported = hit(920, {
        title: "Relation assessment",
        type: "claim",
        excerpt: direct,
        contributions: [contribution("vector", 0.8, 2)],
      });
      const distractor = hit(921, {
        title: "Relation assessment",
        type: "claim",
        excerpt: unrelated,
        contributions: [contribution("vector", 0.99, 1)],
      });

      const result = assessRetrievalAnswerability(
        [distractor, supported],
        query,
      );

      expect(result.supportedCandidateKeys).toEqual([
        retrievalAnswerabilityCandidateKey(supported),
      ]);
      expect(result.candidateSignals[0]?.passageSupport.supported).toBe(false);
      expect(result.candidateSignals[1]?.passageSupport.supported).toBe(true);
      expect(assessRetrievalAnswerability([distractor], query).supported).toBe(
        false,
      );
    },
  );

  it("does not apply claim relation fallback to unreviewed claims", () => {
    const unreviewed = hit(43, {
      title: "Local pattern scope",
      type: "claim",
      trust: "UNVERIFIED",
      externalId: "CLM-43",
      excerpt:
        "Strategy y Adapter son patrones locales. No determinan módulos, límites ni la dirección global de dependencias.",
      contributions: [contribution("vector", 0.9, 1)],
    });
    const result = assessRetrievalAnswerability(
      [unreviewed],
      "Do Strategy and Adapter patterns define the overall system architecture?",
    );

    expect(result.supported).toBe(false);
    expect(result.supportedCandidateKeys).toEqual([]);
  });

  it("accepts an explicit bilingual yes-no negation about the same relation", () => {
    const candidate = hit(20, {
      title: "Component scope",
      excerpt:
        "Proxy y Gateway no determinan todo el diseño del sistema; resuelven responsabilidades locales.",
      contributions: [contribution("vector", 0.88, 1)],
    });
    const result = assessRetrievalAnswerability(
      [candidate],
      "Do Proxy and Gateway define the entire system design?",
    );

    expect(result).toMatchObject({
      supported: true,
      supportedCandidateKeys: [retrievalAnswerabilityCandidateKey(candidate)],
    });
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      supported: true,
      requiredAnswerCues: ["YES_NO"],
    });
  });

  it("requires a numeric quantity instead of accepting topical cost language", () => {
    const topical = hit(21, {
      title: "Retry capacity controls",
      excerpt:
        "Retry capacity is governed by traffic policy and bounded load reviews.",
      contributions: [contribution("vector", 0.94, 1)],
    });
    const result = assessRetrievalAnswerability(
      [topical],
      "How many retry attempts are allowed per minute?",
    );

    expect(result).toMatchObject({
      supported: false,
      supportedCandidateKeys: [],
    });
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      supported: false,
      reason: "ANSWER_CUE_MISMATCH",
    });
    expect(
      result.candidateSignals[0]?.passageSupport.requiredAnswerCues,
    ).toContain("QUANTITY");
  });

  it("requires an explicit year when the question asks which year", () => {
    const topical = hit(22, {
      title: "Compatibility window history",
      excerpt: "The compatibility window ended after the migration review.",
      contributions: [contribution("vector", 0.93, 1)],
    });
    const result = assessRetrievalAnswerability(
      [topical],
      "Which year did the compatibility window end?",
    );

    expect(result.supported).toBe(false);
    expect(
      result.candidateSignals[0]?.passageSupport.requiredAnswerCues,
    ).toContain("DATE_YEAR");
  });

  it("requires rationale and relation anchors in the same sentence", () => {
    const thematic = hit(23, {
      title: "Handler overview",
      parentContext:
        "Request handlers are documented for review. A deployment schedule changes because maintenance windows are short.",
      excerpt: "Request handlers are documented for review.",
      contributions: [contribution("vector", 0.91, 1)],
    });
    const correct = hit(24, {
      title: "Handler contract rationale",
      excerpt:
        "Request handlers depend on stable contracts because transport details must remain replaceable.",
      contributions: [contribution("vector", 0.89, 2)],
    });
    const query = "Why do request handlers depend on stable contracts?";
    const result = assessRetrievalAnswerability([thematic, correct], query);

    expect(result.supportedCandidateKeys).toEqual([
      retrievalAnswerabilityCandidateKey(correct),
    ]);
    expect(result.candidateSignals[0]?.passageSupport.supported).toBe(false);
    expect(result.candidateSignals[1]?.passageSupport.supported).toBe(true);
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

  it("does not let structural parent context substitute for the cited atomic unit", () => {
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
      supported: false,
      reason: "SUPPORT_NOT_DEMONSTRATED",
      supportedCandidateKeys: [],
    });
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      passageSource: "EXCERPT",
      supportSurfaceExtendsExcerpt: false,
      supported: false,
    });
  });

  it("uses direct-channel support only for an exact identifier whose identity matches", () => {
    const directBase = hit(1, {
      title: "Canonical rule",
      excerpt: "Unrelated wording.",
      contributions: [contribution("exact"), contribution("vector", 0.6, 1)],
    });
    const direct: SearchHit = {
      ...directBase,
      document: {
        ...directBase.document,
        externalId: "RULE-AUTH-001",
      },
    };
    const unrelatedExact = hit(2, {
      title: "Nearby topic",
      excerpt: "A nearby topic with no direct match.",
      contributions: [contribution("exact"), contribution("vector", 0.59, 2)],
    });
    const result = assessRetrievalAnswerability(
      [direct, unrelatedExact],
      "RULE-AUTH-001",
    );

    expect(result).toMatchObject({
      supported: true,
      reason: "DIRECT_CHANNEL_SUPPORT",
      supportedDocumentIds: [direct.documentId],
    });
    expect(result.supportedCandidateKeys).toEqual([
      retrievalAnswerabilityCandidateKey(direct),
    ]);
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

  it("does not let graph topology substitute for passage evidence", () => {
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
      supported: false,
      reason: "SUPPORT_NOT_DEMONSTRATED",
      supportedDocumentIds: [],
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

  it("keeps query-conditioned verification in shadow mode until promotion", async () => {
    const candidate = hit(40, {
      title: "Bounded semantic relation",
      excerpt:
        "The selected mechanism keeps the domain independent from external frameworks.",
      contributions: [contribution("vector", 0.84, 3)],
    });
    const query =
      "Why does the selected mechanism keep the domain independent?";
    const baseline = assessRetrievalAnswerability([candidate], query);
    const result = await assessRetrievalAnswerabilityWithVerifier(
      [candidate],
      query,
      {
        id: "fixture-verifier",
        async verify(input) {
          return {
            decision: "SUPPORTS",
            score: 0.91,
            evidenceSpan: {
              startOffset: 0,
              endOffset: input.passage.length,
            },
            reason: "fixture support",
          };
        },
      },
      { mode: "SHADOW" },
    );

    expect(result.supported).toBe(baseline.supported);
    expect(result.supportedCandidateKeys).toEqual(
      baseline.supportedCandidateKeys,
    );
    expect(result.candidateSignals[0]?.queryConditionedEvidence).toMatchObject({
      verifierId: "fixture-verifier",
      mode: "SHADOW",
      decision: "SUPPORTS",
    });
  });

  it("passes only the atomic excerpt to a query-conditioned verifier", async () => {
    const candidate = hit(912, {
      title: "Atomic evidence boundary",
      excerpt: "The selected unit contains no recovery guarantee.",
      parentContext:
        "The parent section states that the durable mechanism guarantees recovery after a crash.",
      contributions: [contribution("vector", 0.82, 2)],
    });
    let observedPassage = "";
    await assessRetrievalAnswerabilityWithVerifier(
      [candidate],
      "Does the durable mechanism guarantee recovery after a crash?",
      {
        id: "atomic-boundary-verifier",
        async verify(input) {
          observedPassage = input.passage;
          return {
            decision: "INSUFFICIENT",
            reason: "atomic unit does not answer",
          };
        },
      },
      { mode: "SHADOW" },
    );

    expect(observedPassage).toBe(candidate.excerpt);
    expect(observedPassage).not.toContain("guarantees recovery");
  });

  it("enforces query-conditioned support on the exact candidate relation", async () => {
    const wrong = hit(41, {
      title: "Adapter example",
      excerpt: "The adapter defines a uniqueness strategy for generated keys.",
      contributions: [contribution("vector", 0.93, 1)],
    });
    const correct = hit(42, {
      title: "Architecture boundary",
      excerpt:
        "Local patterns do not determine the overall system architecture.",
      contributions: [contribution("vector", 0.88, 2)],
    });
    const query = "Do local patterns define the overall system architecture?";
    const correctKey = retrievalAnswerabilityCandidateKey(correct);
    const result = await assessRetrievalAnswerabilityWithVerifier(
      [wrong, correct],
      query,
      {
        id: "fixture-verifier",
        async verify(input) {
          if (input.candidateKey === correctKey) {
            return {
              decision: "SUPPORTS",
              evidenceSpan: {
                startOffset: 0,
                endOffset: input.passage.length,
              },
              reason: "relation is answered",
            };
          }
          return {
            decision: "INSUFFICIENT",
            reason: "same vocabulary, different relation",
          };
        },
      },
      { mode: "ENFORCE" },
    );

    expect(result.supportedCandidateKeys).toEqual([correctKey]);
    expect(result.candidateSignals).toEqual([
      expect.objectContaining({
        candidateKey: retrievalAnswerabilityCandidateKey(wrong),
        passageSupport: expect.objectContaining({
          supported: false,
          reason: "QUERY_CONDITIONED_INSUFFICIENT",
        }),
      }),
      expect.objectContaining({
        candidateKey: correctKey,
        passageSupport: expect.objectContaining({
          supported: true,
          reason: "QUERY_CONDITIONED_SUPPORT",
        }),
        queryConditionedEvidence: expect.objectContaining({
          decision: "SUPPORTS",
          evidenceSpan: {
            startOffset: 0,
            endOffset: correct.excerpt.length,
          },
        }),
      }),
    ]);
  });

  it.each([
    [
      "What is the monthly operating cost of the subsystem?",
      "The inventory contains 72 machines. The monthly operating cost is reviewed regularly.",
      "The monthly operating cost is reviewed regularly.",
    ],
    [
      "Which year did the review start?",
      "The policy was stored in 2020. The review start is unspecified.",
      "The review start is unspecified.",
    ],
  ])(
    "does not borrow a required exact fact from outside the verified span: %s",
    async (query, excerpt, quote) => {
      const candidate = hit(914, {
        title: "Operational record",
        excerpt,
        contributions: [contribution("vector", 0.9, 1)],
      });
      const result = await assessRetrievalAnswerabilityWithVerifier(
        [candidate],
        query,
        {
          id: "overconfident-verifier",
          verify: async () => ({
            decision: "SUPPORTS",
            reason: "fixture",
            evidenceSpan: {
              startOffset: excerpt.indexOf(quote),
              endOffset: excerpt.indexOf(quote) + quote.length,
            },
          }),
        },
        { mode: "ENFORCE" },
      );
      expect(result.supported).toBe(false);
      expect(result.candidateSignals[0]?.queryConditionedEvidence?.reason).toBe(
        "EVIDENCE_SPAN_MISSING_REQUIRED_FACT",
      );
    },
  );

  it("checks the actual reader quote rather than a whole-line envelope", async () => {
    const candidate = hit(916, {
      title: "Operational record",
      excerpt:
        "The inventory contains 72 machines. The monthly operating cost is reviewed regularly.",
      contributions: [contribution("vector", 0.9, 1)],
    });
    const verifier = new ReaderEvidenceVerifier({
      reader: {
        id: "reader",
        judge: async () => ({
          answers: true,
          quote: "The monthly operating cost is reviewed regularly.",
        }),
      },
    });
    const result = await assessRetrievalAnswerabilityWithVerifier(
      [candidate],
      "What is the monthly operating cost of the subsystem?",
      verifier,
      { mode: "ENFORCE" },
    );
    expect(result.supported).toBe(false);
    expect(result.candidateSignals[0]?.queryConditionedEvidence?.reason).toBe(
      "EVIDENCE_SPAN_MISSING_REQUIRED_FACT",
    );
  });

  it("retains an exact quantity inside the selected evidence span", async () => {
    const excerpt =
      "The inventory contains 72 machines. The monthly operating cost is 90 euros.";
    const quote = "The monthly operating cost is 90 euros.";
    const candidate = hit(915, {
      title: "Operational record",
      excerpt,
      contributions: [contribution("vector", 0.9, 1)],
    });
    const result = await assessRetrievalAnswerabilityWithVerifier(
      [candidate],
      "What is the monthly operating cost of the subsystem?",
      {
        id: "quantity-verifier",
        verify: async () => ({
          decision: "SUPPORTS",
          reason: "fixture",
          evidenceSpan: {
            startOffset: excerpt.indexOf(quote),
            endOffset: excerpt.length,
          },
        }),
      },
      { mode: "ENFORCE" },
    );
    expect(result.supportedCandidateKeys).toEqual([
      retrievalAnswerabilityCandidateKey(candidate),
    ]);
  });

  it("does not let a query-conditioned verifier override a missing quantity", async () => {
    const candidate = hit(43, {
      title: "Operating cost overview",
      excerpt:
        "The subsystem has recurring operating cost, reviewed each month.",
      contributions: [contribution("vector", 0.9, 1)],
    });
    const result = await assessRetrievalAnswerabilityWithVerifier(
      [candidate],
      "What is the monthly operating cost of the subsystem?",
      {
        id: "fixture-verifier",
        async verify(input) {
          return {
            decision: "SUPPORTS",
            score: 0.99,
            evidenceSpan: {
              startOffset: 0,
              endOffset: input.passage.length,
            },
            reason: "model claims support",
          };
        },
      },
      { mode: "ENFORCE" },
    );

    expect(result.supported).toBe(false);
    expect(result.supportedCandidateKeys).toEqual([]);
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      supported: false,
      reason: "QUERY_CONDITIONED_INSUFFICIENT",
    });
  });

  it("fails query-conditioned promotion closed when SUPPORTS lacks an evidence span", async () => {
    const candidate = hit(44, {
      title: "Scoped rule",
      excerpt: "The scoped rule applies only after approval.",
      contributions: [contribution("vector", 0.8, 1)],
    });
    const result = await assessRetrievalAnswerabilityWithVerifier(
      [candidate],
      "When does the scoped rule apply?",
      {
        id: "fixture-verifier",
        async verify() {
          return {
            decision: "SUPPORTS",
            reason: "score-only support is not inspectable",
          };
        },
      },
      { mode: "ENFORCE" },
    );

    expect(result.supported).toBe(false);
    expect(result.candidateSignals[0]?.queryConditionedEvidence).toMatchObject({
      decision: "VERIFIER_ERROR",
      reason: "QUERY_CONDITIONED_EVIDENCE_SPAN_REQUIRED",
    });
    expect(result.candidateSignals[0]?.passageSupport.reason).toBe(
      "QUERY_CONDITIONED_VERIFIER_ERROR",
    );
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
  });
});

describe("requirement absence evidence", () => {
  it("keeps implicit capability-without claims exploratory until the predicate is demonstrated", () => {
    const optionalScheduler = hit(1871, {
      title: "Ejecución de trabajos",
      type: "claim",
      excerpt:
        "Los trabajos pueden procesarse directamente sin scheduler; incorporarlo es una opción operativa.",
      contributions: [contribution("lexical")],
    });
    const optionalCollector = hit(1872, {
      title: "Ejecución de trabajos",
      type: "claim",
      excerpt:
        "Los trabajos pueden procesarse con scheduler sin un recolector de auditoría.",
      contributions: [contribution("lexical")],
    });

    const result = assessRetrievalAnswerability(
      [optionalCollector, optionalScheduler],
      "¿Es obligatorio usar un scheduler para procesar trabajos?",
    );

    expect(result.supportedCandidateKeys).toEqual([]);
    expect(result.candidateSignals[0]?.passageSupport.supported).toBe(false);
  });

  it("does not use a capability word as a general requirement proof", () => {
    const optionalChecksum = hit(1873, {
      title: "Record validation",
      type: "claim",
      excerpt: "Record validation can continue without a checksum.",
      contributions: [contribution("lexical")],
    });
    const unrelatedAbsence = hit(1874, {
      title: "Record validation",
      type: "claim",
      excerpt:
        "Record validation can continue with a checksum without an audit marker.",
      contributions: [contribution("lexical")],
    });

    const result = assessRetrievalAnswerability(
      [unrelatedAbsence, optionalChecksum],
      "Is a checksum mandatory for record validation?",
    );

    expect(result.supportedCandidateKeys).toEqual([]);
    expect(result.candidateSignals[0]?.passageSupport.supported).toBe(false);
  });
});

describe("conditional table evidence", () => {
  it("binds condition and decision cells in the same row without admitting a metric table", () => {
    const decision = hit(1901, {
      title: "Partitioned dispatch selection",
      type: "rule",
      unitType: "TABLE",
      excerpt:
        "| Observed situation | Decision |\n|---|---|\n| Independent destinations with bursty traffic | Select partitioned dispatch |\n| One stable destination with small constant load | Use a single consumer |",
      contributions: [contribution("lexical")],
    });
    const metrics = hit(1902, {
      title: "Partitioned dispatch selection",
      type: "rule",
      unitType: "TABLE",
      excerpt:
        "| Metric | Recorded value |\n|---|---|\n| Partitioned dispatch | Queue length |\n| Single consumer | Delivery count |",
      contributions: [contribution("lexical")],
    });

    const result = assessRetrievalAnswerability(
      [decision, metrics],
      "When should partitioned dispatch be selected?",
    );

    expect(result.supportedCandidateKeys).toEqual([
      retrievalAnswerabilityCandidateKey(decision),
    ]);
    expect(result.candidateSignals[0]?.passageSupport).toMatchObject({
      supported: true,
      matchedAnswerCues: ["CONDITION"],
    });
    expect(result.candidateSignals[1]?.passageSupport.supported).toBe(false);
  });

  it("uses bilingual condition and decision headers without admitting metric tables", () => {
    const decision = hit(1903, {
      title: "Batched delivery selection",
      type: "decision-rule",
      unitType: "TABLE",
      excerpt:
        "| Situación observada | Decisión |\n|---|---|\n| Varias entregas pequeñas al mismo destino | Seleccionar batched delivery |\n| Una entrega urgente independiente | Enviar directamente |",
      contributions: [contribution("lexical")],
    });
    const metrics = hit(1904, {
      title: "Batched delivery selection",
      type: "decision-rule",
      unitType: "TABLE",
      excerpt:
        "| Métrica | Valor registrado |\n|---|---|\n| Batched delivery | Número de entregas |\n| Envío directo | Duración observada |",
      contributions: [contribution("lexical")],
    });

    const result = assessRetrievalAnswerability(
      [decision, metrics],
      "When should batched delivery be selected?",
    );

    expect(result.supportedCandidateKeys).toEqual([
      retrievalAnswerabilityCandidateKey(decision),
    ]);
    expect(result.candidateSignals[1]?.passageSupport.supported).toBe(false);
  });

  it("binds condition and decision cells outside the dispatch domain", () => {
    const decision = hit(1906, {
      title: "Reconciliation policy",
      type: "decision-rule",
      unitType: "TABLE",
      excerpt:
        "| Condition | Decision |\n|---|---|\n| Settlement mismatch after the cutoff | Select manual reconciliation |\n| Matched settlement within the cutoff | Continue automatically |",
      contributions: [contribution("lexical")],
    });
    const metrics = hit(1907, {
      title: "Reconciliation metrics",
      type: "decision-rule",
      unitType: "TABLE",
      excerpt:
        "| Metric | Recorded value |\n|---|---|\n| Manual reconciliation | Case count |\n| Automatic processing | Duration |",
      contributions: [contribution("lexical")],
    });

    const result = assessRetrievalAnswerability(
      [decision, metrics],
      "When should manual reconciliation be selected?",
    );

    expect(result.supportedCandidateKeys).toEqual([
      retrievalAnswerabilityCandidateKey(decision),
    ]);
    expect(result.candidateSignals[1]?.passageSupport.supported).toBe(false);
  });

  it("does not borrow target anchors from the condition cell", () => {
    const candidate = hit(1905, {
      title: "Partitioned dispatch selection",
      type: "rule",
      unitType: "TABLE",
      excerpt:
        "| Observed situation | Decision |\n|---|---|\n| Partitioned dispatch with bursty traffic | Use a single consumer |",
      contributions: [contribution("lexical")],
    });

    expect(
      assessRetrievalAnswerability(
        [candidate],
        "When should partitioned dispatch be selected?",
      ).supported,
    ).toBe(false);
  });
});

describe("questions are not evidence assertions", () => {
  it.each([
    "Can ALFA call BETA?",
    "Do delivery workers share one queue?",
    "Does a lease require renewal?",
  ])("rejects a source that only repeats %s", (query) => {
    const candidate = hit(2001, {
      title: "Open questions",
      type: "claim",
      excerpt: query,
      contributions: [contribution("lexical")],
    });
    expect(assessRetrievalAnswerability([candidate], query).supported).toBe(
      false,
    );
  });
});

describe("requirement absence predicate boundaries", () => {
  it.each([
    "Record validation reports can be viewed without a checksum.",
    "Record validation can be simulated without a checksum.",
    "Record validation can continue without a checksummer.",
  ])("does not infer validation requirements from %s", (excerpt) => {
    const candidate = hit(2010, {
      title: "Record validation",
      type: "claim",
      excerpt,
      contributions: [contribution("lexical")],
    });
    expect(
      assessRetrievalAnswerability(
        [candidate],
        "Is a checksum mandatory for record validation?",
      ).supported,
    ).toBe(false);
  });
});

describe("table assertion boundaries", () => {
  it.each([
    "Should manual reconciliation be selected?",
    '"Select manual reconciliation?"',
  ])("does not accept a decision cell containing only %s", (decision) => {
    const candidate = hit(2011, {
      title: "Reconciliation policy",
      type: "decision-rule",
      unitType: "TABLE",
      excerpt: `| Condition | Decision |\n|---|---|\n| Settlement mismatch | ${decision} |`,
      contributions: [contribution("lexical")],
    });
    expect(
      assessRetrievalAnswerability(
        [candidate],
        "When should manual reconciliation be selected?",
      ).supported,
    ).toBe(false);
  });

  it("does not infer a decision from a decision-count metric", () => {
    const candidate = hit(2012, {
      title: "Reconciliation metrics",
      type: "dashboard",
      unitType: "TABLE",
      excerpt:
        "| Condition | Decision count |\n|---|---|\n| Settlement mismatch | Manual reconciliation: 12 |",
      contributions: [contribution("lexical")],
    });
    expect(
      assessRetrievalAnswerability(
        [candidate],
        "When should manual reconciliation be selected?",
      ).supported,
    ).toBe(false);
  });
});

describe("interrogative formatting and sentence boundaries", () => {
  it.each([
    '"Can ALFA call BETA?"',
    "**Can ALFA call BETA?**",
    "Can ALFA call BETA？",
    "Can ALFA call BETA؟",
    '"Can ALFA call BETA?" The deployment is still under review.',
    "Can ALFA call BETA?\nThe deployment is still under review.",
  ])("does not turn an open question into a claim: %s", (excerpt) => {
    const candidate = hit(2013, {
      title: "Open integration questions",
      type: "claim",
      excerpt,
      contributions: [contribution("lexical")],
    });
    expect(
      assessRetrievalAnswerability([candidate], "Can ALFA call BETA?")
        .supported,
    ).toBe(false);
  });

  it("preserves an actual answer following an interrogative", () => {
    const candidate = hit(2014, {
      title: "Integration decision",
      type: "claim",
      excerpt: "Can ALFA call BETA? ALFA can call BETA during reconciliation.",
      contributions: [contribution("lexical")],
    });
    expect(
      assessRetrievalAnswerability([candidate], "Can ALFA call BETA?")
        .supported,
    ).toBe(true);
  });
});

describe("reader assertion boundaries", () => {
  it.each([
    "Can ALFA call BETA?",
    "Can ALFA call BETA？",
    "Can ALFA call BETA؟",
  ])(
    "rejects a verifier that calls an open question evidence: %s",
    async (excerpt) => {
      const candidate = hit(2020, {
        type: "claim",
        unitType: "CLAIM",
        excerpt,
      });
      const result = await assessRetrievalAnswerabilityWithVerifier(
        [candidate],
        "Can ALFA call BETA?",
        {
          id: "adversarial-reader",
          verify: async () => ({
            decision: "SUPPORTS",
            reason: "FIXTURE_VERDICT",
            score: 1,
            evidenceSpan: { startOffset: 0, endOffset: excerpt.length },
          }),
        },
        { mode: "ENFORCE" },
      );
      expect(result.supported).toBe(false);
      expect(result.candidateSignals[0]?.queryConditionedEvidence?.reason).toBe(
        "EVIDENCE_SPAN_NOT_ASSERTION",
      );
    },
  );
});

describe("reference-only punctuation boundaries", () => {
  it.each([
    "[[Ops/controller-acceptance]].",
    "[[Ops/controller-acceptance]] and [[Ops/decoder-acceptance]].",
    "[Controller acceptance](ops/controller-acceptance.md).",
    ". — …",
  ])(
    "does not use a title to turn a pointer into an assertion: %s",
    (excerpt) => {
      const candidate = hit(2030, {
        title: "Controller decoder releases",
        type: "adr",
        excerpt,
        contributions: [contribution("lexical")],
      });
      const result = assessRetrievalAnswerability(
        [candidate],
        "Which decoder release does the controller use?",
      );
      expect(result.supported).toBe(false);
      expect(result.candidateSignals[0]?.passageSupport.reason).toBe(
        "NO_CONCRETE_PASSAGE",
      );
    },
  );
});
