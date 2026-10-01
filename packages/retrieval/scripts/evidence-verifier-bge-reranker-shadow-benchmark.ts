import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { SearchHit } from "@akp/contracts";
import {
  buildEvidenceRelationHypotheses,
  evidenceSentenceWindows,
  resolveLocalSemanticCacheDir,
  verifyDeterministicPassageSupport,
} from "../src/index.js";

type Split = "CALIBRATION" | "HOLDOUT";
type Strategy =
  | "PASSAGE_ONLY"
  | "TITLE_PLUS_PASSAGE"
  | "QUERY_MINUS_TITLE"
  | "RELATION_POLARITY";

type Candidate = {
  label: string;
  title: string;
  passage: string;
  language?: "en" | "es";
  goldSpan?: string;
};

type Case = {
  id: string;
  split: Split;
  family: string;
  query: string;
  queryLanguage?: "en" | "es";
  candidates: Candidate[];
  goldLabels: string[];
};

const MODEL = "onnx-community/bge-reranker-v2-m3-ONNX";
const REVISION = "6f5ff65298512715a1e669753bc754d2bc8f367b";
const BINARY_ENTAILMENT_MODEL = "23donge/bge-m3-zeroshot-v2.0-onnx-int8";
const BINARY_ENTAILMENT_REVISION = "84ceaae57bca4ccc6478cf87a8e49c076150098f";
const BINARY_ENTAILMENT_UPSTREAM = "MoritzLaurer/bge-m3-zeroshot-v2.0";

const CASES: Case[] = [
  {
    id: "cal-direct-route",
    split: "CALIBRATION",
    family: "DIRECT_RELATION",
    query: "Can ALTO route BRIO?",
    candidates: [
      {
        label: "direct",
        title: "ALTO integration",
        passage: "ALTO can route BRIO after validation.",
        goldSpan: "ALTO can route BRIO after validation.",
      },
      {
        label: "catalog",
        title: "ALTO and BRIO catalog",
        passage: "ALTO and BRIO are listed in separate operational reports.",
      },
    ],
    goldLabels: ["direct"],
  },
  {
    id: "cal-reversed-route",
    split: "CALIBRATION",
    family: "DIRECTION",
    query: "Can VELA call RINO?",
    candidates: [
      {
        label: "reverse",
        title: "RINO integration",
        passage: "RINO can call VELA during reconciliation.",
      },
    ],
    goldLabels: [],
  },
  {
    id: "cal-shared-buffer",
    split: "CALIBRATION",
    family: "PARAPHRASE_RELATION",
    query: "Can intake and dispatch share a buffer?",
    candidates: [
      {
        label: "shared",
        title: "Distinct processing responsibilities",
        passage:
          "Intake and dispatch remain separate responsibilities, although both can use the same durable buffer.",
        goldSpan:
          "Intake and dispatch remain separate responsibilities, although both can use the same durable buffer.",
      },
      {
        label: "monitoring",
        title: "Buffer operations",
        passage: "Intake and dispatch buffer depths are monitored separately.",
      },
    ],
    goldLabels: ["shared"],
  },
  {
    id: "cal-optional-lease",
    split: "CALIBRATION",
    family: "MODALITY_NEGATION",
    query: "Is a lease renewal mandatory for every job?",
    candidates: [
      {
        label: "optional",
        title: "Job execution",
        passage:
          "Jobs can continue without a lease renewal; renewing the lease is an optional operating safeguard.",
        goldSpan: "Jobs can continue without a lease renewal;",
      },
      {
        label: "metrics",
        title: "Lease metrics",
        passage: "Lease renewal latency is recorded for every completed job.",
      },
    ],
    goldLabels: ["optional"],
  },
  {
    id: "cal-insufficient-component",
    split: "CALIBRATION",
    family: "NEGATED_INFERENCE",
    query: "Does a filter prove that a platform is compliant?",
    candidates: [
      {
        label: "insufficient",
        title: "Compliance assessment",
        passage:
          "A request filter alone is insufficient to establish compliance of the platform.",
        goldSpan:
          "A request filter alone is insufficient to establish compliance of the platform.",
      },
      {
        label: "catalog",
        title: "Filter catalog",
        passage:
          "Request filters are listed in the compliance component catalog.",
      },
    ],
    goldLabels: ["insufficient"],
  },
  {
    id: "cal-indirect-change",
    split: "CALIBRATION",
    family: "CROSS_LINGUAL_PARAPHRASE",
    query: "Does a focused handler reduce reasons to change?",
    queryLanguage: "en",
    candidates: [
      {
        label: "focused",
        title: "Focused handlers",
        passage:
          "Un manejador con una sola responsabilidad concentra sus cambios en un único motivo de negocio.",
        language: "es",
        goldSpan:
          "Un manejador con una sola responsabilidad concentra sus cambios en un único motivo de negocio.",
      },
    ],
    goldLabels: ["focused"],
  },
  {
    id: "cal-crosslingual-direct-notify",
    split: "CALIBRATION",
    family: "CROSS_LINGUAL_DIRECT_RELATION",
    query: "Can ZENO notify PAVA?",
    queryLanguage: "en",
    candidates: [
      {
        label: "cross-direct",
        title: "Integración ZENO",
        passage: "ZENO puede notificar a PAVA después de validar la entrega.",
        language: "es",
        goldSpan: "ZENO puede notificar a PAVA después de validar la entrega.",
      },
      {
        label: "cross-topic",
        title: "Catálogo ZENO y PAVA",
        passage: "ZENO y PAVA aparecen en informes operativos separados.",
        language: "es",
      },
    ],
    goldLabels: ["cross-direct"],
  },
  {
    id: "cal-crosslingual-reversed-call",
    split: "CALIBRATION",
    family: "CROSS_LINGUAL_DIRECTION",
    query: "Can RIVA call TOMA?",
    queryLanguage: "en",
    candidates: [
      {
        label: "cross-reverse",
        title: "Integración TOMA",
        passage: "TOMA puede llamar a RIVA durante la conciliación.",
        language: "es",
      },
    ],
    goldLabels: [],
  },
  {
    id: "cal-crosslingual-indirect-change",
    split: "CALIBRATION",
    family: "CROSS_LINGUAL_PARAPHRASE",
    query:
      "¿Un componente con una sola finalidad reduce los motivos de cambio?",
    queryLanguage: "es",
    candidates: [
      {
        label: "cross-indirect",
        title: "Single-responsibility components",
        passage:
          "A single-responsibility component confines modifications to one business reason.",
        language: "en",
        goldSpan:
          "A single-responsibility component confines modifications to one business reason.",
      },
    ],
    goldLabels: ["cross-indirect"],
  },
  {
    id: "cal-crosslingual-topical-resilience",
    split: "CALIBRATION",
    family: "CROSS_LINGUAL_HARD_NEGATIVE",
    query: "¿Un gateway demuestra que el servicio es resiliente?",
    queryLanguage: "es",
    candidates: [
      {
        label: "cross-topical",
        title: "Gateway resilience",
        passage:
          "The gateway records resilience metrics and downstream health counters.",
        language: "en",
      },
    ],
    goldLabels: [],
  },
  {
    id: "cal-crosslingual-topical-availability",
    split: "CALIBRATION",
    family: "CROSS_LINGUAL_HARD_NEGATIVE",
    query: "Does a relay prove that the service is available?",
    queryLanguage: "en",
    candidates: [
      {
        label: "cross-availability-topic",
        title: "Métricas del relay",
        passage:
          "El relay registra métricas de disponibilidad y latencia del servicio.",
        language: "es",
      },
    ],
    goldLabels: [],
  },
  {
    id: "cal-crosslingual-direct-sync",
    split: "CALIBRATION",
    family: "CROSS_LINGUAL_DIRECT_RELATION",
    query: "¿Puede BORA sincronizar TELA?",
    queryLanguage: "es",
    candidates: [
      {
        label: "cross-sync",
        title: "BORA synchronization",
        passage: "BORA can synchronize TELA after validation.",
        language: "en",
        goldSpan: "BORA can synchronize TELA after validation.",
      },
      {
        label: "cross-sync-topic",
        title: "BORA and TELA inventory",
        passage: "BORA and TELA are listed in the same inventory.",
        language: "en",
      },
    ],
    goldLabels: ["cross-sync"],
  },
  {
    id: "cal-en-es-bounded-mailbox-backpressure",
    split: "CALIBRATION",
    family: "CROSS_LINGUAL_PARAPHRASE",
    query: "Does a bounded mailbox reduce overload propagation?",
    queryLanguage: "en",
    candidates: [
      {
        label: "bounded-mailbox",
        title: "Buzón acotado",
        passage:
          "Un buzón con capacidad limitada desacopla a los productores y evita que las ráfagas propaguen sobrecarga al consumidor.",
        language: "es",
        goldSpan:
          "Un buzón con capacidad limitada desacopla a los productores y evita que las ráfagas propaguen sobrecarga al consumidor.",
      },
      {
        label: "bounded-mailbox-topic",
        title: "Métricas del buzón",
        passage:
          "El buzón con capacidad limitada registra profundidad de cola, productores activos y tiempos de espera.",
        language: "es",
      },
    ],
    goldLabels: ["bounded-mailbox"],
  },
  {
    id: "cal-en-es-read-through-cache-fetches",
    split: "CALIBRATION",
    family: "CROSS_LINGUAL_PARAPHRASE",
    query: "Does a read-through cache reduce repeated backend fetches?",
    queryLanguage: "en",
    candidates: [
      {
        label: "read-through-cache",
        title: "Caché de lectura",
        passage:
          "Una caché de lectura conserva respuestas recientes y evita consultas repetidas al servicio de origen.",
        language: "es",
        goldSpan:
          "Una caché de lectura conserva respuestas recientes y evita consultas repetidas al servicio de origen.",
      },
      {
        label: "read-through-cache-topic",
        title: "Métricas de caché",
        passage:
          "La caché de lectura registra la tasa de aciertos, el tamaño y la latencia de cada consulta.",
        language: "es",
      },
    ],
    goldLabels: ["read-through-cache"],
  },
  {
    id: "cal-en-es-isolated-retries-pressure",
    split: "CALIBRATION",
    family: "CROSS_LINGUAL_PARAPHRASE",
    query: "Does isolating retries reduce cascading pressure?",
    queryLanguage: "en",
    candidates: [
      {
        label: "isolated-retries",
        title: "Reintentos aislados",
        passage:
          "Aislar los reintentos en un ejecutor dedicado limita que su presión se propague a otros flujos.",
        language: "es",
        goldSpan:
          "Aislar los reintentos en un ejecutor dedicado limita que su presión se propague a otros flujos.",
      },
      {
        label: "isolated-retries-topic",
        title: "Métricas de reintentos",
        passage:
          "El ejecutor de reintentos registra latencia, cantidad de intentos y códigos de error.",
        language: "es",
      },
    ],
    goldLabels: ["isolated-retries"],
  },
  {
    id: "cal-same-entities-other-relation",
    split: "CALIBRATION",
    family: "HARD_NEGATIVE",
    query: "Can NARA publish TERO?",
    candidates: [
      {
        label: "other",
        title: "NARA and TERO",
        passage: "NARA and TERO are reviewed by the same audit team.",
      },
    ],
    goldLabels: [],
  },
  {
    id: "cal-topical-negation",
    split: "CALIBRATION",
    family: "HARD_NEGATIVE",
    query: "Does a gateway prove that the service is resilient?",
    candidates: [
      {
        label: "topical",
        title: "Resilience gateway",
        passage:
          "The gateway records resilience metrics for requests and downstream calls.",
      },
    ],
    goldLabels: [],
  },
  {
    id: "holdout-shared-queue",
    split: "HOLDOUT",
    family: "PARAPHRASE_RELATION",
    query: "Can ingestion and delivery share a queue?",
    candidates: [
      {
        label: "shared-queue",
        title: "Distinct processing responsibilities",
        passage:
          "Ingestion and delivery remain separate responsibilities, although both can use the same durable queue.",
        goldSpan:
          "Ingestion and delivery remain separate responsibilities, although both can use the same durable queue.",
      },
      {
        label: "queue-topic",
        title: "Queue operations",
        passage:
          "Ingestion and delivery queue depths are monitored separately.",
      },
    ],
    goldLabels: ["shared-queue"],
  },
  {
    id: "holdout-optional-scheduler",
    split: "HOLDOUT",
    family: "MODALITY_NEGATION",
    query: "¿Es obligatorio usar un scheduler para procesar trabajos?",
    queryLanguage: "es",
    candidates: [
      {
        label: "scheduler-optional",
        title: "Ejecución de trabajos",
        passage:
          "Los trabajos pueden procesarse directamente sin scheduler; incorporarlo es una opción operativa.",
        goldSpan: "Los trabajos pueden procesarse directamente sin scheduler;",
      },
      {
        label: "scheduler-topic",
        title: "Scheduler",
        passage:
          "El scheduler registra tiempos de ejecución y métricas de los trabajos.",
      },
    ],
    goldLabels: ["scheduler-optional"],
  },
  {
    id: "holdout-component-whole",
    split: "HOLDOUT",
    family: "NEGATED_INFERENCE",
    query: "Does middleware prove that an architecture is secure?",
    candidates: [
      {
        label: "insufficient-component",
        title: "Security assessment",
        passage:
          "Middleware alone is insufficient to establish security of the architecture.",
        goldSpan:
          "Middleware alone is insufficient to establish security of the architecture.",
      },
      {
        label: "thematic-component",
        title: "Middleware catalog",
        passage:
          "Middleware components are listed in the secure architecture catalog.",
      },
    ],
    goldLabels: ["insufficient-component"],
  },
  {
    id: "holdout-indirect-responsibility",
    split: "HOLDOUT",
    family: "CROSS_LINGUAL_PARAPHRASE",
    query: "Does a single-purpose module reduce reasons to change?",
    queryLanguage: "en",
    candidates: [
      {
        label: "indirect",
        title: "Single-purpose modules",
        passage:
          "Un módulo con una sola responsabilidad concentra sus cambios en un único motivo de negocio.",
        language: "es",
        goldSpan:
          "Un módulo con una sola responsabilidad concentra sus cambios en un único motivo de negocio.",
      },
    ],
    goldLabels: ["indirect"],
  },
  {
    id: "holdout-crosslingual-direct-publish",
    split: "HOLDOUT",
    family: "CROSS_LINGUAL_DIRECT_RELATION",
    query: "¿Puede LENO publicar VIRA?",
    queryLanguage: "es",
    candidates: [
      {
        label: "cross-publish",
        title: "LENO publishing",
        passage: "LENO can publish VIRA after approval.",
        language: "en",
        goldSpan: "LENO can publish VIRA after approval.",
      },
      {
        label: "cross-publish-topic",
        title: "LENO and VIRA catalog",
        passage: "LENO and VIRA are listed in separate operational reports.",
        language: "en",
      },
    ],
    goldLabels: ["cross-publish"],
  },
  {
    id: "holdout-crosslingual-reversed-invoke",
    split: "HOLDOUT",
    family: "CROSS_LINGUAL_DIRECTION",
    query: "¿Puede NORA invocar SIDO?",
    queryLanguage: "es",
    candidates: [
      {
        label: "cross-invoke-reverse",
        title: "SIDO integration",
        passage: "SIDO can invoke NORA during reconciliation.",
        language: "en",
      },
    ],
    goldLabels: [],
  },
  {
    id: "holdout-crosslingual-indirect-change",
    split: "HOLDOUT",
    family: "CROSS_LINGUAL_PARAPHRASE",
    query: "Does a narrowly scoped service reduce reasons to change?",
    queryLanguage: "en",
    candidates: [
      {
        label: "cross-service",
        title: "Servicios acotados",
        passage:
          "Un servicio dedicado a una sola responsabilidad concentra sus cambios en un único motivo de negocio.",
        language: "es",
        goldSpan:
          "Un servicio dedicado a una sola responsabilidad concentra sus cambios en un único motivo de negocio.",
      },
    ],
    goldLabels: ["cross-service"],
  },
  {
    id: "holdout-crosslingual-topical-security",
    split: "HOLDOUT",
    family: "CROSS_LINGUAL_HARD_NEGATIVE",
    query: "Does a proxy prove that the platform is secure?",
    queryLanguage: "en",
    candidates: [
      {
        label: "cross-security-topic",
        title: "Métricas del proxy",
        passage:
          "El proxy registra métricas de sesiones seguras y contadores de salud.",
        language: "es",
      },
    ],
    goldLabels: [],
  },
  {
    id: "holdout-crosslingual-topical-reliability",
    split: "HOLDOUT",
    family: "CROSS_LINGUAL_HARD_NEGATIVE",
    query: "Does a gateway prove that the system is reliable?",
    queryLanguage: "en",
    candidates: [
      {
        label: "cross-reliability-topic",
        title: "Métricas del gateway",
        passage:
          "El gateway registra métricas de confiabilidad y latencia del sistema.",
        language: "es",
      },
    ],
    goldLabels: [],
  },
  {
    id: "holdout-crosslingual-indirect-service-es-en",
    split: "HOLDOUT",
    family: "CROSS_LINGUAL_PARAPHRASE",
    query:
      "¿Un servicio con una sola responsabilidad reduce los motivos de cambio?",
    queryLanguage: "es",
    candidates: [
      {
        label: "cross-service-es-en",
        title: "Single-responsibility service",
        passage:
          "A single-responsibility service confines changes to one business reason.",
        language: "en",
        goldSpan:
          "A single-responsibility service confines changes to one business reason.",
      },
      {
        label: "cross-service-es-en-topic",
        title: "Service catalog",
        passage:
          "Single-responsibility services are cataloged by the architecture team.",
        language: "en",
      },
    ],
    goldLabels: ["cross-service-es-en"],
  },
  {
    id: "holdout-reversed",
    split: "HOLDOUT",
    family: "DIRECTION",
    query: "Can ORCA call LUMA?",
    candidates: [
      {
        label: "reverse",
        title: "LUMA integration",
        passage: "LUMA can call ORCA during reconciliation.",
      },
    ],
    goldLabels: [],
  },
  {
    id: "holdout-same-entities-other-relation",
    split: "HOLDOUT",
    family: "HARD_NEGATIVE",
    query: "Can SORA invoke MIRA?",
    candidates: [
      {
        label: "catalog",
        title: "SORA and MIRA catalog",
        passage:
          "SORA and MIRA are deployed in the same region and share an operations dashboard.",
      },
    ],
    goldLabels: [],
  },
  {
    id: "holdout-span-selection",
    split: "HOLDOUT",
    family: "SPAN_SELECTION",
    query: "Can PICO use TALA?",
    candidates: [
      {
        label: "mixed",
        title: "PICO integration",
        passage:
          "PICO and TALA appear in the same inventory. PICO can use TALA for signed delivery. The inventory is refreshed nightly.",
        goldSpan: "PICO can use TALA for signed delivery.",
      },
    ],
    goldLabels: ["mixed"],
  },
  {
    id: "holdout-thematic-security",
    split: "HOLDOUT",
    family: "HARD_NEGATIVE",
    query: "Does a proxy prove that the system is secure?",
    candidates: [
      {
        label: "metrics",
        title: "Secure proxy metrics",
        passage:
          "The proxy records secure-session metrics and system health counters.",
      },
    ],
    goldLabels: [],
  },
  {
    id: "holdout-wrong-sharing-subject",
    split: "HOLDOUT",
    family: "RELATION_SCOPE",
    query: "Can intake and dispatch share a queue?",
    queryLanguage: "en",
    candidates: [
      {
        label: "other-processors",
        title: "Resource observations",
        language: "en",
        passage:
          "Intake and dispatch monitor two processors, although both processors use the same queue.",
      },
    ],
    goldLabels: [],
  },
  {
    id: "holdout-unrelated-optionality",
    split: "HOLDOUT",
    family: "RELATION_SCOPE",
    query: "Is a scheduler mandatory for processing jobs?",
    queryLanguage: "en",
    candidates: [
      {
        label: "optional-collector",
        title: "Job operations",
        language: "en",
        passage: "Jobs run on a scheduler with an optional audit collector.",
      },
    ],
    goldLabels: [],
  },
  {
    id: "holdout-wrong-insufficiency-subject",
    split: "HOLDOUT",
    family: "RELATION_SCOPE",
    query: "Does a gateway prove that the architecture is secure?",
    queryLanguage: "en",
    candidates: [
      {
        label: "proxy-notice",
        title: "Security notices",
        language: "en",
        passage:
          "A gateway displays notices that a proxy alone is insufficient to establish security of the architecture.",
      },
    ],
    goldLabels: [],
  },
  {
    id: "holdout-lowercase-reversed-direction",
    split: "HOLDOUT",
    family: "ENTITY_CASE_DIRECTION",
    query: "Can meru call sova?",
    queryLanguage: "en",
    candidates: [
      {
        label: "lowercase-reverse",
        title: "meru integration",
        language: "es",
        passage: "sova puede llamar a meru durante la conciliación.",
      },
    ],
    goldLabels: [],
  },
  {
    id: "holdout-passive-direction",
    split: "HOLDOUT",
    family: "PASSIVE_DIRECTION",
    query: "Can KIRO call SENA?",
    queryLanguage: "en",
    candidates: [
      {
        label: "passive-direct",
        title: "KIRO integration",
        language: "en",
        passage: "SENA can be called by KIRO during reconciliation.",
        goldSpan: "SENA can be called by KIRO during reconciliation.",
      },
    ],
    goldLabels: ["passive-direct"],
  },
];

function deterministicBenchmarkHit(candidate: Candidate): SearchHit {
  return {
    documentId: `benchmark-${candidate.label}`,
    vaultId: "benchmark-vault",
    unitId: `benchmark-unit-${candidate.label}`,
    unitType: "PARAGRAPH",
    document: {
      externalId: candidate.label,
      path: `benchmark/${candidate.label}.md`,
      title: candidate.title,
    },
    revision: "evidence-verifier-bge-shadow-v1",
    title: candidate.title,
    type: "claim",
    trust: "MACHINE_SUPPORTED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1,
    reasons: ["evidence-verifier-bge-shadow"],
    fusionContributions: [
      {
        channel: "vector",
        rank: 1,
        channelWeight: 1,
        rawScore: 0.8,
        reason: "vector:evidence-verifier-bge-shadow",
      },
    ],
    excerpt: candidate.passage,
    citations: [],
  };
}

function deterministicDiagnostics(testCase: Case, candidate: Candidate) {
  const signal = verifyDeterministicPassageSupport(
    deterministicBenchmarkHit(candidate),
    testCase.query,
  );
  return {
    supported: signal.supported,
    reason: signal.reason,
    salientCoverage: signal.salientCoverage,
    requiredAnswerCues: signal.requiredAnswerCues,
    matchedAnswerCues: signal.matchedAnswerCues,
    answerCueCoverage: signal.answerCueCoverage,
    claimRelationDiagnostics: signal.claimRelationDiagnostics,
    boundedAnchorCoverage: signal.boundedAnchorCoverage,
    boundedRelationRoleMatched: signal.boundedRelationRoleMatched,
  };
}

function sentenceWindows(passage: string) {
  return evidenceSentenceWindows(passage).map((window) => ({
    text: window.text,
    start: window.startOffset,
    end: window.endOffset,
  }));
}

function uppercaseAnchors(query: string): string[] {
  return [...new Set(query.match(/\b[A-Z][A-Z0-9]{1,}\b/gu) ?? [])];
}

function orderedAnchorsCompatible(query: string, passage: string): boolean {
  const anchors = uppercaseAnchors(query);
  if (anchors.length < 2) return true;
  let cursor = -1;
  for (const anchor of anchors) {
    const next = passage.indexOf(anchor, cursor + 1);
    if (next < 0) return false;
    cursor = next;
  }
  return true;
}

const SHADOW_ACTIVE_RELATION_AUXILIARIES = new Set([
  "can",
  "could",
  "should",
  "must",
  "will",
  "would",
  "do",
  "does",
  "did",
  "puede",
  "pueden",
  "debe",
  "deben",
]);

const SHADOW_ROLE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "been",
  "being",
  "by",
  "can",
  "could",
  "debe",
  "deben",
  "did",
  "do",
  "does",
  "for",
  "from",
  "how",
  "in",
  "is",
  "must",
  "not",
  "of",
  "on",
  "or",
  "puede",
  "pueden",
  "should",
  "the",
  "these",
  "this",
  "those",
  "to",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "y",
]);

const SHADOW_BARE_COORDINATION_FOLLOWERS = new Set([
  "are",
  "can",
  "could",
  "debe",
  "deben",
  "did",
  "do",
  "does",
  "es",
  "esta",
  "estan",
  "had",
  "has",
  "have",
  "is",
  "must",
  "puede",
  "pueden",
  "should",
  "son",
  "was",
  "were",
  "will",
  "would",
]);

function shadowRoleTokens(value: string): string[] {
  return (
    value
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

function shadowSharedQueryAnchors(
  query: string,
  passage: string,
): {
  queryTokens: string[];
  passageTokens: string[];
  anchors: string[];
} {
  const queryTokens = shadowRoleTokens(query);
  const passageTokens = shadowRoleTokens(passage);
  const passageSet = new Set(passageTokens);
  const anchors = [
    ...new Set(
      queryTokens.filter(
        (token) =>
          token.length >= 3 &&
          !SHADOW_ROLE_STOPWORDS.has(token) &&
          passageSet.has(token),
      ),
    ),
  ];
  return { queryTokens, passageTokens, anchors };
}

function shadowOrderedRoleCompatible(query: string, passage: string): boolean {
  const { queryTokens, passageTokens, anchors } = shadowSharedQueryAnchors(
    query,
    passage,
  );
  if (
    !queryTokens[0] ||
    !SHADOW_ACTIVE_RELATION_AUXILIARIES.has(queryTokens[0]) ||
    anchors.length < 2
  ) {
    return true;
  }

  let cursor = -1;
  let ordered = true;
  for (const anchor of anchors) {
    const next = passageTokens.indexOf(anchor, cursor + 1);
    if (next < 0) {
      ordered = false;
      break;
    }
    cursor = next;
  }
  if (ordered) return true;

  const subjectAnchor = anchors[0]!;
  const objectAnchor = anchors.at(-1)!;
  for (let byIndex = 0; byIndex < passageTokens.length; byIndex += 1) {
    if (passageTokens[byIndex] !== "by") continue;
    const objectBeforeBy = passageTokens
      .slice(0, byIndex)
      .lastIndexOf(objectAnchor);
    const subjectAfterBy = passageTokens.indexOf(subjectAnchor, byIndex + 1);
    if (objectBeforeBy >= 0 && subjectAfterBy > byIndex) return true;
  }
  return false;
}

function shadowCoordinatedCoreferenceCompatible(
  query: string,
  passage: string,
): boolean {
  const queryTokens = shadowRoleTokens(query);
  const passageTokens = shadowRoleTokens(passage);
  if (
    !queryTokens[0] ||
    !SHADOW_ACTIVE_RELATION_AUXILIARIES.has(queryTokens[0])
  ) {
    return true;
  }

  const coordinationIndex = queryTokens.findIndex(
    (token) => token === "and" || token === "y",
  );
  const subjectStart = 1;
  if (
    coordinationIndex < subjectStart + 1 ||
    coordinationIndex > subjectStart + 2 ||
    coordinationIndex + 1 >= queryTokens.length
  ) {
    return true;
  }

  const leftSubject = queryTokens[coordinationIndex - 1]!;
  const rightSubject = queryTokens[coordinationIndex + 1]!;
  const markers = passageTokens.flatMap((token, index) =>
    token === "both" || token === "ambos" || token === "ambas" ? [index] : [],
  );
  if (markers.length === 0) return true;

  for (const marker of markers) {
    const follower = passageTokens[marker + 1] ?? "";
    if (!SHADOW_BARE_COORDINATION_FOLLOWERS.has(follower)) continue;
    const leftBefore = passageTokens.slice(0, marker).includes(leftSubject);
    const rightBefore = passageTokens.slice(0, marker).includes(rightSubject);
    if (leftBefore && rightBefore) return true;
  }
  return false;
}

function shadowRoleCompatible(query: string, passage: string): boolean {
  return (
    shadowOrderedRoleCompatible(query, passage) &&
    shadowCoordinatedCoreferenceCompatible(query, passage)
  );
}

type ShadowRelationHypothesisCandidate = {
  positive: string;
  negative: string;
  source: string;
};

function shadowConjugateThirdPerson(verb: string): string {
  if (/(?:s|x|z|ch|sh)$/iu.test(verb)) return `${verb}es`;
  if (/[^aeiou]y$/iu.test(verb)) return `${verb.slice(0, -1)}ies`;
  return `${verb}s`;
}

function shadowRelationHypothesisCandidates(
  query: string,
  title: string,
): ShadowRelationHypothesisCandidate[] {
  const candidates: ShadowRelationHypothesisCandidate[] = [];
  const seen = new Set<string>();
  const add = (positive: string, negative: string, source: string): void => {
    const key = `${positive}\u0000${negative}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ positive, negative, source });
  };

  const production = buildEvidenceRelationHypotheses(query, title);
  if (production !== null) {
    add(production.positive, production.negative, "production-parser");
    return candidates;
  }

  const trimmed = query.trim();
  if (trimmed.startsWith("¿")) return candidates;
  const normalized = trimmed.replace(/[?？]+\s*$/u, "").trim();
  const match =
    /^(do|does|did|can|could|should|must|will|would|is|are|was|were)\s+(.+)$/iu.exec(
      normalized,
    );
  if (!match) return candidates;

  const auxiliary = match[1]!.toLocaleLowerCase("en-US");
  const tokens = match[2]!.trim().split(/\s+/u).filter(Boolean);
  if (["is", "are", "was", "were"].includes(auxiliary)) {
    for (let split = 1; split < tokens.length; split += 1) {
      const subject = tokens.slice(0, split).join(" ");
      const predicate = tokens.slice(split).join(" ");
      add(
        `${subject} ${auxiliary} ${predicate}.`,
        `${subject} ${auxiliary} not ${predicate}.`,
        `copula-split:${split}`,
      );
    }
    return candidates;
  }

  if (tokens.length < 3) return candidates;
  const nonVerbTokens = new Set([
    "a",
    "an",
    "the",
    "and",
    "or",
    "that",
    "this",
    "these",
    "those",
    "to",
    "for",
    "of",
    "in",
    "on",
    "at",
    "with",
    "by",
    "from",
    "as",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "not",
  ]);
  const invalidSubjectEndTokens = new Set([
    "a",
    "an",
    "the",
    "and",
    "or",
    "to",
    "for",
    "of",
    "in",
    "on",
    "at",
    "with",
    "by",
    "from",
    "as",
  ]);
  const invalidObjectStartTokens = new Set([
    "am",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "do",
    "does",
    "did",
    "can",
    "could",
    "should",
    "must",
    "will",
    "would",
    "to",
  ]);
  for (let verbIndex = 1; verbIndex < tokens.length - 1; verbIndex += 1) {
    const subjectTokens = tokens.slice(0, verbIndex);
    const subject = subjectTokens.join(" ");
    const verb = tokens[verbIndex]!;
    const objectTokens = tokens.slice(verbIndex + 1);
    const object = objectTokens.join(" ");
    const normalizedVerb = verb
      .toLocaleLowerCase("en-US")
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}-]+$/gu, "");
    const subjectEnd = subjectTokens.at(-1)?.toLocaleLowerCase("en-US") ?? "";
    const objectStart = objectTokens[0]?.toLocaleLowerCase("en-US") ?? "";
    if (
      !normalizedVerb ||
      nonVerbTokens.has(normalizedVerb) ||
      invalidSubjectEndTokens.has(subjectEnd) ||
      invalidObjectStartTokens.has(objectStart)
    ) {
      continue;
    }
    if (auxiliary === "do") {
      add(
        `${subject} ${verb} ${object}.`,
        `${subject} do not ${verb} ${object}.`,
        `aux-split:${verbIndex}`,
      );
    } else if (auxiliary === "does") {
      add(
        `${subject} ${shadowConjugateThirdPerson(verb)} ${object}.`,
        `${subject} does not ${verb} ${object}.`,
        `aux-split:${verbIndex}`,
      );
    } else if (auxiliary === "did") {
      add(
        `${subject} did ${verb} ${object}.`,
        `${subject} did not ${verb} ${object}.`,
        `aux-split:${verbIndex}`,
      );
    } else {
      add(
        `${subject} ${auxiliary} ${verb} ${object}.`,
        `${subject} ${auxiliary} not ${verb} ${object}.`,
        `aux-split:${verbIndex}`,
      );
    }
  }
  return candidates;
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const exp = Math.exp(-value);
    return 1 / (1 + exp);
  }
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function metrics(
  observations: readonly {
    goldLabels: readonly string[];
    candidates: readonly {
      label: string;
      score: number;
      directionCompatible: boolean;
      spanCorrect: boolean | null;
      polarityMargin: number | null;
    }[];
  }[],
  threshold: number,
  minimumPolarityMargin = 0,
) {
  let positiveCases = 0;
  let negativeCases = 0;
  let falseAbstentions = 0;
  let falseAcceptances = 0;
  let selected = 0;
  let selectedGold = 0;
  let selectedWrong = 0;
  let selectedGoldWithSpan = 0;
  let selectedGoldSpanCorrect = 0;

  for (const observation of observations) {
    const gold = new Set(observation.goldLabels);
    const accepted = observation.candidates.filter(
      (candidate) =>
        candidate.directionCompatible &&
        candidate.score >= threshold &&
        (candidate.polarityMargin === null ||
          candidate.polarityMargin >= minimumPolarityMargin),
    );
    const acceptedGold = accepted.filter((candidate) =>
      gold.has(candidate.label),
    );
    const acceptedWrong = accepted.filter(
      (candidate) => !gold.has(candidate.label),
    );

    selected += accepted.length;
    selectedGold += acceptedGold.length;
    selectedWrong += acceptedWrong.length;
    for (const candidate of acceptedGold) {
      if (candidate.spanCorrect !== null) {
        selectedGoldWithSpan += 1;
        if (candidate.spanCorrect) selectedGoldSpanCorrect += 1;
      }
    }

    if (gold.size > 0) {
      positiveCases += 1;
      if (acceptedGold.length === 0) falseAbstentions += 1;
    } else {
      negativeCases += 1;
      if (accepted.length > 0) falseAcceptances += 1;
    }
  }

  return {
    positiveCases,
    negativeCases,
    falseAbstentions,
    falseAbstentionRate:
      positiveCases === 0 ? 0 : falseAbstentions / positiveCases,
    falseAcceptances,
    falseAcceptanceRate:
      negativeCases === 0 ? 0 : falseAcceptances / negativeCases,
    selectedCandidates: selected,
    selectedGoldCandidates: selectedGold,
    wrongSelections: selectedWrong,
    supportSelectionPrecision: selected === 0 ? 1 : selectedGold / selected,
    spanAccuracy:
      selectedGoldWithSpan === 0
        ? 1
        : selectedGoldSpanCorrect / selectedGoldWithSpan,
  };
}

const cacheDir = resolveLocalSemanticCacheDir(process.env.AKP_MODEL_CACHE_DIR);
const { AutoModelForSequenceClassification, AutoTokenizer } =
  await import("@huggingface/transformers");

const loadStarted = performance.now();
const tokenizer = await AutoTokenizer.from_pretrained(MODEL, {
  revision: REVISION,
  local_files_only: false,
  ...(cacheDir === undefined ? {} : { cache_dir: cacheDir }),
});
const model = await AutoModelForSequenceClassification.from_pretrained(MODEL, {
  revision: REVISION,
  subfolder: "onnx",
  model_file_name: "model",
  dtype: "int8",
  device: "cpu",
  local_files_only: false,
  ...(cacheDir === undefined ? {} : { cache_dir: cacheDir }),
});
const loadLatencyMs = performance.now() - loadStarted;

async function scorePair(query: string, passage: string): Promise<number> {
  const inputs = await tokenizer(query, {
    text_pair: passage,
    truncation: true,
    max_length: 512,
  });
  const output = (await model(inputs)) as unknown as {
    logits?: { data?: ArrayLike<number> };
  };
  const data = output.logits?.data;
  if (!data || data.length < 1) {
    throw new Error("BGE_RERANKER_LOGIT_MISSING");
  }
  const logit = Number(data[0]);
  if (!Number.isFinite(logit)) {
    throw new Error("BGE_RERANKER_LOGIT_INVALID");
  }
  return sigmoid(logit);
}

const strategies: Strategy[] = [
  "PASSAGE_ONLY",
  "TITLE_PLUS_PASSAGE",
  "QUERY_MINUS_TITLE",
  "RELATION_POLARITY",
];
const comparisons = [];

try {
  for (const strategy of strategies) {
    const started = performance.now();
    const observations = [];

    for (const testCase of CASES) {
      const candidates = [];
      for (const candidate of testCase.candidates) {
        const windows = sentenceWindows(candidate.passage);
        const relationHypotheses =
          strategy === "RELATION_POLARITY"
            ? buildEvidenceRelationHypotheses(testCase.query, candidate.title)
            : null;
        let bestIndex = 0;
        let bestScore = Number.NEGATIVE_INFINITY;
        let bestPolarityMargin: number | null = null;

        for (let index = 0; index < windows.length; index += 1) {
          const window = windows[index]!;
          let score: number;
          let polarityMargin: number | null = null;

          if (strategy === "RELATION_POLARITY") {
            if (relationHypotheses === null) {
              score = 0;
              polarityMargin = 0;
            } else {
              const [positiveScore, negativeScore] = await Promise.all([
                scorePair(relationHypotheses.positive, window.text),
                scorePair(relationHypotheses.negative, window.text),
              ]);
              score = Math.max(positiveScore, negativeScore);
              polarityMargin = Math.abs(positiveScore - negativeScore);
            }
          } else {
            const passage =
              strategy === "TITLE_PLUS_PASSAGE"
                ? `${candidate.title}: ${window.text}`
                : window.text;
            const queryScore = await scorePair(testCase.query, passage);
            score =
              strategy === "QUERY_MINUS_TITLE"
                ? queryScore - (await scorePair(candidate.title, window.text))
                : queryScore;
          }

          if (
            score > bestScore ||
            (score === bestScore &&
              (polarityMargin ?? 0) > (bestPolarityMargin ?? 0))
          ) {
            bestScore = score;
            bestPolarityMargin = polarityMargin;
            bestIndex = index;
          }
        }

        const bestWindow = windows[bestIndex]!;
        const goldSpan = candidate.goldSpan ?? null;
        candidates.push({
          label: candidate.label,
          score: bestScore,
          polarityMargin: bestPolarityMargin,
          directionCompatible:
            strategy !== "RELATION_POLARITY"
              ? orderedAnchorsCompatible(testCase.query, bestWindow.text)
              : relationHypotheses !== null &&
                orderedAnchorsCompatible(testCase.query, bestWindow.text),
          bestSpan: {
            text: bestWindow.text,
            startOffset: bestWindow.start,
            endOffset: bestWindow.end,
          },
          spanCorrect:
            goldSpan === null
              ? null
              : bestWindow.text.includes(goldSpan.trim()),
        });
      }

      observations.push({
        id: testCase.id,
        split: testCase.split,
        family: testCase.family,
        query: testCase.query,
        goldLabels: testCase.goldLabels,
        candidates,
      });
    }

    const calibration = observations.filter(
      (entry) => entry.split === "CALIBRATION",
    );
    const holdout = observations.filter((entry) => entry.split === "HOLDOUT");
    const observedScores = calibration.flatMap((entry) =>
      entry.candidates.map((candidate) => candidate.score),
    );
    const thresholds = [
      ...new Set([
        0.1,
        0.2,
        0.3,
        0.4,
        0.5,
        0.6,
        0.7,
        0.8,
        0.9,
        ...observedScores.map((score) => Number(score.toFixed(6))),
      ]),
    ].sort((left, right) => left - right);

    const observedPolarityMargins = calibration.flatMap((entry) =>
      entry.candidates.flatMap((candidate) =>
        typeof candidate.polarityMargin === "number"
          ? [candidate.polarityMargin]
          : [],
      ),
    );
    const polarityMargins =
      strategy === "RELATION_POLARITY"
        ? [
            ...new Set([
              0,
              0.05,
              0.1,
              0.2,
              0.3,
              0.4,
              0.5,
              0.6,
              0.7,
              0.8,
              0.9,
              ...observedPolarityMargins.map((margin) =>
                Number(margin.toFixed(6)),
              ),
            ]),
          ].sort((left, right) => left - right)
        : [0];

    const calibrationMetrics = thresholds.flatMap((threshold) =>
      polarityMargins.map((minimumPolarityMargin) => ({
        threshold,
        minimumPolarityMargin,
        ...metrics(calibration, threshold, minimumPolarityMargin),
      })),
    );
    const calibrationCandidate =
      calibrationMetrics
        .filter(
          (entry) =>
            entry.falseAcceptances === 0 &&
            entry.falseAbstentions === 0 &&
            entry.wrongSelections === 0 &&
            entry.supportSelectionPrecision === 1 &&
            entry.spanAccuracy === 1,
        )
        .sort(
          (left, right) =>
            right.threshold - left.threshold ||
            right.minimumPolarityMargin - left.minimumPolarityMargin,
        )[0] ?? null;
    const holdoutMetrics =
      calibrationCandidate === null
        ? null
        : {
            threshold: calibrationCandidate.threshold,
            minimumPolarityMargin: calibrationCandidate.minimumPolarityMargin,
            ...metrics(
              holdout,
              calibrationCandidate.threshold,
              calibrationCandidate.minimumPolarityMargin,
            ),
          };

    comparisons.push({
      strategy,
      calibrationCandidate,
      holdoutMetrics,
      holdoutPassesAcceptance:
        holdoutMetrics !== null &&
        holdoutMetrics.falseAcceptances === 0 &&
        holdoutMetrics.falseAbstentions === 0 &&
        holdoutMetrics.wrongSelections === 0 &&
        holdoutMetrics.supportSelectionPrecision === 1 &&
        holdoutMetrics.spanAccuracy === 1,
      latencyMs: performance.now() - started,
      observations,
    });
  }
} finally {
  await model.dispose?.();
}

const binaryLoadStarted = performance.now();
const binaryTokenizer = await AutoTokenizer.from_pretrained(
  BINARY_ENTAILMENT_MODEL,
  {
    revision: BINARY_ENTAILMENT_REVISION,
    local_files_only: false,
    ...(cacheDir === undefined ? {} : { cache_dir: cacheDir }),
  },
);
const binaryModel = await AutoModelForSequenceClassification.from_pretrained(
  BINARY_ENTAILMENT_MODEL,
  {
    revision: BINARY_ENTAILMENT_REVISION,
    subfolder: "",
    model_file_name: "model",
    dtype: "fp32",
    device: "cpu",
    local_files_only: false,
    ...(cacheDir === undefined ? {} : { cache_dir: cacheDir }),
  },
);
const binaryLoadLatencyMs = performance.now() - binaryLoadStarted;

async function binaryEntailmentScore(
  premise: string,
  hypothesis: string,
): Promise<number> {
  const inputs = await binaryTokenizer(premise, {
    text_pair: hypothesis,
    truncation: true,
    max_length: 512,
  });
  const output = (await binaryModel(inputs)) as unknown as {
    logits?: { data?: ArrayLike<number> };
  };
  const data = output.logits?.data;
  if (!data || data.length < 2) {
    throw new Error("BGE_M3_ZEROSHOT_LOGITS_MISSING");
  }
  const entailmentLogit = Number(data[0]);
  const notEntailmentLogit = Number(data[1]);
  if (
    !Number.isFinite(entailmentLogit) ||
    !Number.isFinite(notEntailmentLogit)
  ) {
    throw new Error("BGE_M3_ZEROSHOT_LOGITS_INVALID");
  }
  const max = Math.max(entailmentLogit, notEntailmentLogit);
  const entailmentExp = Math.exp(entailmentLogit - max);
  const notEntailmentExp = Math.exp(notEntailmentLogit - max);
  return entailmentExp / (entailmentExp + notEntailmentExp);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function measureBinaryNumericalStability(
  repetitions = 3,
  maximumProbes = 8,
) {
  const probes = [];
  for (const testCase of CASES) {
    for (const candidate of testCase.candidates) {
      const hypothesis = shadowRelationHypothesisCandidates(
        testCase.query,
        candidate.title,
      )[0];
      const window = sentenceWindows(candidate.passage)[0];
      if (!hypothesis || !window) continue;

      const positiveScores = [];
      const negativeScores = [];
      for (let run = 0; run < repetitions; run += 1) {
        positiveScores.push(
          await binaryEntailmentScore(window.text, hypothesis.positive),
        );
        negativeScores.push(
          await binaryEntailmentScore(window.text, hypothesis.negative),
        );
      }

      const positiveMinimum = Math.min(...positiveScores);
      const positiveMaximum = Math.max(...positiveScores);
      const negativeMinimum = Math.min(...negativeScores);
      const negativeMaximum = Math.max(...negativeScores);
      probes.push({
        caseId: testCase.id,
        split: testCase.split,
        label: candidate.label,
        gold: testCase.goldLabels.includes(candidate.label),
        premiseSha256: sha256Text(window.text),
        positiveHypothesisSha256: sha256Text(hypothesis.positive),
        negativeHypothesisSha256: sha256Text(hypothesis.negative),
        positiveScores,
        negativeScores,
        positiveDrift: positiveMaximum - positiveMinimum,
        negativeDrift: negativeMaximum - negativeMinimum,
      });

      if (probes.length >= maximumProbes) break;
    }
    if (probes.length >= maximumProbes) break;
  }

  const maximumScoreDrift = Math.max(
    0,
    ...probes.flatMap((probe) => [probe.positiveDrift, probe.negativeDrift]),
  );
  const scoreFingerprint = sha256Text(
    JSON.stringify(
      probes.map((probe) => ({
        caseId: probe.caseId,
        label: probe.label,
        positiveScores: probe.positiveScores.map((score) =>
          Number(score.toFixed(9)),
        ),
        negativeScores: probe.negativeScores.map((score) =>
          Number(score.toFixed(9)),
        ),
      })),
    ),
  );
  const cpu = os.cpus();
  const runtimeFingerprintInput = {
    node: process.version,
    versions: process.versions,
    platform: process.platform,
    arch: process.arch,
    operatingSystemRelease: os.release(),
    logicalCpuCount: cpu.length,
    cpuModel: cpu[0]?.model ?? null,
    totalMemoryBytes: os.totalmem(),
    runnerOs: process.env.RUNNER_OS ?? null,
    runnerArch: process.env.RUNNER_ARCH ?? null,
    imageOs: process.env.ImageOS ?? null,
    imageVersion: process.env.ImageVersion ?? null,
    model: BINARY_ENTAILMENT_MODEL,
    revision: BINARY_ENTAILMENT_REVISION,
  };

  return {
    repetitions,
    probes: probes.length,
    maximumScoreDrift,
    intraProcessStable: maximumScoreDrift <= 1e-6,
    scoreFingerprint,
    runtimeFingerprint: sha256Text(JSON.stringify(runtimeFingerprintInput)),
    runtime: runtimeFingerprintInput,
    observations: probes,
    crossRunInterpretation:
      "Compare scoreFingerprint for the same runtime/model revision across CI runs. Stable repeated inference with a changed cross-run fingerprint means threshold calibration is not reproducible across processes or environments.",
  };
}

async function evaluateBinaryCases(
  hypothesisCandidatesFor: (
    testCase: Case,
    candidate: Candidate,
  ) => readonly ShadowRelationHypothesisCandidate[],
) {
  const observations = [];
  for (const testCase of CASES) {
    const candidates = [];
    for (const candidate of testCase.candidates) {
      const hypotheses = hypothesisCandidatesFor(testCase, candidate);
      const windows = sentenceWindows(candidate.passage);
      let bestIndex = 0;
      let bestScore = 0;
      let bestPolarityMargin = 0;
      let selectedHypothesisSource: string | null = null;
      let selectedPositiveHypothesis: string | null = null;
      let selectedNegativeHypothesis: string | null = null;
      let selectedAnswerPolarity: "POSITIVE" | "NEGATIVE" | null = null;

      for (const hypothesis of hypotheses) {
        for (let index = 0; index < windows.length; index += 1) {
          const window = windows[index]!;
          const [positiveScore, negativeScore] = await Promise.all([
            binaryEntailmentScore(window.text, hypothesis.positive),
            binaryEntailmentScore(window.text, hypothesis.negative),
          ]);
          const score = Math.max(positiveScore, negativeScore);
          const polarityMargin = Math.abs(positiveScore - negativeScore);
          if (
            score > bestScore ||
            (score === bestScore && polarityMargin > bestPolarityMargin)
          ) {
            bestScore = score;
            bestPolarityMargin = polarityMargin;
            bestIndex = index;
            selectedHypothesisSource = hypothesis.source;
            selectedPositiveHypothesis = hypothesis.positive;
            selectedNegativeHypothesis = hypothesis.negative;
            selectedAnswerPolarity =
              positiveScore >= negativeScore ? "POSITIVE" : "NEGATIVE";
          }
        }
      }

      const bestWindow = windows[bestIndex]!;
      const goldSpan = candidate.goldSpan ?? null;
      candidates.push({
        label: candidate.label,
        language: candidate.language ?? null,
        score: bestScore,
        polarityMargin: bestPolarityMargin,
        deterministic: deterministicDiagnostics(testCase, candidate),
        directionCompatible:
          hypotheses.length > 0 &&
          orderedAnchorsCompatible(testCase.query, bestWindow.text),
        roleCompatible:
          hypotheses.length > 0 &&
          shadowRoleCompatible(testCase.query, bestWindow.text),
        selectedHypothesisSource,
        selectedPositiveHypothesis,
        selectedNegativeHypothesis,
        selectedAnswerPolarity,
        bestSpan: {
          text: bestWindow.text,
          startOffset: bestWindow.start,
          endOffset: bestWindow.end,
        },
        spanCorrect:
          goldSpan === null ? null : bestWindow.text.includes(goldSpan.trim()),
      });
    }

    observations.push({
      id: testCase.id,
      split: testCase.split,
      family: testCase.family,
      query: testCase.query,
      queryLanguage: testCase.queryLanguage ?? null,
      goldLabels: testCase.goldLabels,
      candidates,
    });
  }
  return observations;
}

function calibrateBinaryObservations(
  observations: Awaited<ReturnType<typeof evaluateBinaryCases>>,
) {
  const calibration = observations.filter(
    (entry) => entry.split === "CALIBRATION",
  );
  const holdout = observations.filter((entry) => entry.split === "HOLDOUT");
  const thresholds = [
    ...new Set([
      0.1,
      0.2,
      0.3,
      0.4,
      0.5,
      0.6,
      0.7,
      0.8,
      0.9,
      ...calibration.flatMap((entry) =>
        entry.candidates.map((candidate) => Number(candidate.score.toFixed(6))),
      ),
    ]),
  ].sort((left, right) => left - right);
  const margins = [
    ...new Set([
      0,
      0.05,
      0.1,
      0.2,
      0.3,
      0.4,
      0.5,
      0.6,
      0.7,
      0.8,
      0.9,
      ...calibration.flatMap((entry) =>
        entry.candidates.map((candidate) =>
          Number(candidate.polarityMargin.toFixed(6)),
        ),
      ),
    ]),
  ].sort((left, right) => left - right);
  const calibrationMetrics = thresholds.flatMap((threshold) =>
    margins.map((minimumPolarityMargin) => ({
      threshold,
      minimumPolarityMargin,
      ...metrics(calibration, threshold, minimumPolarityMargin),
    })),
  );
  const calibrationCandidate =
    calibrationMetrics
      .filter(
        (entry) =>
          entry.falseAcceptances === 0 &&
          entry.falseAbstentions === 0 &&
          entry.wrongSelections === 0 &&
          entry.supportSelectionPrecision === 1 &&
          entry.spanAccuracy === 1,
      )
      .sort(
        (left, right) =>
          right.threshold - left.threshold ||
          right.minimumPolarityMargin - left.minimumPolarityMargin,
      )[0] ?? null;
  const holdoutMetrics =
    calibrationCandidate === null
      ? null
      : {
          threshold: calibrationCandidate.threshold,
          minimumPolarityMargin: calibrationCandidate.minimumPolarityMargin,
          ...metrics(
            holdout,
            calibrationCandidate.threshold,
            calibrationCandidate.minimumPolarityMargin,
          ),
        };

  return {
    calibrationMetrics,
    calibrationCandidate,
    holdoutMetrics,
    holdoutPassesAcceptance:
      holdoutMetrics !== null &&
      holdoutMetrics.falseAcceptances === 0 &&
      holdoutMetrics.falseAbstentions === 0 &&
      holdoutMetrics.wrongSelections === 0 &&
      holdoutMetrics.supportSelectionPrecision === 1 &&
      holdoutMetrics.spanAccuracy === 1,
  };
}

function scoreOnlyMidpointCalibration(
  observations: Awaited<ReturnType<typeof evaluateBinaryCases>>,
) {
  const calibration = observations.filter(
    (entry) => entry.split === "CALIBRATION",
  );
  const holdout = observations.filter((entry) => entry.split === "HOLDOUT");
  const goldCandidates = calibration.flatMap((entry) => {
    const gold = new Set(entry.goldLabels);
    return entry.candidates
      .filter(
        (candidate) =>
          candidate.directionCompatible && gold.has(candidate.label),
      )
      .map((candidate) => ({
        id: entry.id,
        label: candidate.label,
        score: candidate.score,
      }));
  });
  const nonGoldCandidates = calibration.flatMap((entry) => {
    const gold = new Set(entry.goldLabels);
    return entry.candidates
      .filter(
        (candidate) =>
          candidate.directionCompatible && !gold.has(candidate.label),
      )
      .map((candidate) => ({
        id: entry.id,
        label: candidate.label,
        score: candidate.score,
      }));
  });
  if (goldCandidates.length === 0) {
    return {
      calibrationCandidate: null,
      holdoutMetrics: null,
      holdoutPassesAcceptance: false,
      boundary: null,
    };
  }

  const minimumGold = goldCandidates.reduce((left, right) =>
    left.score <= right.score ? left : right,
  );
  const maximumNonGold =
    nonGoldCandidates.length === 0
      ? { id: null, label: null, score: 0 }
      : nonGoldCandidates.reduce((left, right) =>
          left.score >= right.score ? left : right,
        );
  if (maximumNonGold.score >= minimumGold.score) {
    return {
      calibrationCandidate: null,
      holdoutMetrics: null,
      holdoutPassesAcceptance: false,
      boundary: { minimumGold, maximumNonGold },
    };
  }

  const threshold = (minimumGold.score + maximumNonGold.score) / 2;
  const calibrationMetrics = {
    threshold,
    minimumPolarityMargin: 0,
    ...metrics(calibration, threshold, 0),
  };
  const calibrationCandidate =
    calibrationMetrics.falseAcceptances === 0 &&
    calibrationMetrics.falseAbstentions === 0 &&
    calibrationMetrics.wrongSelections === 0 &&
    calibrationMetrics.supportSelectionPrecision === 1 &&
    calibrationMetrics.spanAccuracy === 1
      ? calibrationMetrics
      : null;
  const holdoutMetrics =
    calibrationCandidate === null
      ? null
      : {
          threshold,
          minimumPolarityMargin: 0,
          ...metrics(holdout, threshold, 0),
        };

  return {
    calibrationCandidate,
    holdoutMetrics,
    holdoutPassesAcceptance:
      holdoutMetrics !== null &&
      holdoutMetrics.falseAcceptances === 0 &&
      holdoutMetrics.falseAbstentions === 0 &&
      holdoutMetrics.wrongSelections === 0 &&
      holdoutMetrics.supportSelectionPrecision === 1 &&
      holdoutMetrics.spanAccuracy === 1,
    boundary: { minimumGold, maximumNonGold },
  };
}

type CrossLingualPair = "en->es" | "es->en";

function scopedLanguagePairObservations(
  observations: Awaited<ReturnType<typeof evaluateBinaryCases>>,
  pair: CrossLingualPair,
) {
  const [queryLanguage, passageLanguage] = pair.split("->") as [
    "en" | "es",
    "en" | "es",
  ];
  return observations.flatMap((entry) => {
    if (entry.queryLanguage !== queryLanguage) return [];
    const candidates = entry.candidates.filter(
      (candidate) => candidate.language === passageLanguage,
    );
    if (candidates.length === 0) return [];
    const labels = new Set(candidates.map((candidate) => candidate.label));
    return [
      {
        ...entry,
        goldLabels: entry.goldLabels.filter((label) => labels.has(label)),
        candidates,
      },
    ];
  });
}

function languagePairCandidateCounts(
  observations: Awaited<ReturnType<typeof evaluateBinaryCases>>,
) {
  let goldCandidates = 0;
  let nonGoldCandidates = 0;
  for (const entry of observations) {
    const gold = new Set(entry.goldLabels);
    for (const candidate of entry.candidates) {
      if (!candidate.directionCompatible) continue;
      if (gold.has(candidate.label)) goldCandidates += 1;
      else nonGoldCandidates += 1;
    }
  }
  return { goldCandidates, nonGoldCandidates };
}

function calibrateCrossLingualPairs(
  observations: Awaited<ReturnType<typeof evaluateBinaryCases>>,
) {
  return (["en->es", "es->en"] as const).map((pair) => {
    const scoped = scopedLanguagePairObservations(observations, pair);
    const calibration = scoped.filter((entry) => entry.split === "CALIBRATION");
    const holdout = scoped.filter((entry) => entry.split === "HOLDOUT");
    const calibrationCounts = languagePairCandidateCounts(calibration);
    const holdoutCounts = languagePairCandidateCounts(holdout);
    const sufficientCoverage =
      calibrationCounts.goldCandidates >= 2 &&
      calibrationCounts.nonGoldCandidates >= 2 &&
      holdoutCounts.goldCandidates >= 2 &&
      holdoutCounts.nonGoldCandidates >= 2;
    const result = sufficientCoverage
      ? scoreOnlyMidpointCalibration(scoped)
      : {
          calibrationCandidate: null,
          holdoutMetrics: null,
          holdoutPassesAcceptance: false,
          boundary: null,
        };
    return {
      pair,
      sufficientCoverage,
      calibrationCases: calibration.length,
      holdoutCases: holdout.length,
      calibrationCounts,
      holdoutCounts,
      ...result,
    };
  });
}

const binaryStarted = performance.now();
let binaryObservations: Awaited<ReturnType<typeof evaluateBinaryCases>>;
let binaryHypothesisSweepObservations: Awaited<
  ReturnType<typeof evaluateBinaryCases>
>;
let binaryNumericalStabilityAudit: Awaited<
  ReturnType<typeof measureBinaryNumericalStability>
>;
try {
  binaryObservations = await evaluateBinaryCases((testCase, candidate) => {
    const hypothesis = buildEvidenceRelationHypotheses(
      testCase.query,
      candidate.title,
    );
    return hypothesis === null
      ? []
      : [{ ...hypothesis, source: "production-parser" }];
  });
  binaryHypothesisSweepObservations = await evaluateBinaryCases(
    (testCase, candidate) =>
      shadowRelationHypothesisCandidates(testCase.query, candidate.title),
  );
  binaryNumericalStabilityAudit = await measureBinaryNumericalStability();
} finally {
  await binaryModel.dispose?.();
}

const binaryCalibrationResult = calibrateBinaryObservations(binaryObservations);
const binarySweepCalibrationResult = calibrateBinaryObservations(
  binaryHypothesisSweepObservations,
);
const binaryRoleGuardedObservations = binaryHypothesisSweepObservations.map(
  (entry) => ({
    ...entry,
    candidates: entry.candidates.map((candidate) => ({
      ...candidate,
      directionCompatible: candidate.roleCompatible,
    })),
  }),
);
const binaryRoleGuardedCalibrationResult = calibrateBinaryObservations(
  binaryRoleGuardedObservations,
);
const binaryDeterministicFallbackObservations =
  binaryRoleGuardedObservations.map((entry) => ({
    ...entry,
    candidates: entry.candidates.map((candidate) =>
      candidate.deterministic.supported
        ? {
            ...candidate,
            score: 1,
            polarityMargin: 1,
            directionCompatible: true,
            fallbackSource: "DETERMINISTIC",
          }
        : {
            ...candidate,
            fallbackSource: "ROLE_GUARD_BGE",
          },
    ),
  }));
const binaryDeterministicFallbackCalibrationResult =
  calibrateBinaryObservations(binaryDeterministicFallbackObservations);
const binarySweepScoreOnlyMidpoint = scoreOnlyMidpointCalibration(
  binaryHypothesisSweepObservations,
);
const binaryCrossLingualPairCalibration = calibrateCrossLingualPairs(
  binaryHypothesisSweepObservations,
);

function directionFilterAudit(
  observations: Awaited<ReturnType<typeof evaluateBinaryCases>>,
  boundary: { threshold: number; minimumPolarityMargin: number } | null,
  filter = "uppercase-query-anchors-in-passage-order",
) {
  const rejectedCandidates = observations.flatMap((entry) =>
    entry.candidates.flatMap((candidate) =>
      candidate.directionCompatible
        ? []
        : [
            {
              caseId: entry.id,
              split: entry.split,
              label: candidate.label,
              gold: entry.goldLabels.includes(candidate.label),
              score: candidate.score,
              polarityMargin: candidate.polarityMargin,
            },
          ],
    ),
  );
  const ungated = observations.map((entry) => ({
    ...entry,
    candidates: entry.candidates.map((candidate) => ({
      ...candidate,
      directionCompatible: candidate.selectedPositiveHypothesis !== null,
    })),
  }));
  return {
    filter,
    rejectedCandidates,
    ungatedCalibrationMetrics:
      boundary === null
        ? null
        : metrics(
            ungated.filter((entry) => entry.split === "CALIBRATION"),
            boundary.threshold,
            boundary.minimumPolarityMargin,
          ),
    ungatedHoldoutMetrics:
      boundary === null
        ? null
        : metrics(
            ungated.filter((entry) => entry.split === "HOLDOUT"),
            boundary.threshold,
            boundary.minimumPolarityMargin,
          ),
  };
}

const binaryEntailmentComparison = {
  model: {
    id: BINARY_ENTAILMENT_MODEL,
    revision: BINARY_ENTAILMENT_REVISION,
    upstream: BINARY_ENTAILMENT_UPSTREAM,
    artifactQuantization: "int8-dynamic",
    provenance: "third-party-quantization-shadow-only",
    labels: ["entailment", "not_entailment"],
  },
  loadLatencyMs: binaryLoadLatencyMs,
  latencyMs: performance.now() - binaryStarted,
  calibrationCandidate: binaryCalibrationResult.calibrationCandidate,
  holdoutMetrics: binaryCalibrationResult.holdoutMetrics,
  holdoutPassesAcceptance: binaryCalibrationResult.holdoutPassesAcceptance,
  observations: binaryObservations,
  directionFilterAudit: directionFilterAudit(
    binaryObservations,
    binaryCalibrationResult.calibrationCandidate,
  ),
};

const binaryHypothesisSweepComparison = {
  model: binaryEntailmentComparison.model,
  hypothesisStrategy:
    "shadow-only exhaustive auxiliary/copula split candidates; title is not premise evidence",
  calibrationCandidate: binarySweepCalibrationResult.calibrationCandidate,
  holdoutMetrics: binarySweepCalibrationResult.holdoutMetrics,
  holdoutPassesAcceptance: binarySweepCalibrationResult.holdoutPassesAcceptance,
  scoreOnlyMidpointCalibration: binarySweepScoreOnlyMidpoint,
  observations: binaryHypothesisSweepObservations,
  directionFilterAudit: directionFilterAudit(
    binaryHypothesisSweepObservations,
    binarySweepCalibrationResult.calibrationCandidate,
  ),
};

const binaryRoleGuardedComparison = {
  model: binaryEntailmentComparison.model,
  hypothesisStrategy:
    "shadow-only exhaustive auxiliary/copula split candidates plus syntax-only role/coreference guard",
  guard:
    "shared query-anchor order with passive by-subject allowance and bare both/ambos coreference",
  calibrationCandidate: binaryRoleGuardedCalibrationResult.calibrationCandidate,
  holdoutMetrics: binaryRoleGuardedCalibrationResult.holdoutMetrics,
  holdoutPassesAcceptance:
    binaryRoleGuardedCalibrationResult.holdoutPassesAcceptance,
  observations: binaryRoleGuardedObservations,
  directionFilterAudit: directionFilterAudit(
    binaryRoleGuardedObservations,
    binaryRoleGuardedCalibrationResult.calibrationCandidate,
    "query-shared-anchor-order-passive-and-coordination-coreference",
  ),
};

const binaryDeterministicFallbackComparison = {
  model: binaryEntailmentComparison.model,
  mode: "deterministic passage support first; role-guarded binary entailment only rescues deterministic abstentions",
  calibrationCandidate:
    binaryDeterministicFallbackCalibrationResult.calibrationCandidate,
  holdoutMetrics: binaryDeterministicFallbackCalibrationResult.holdoutMetrics,
  holdoutPassesAcceptance:
    binaryDeterministicFallbackCalibrationResult.holdoutPassesAcceptance,
  precisionSafeHoldout:
    binaryDeterministicFallbackCalibrationResult.holdoutMetrics !== null &&
    binaryDeterministicFallbackCalibrationResult.holdoutMetrics
      .falseAcceptances === 0 &&
    binaryDeterministicFallbackCalibrationResult.holdoutMetrics
      .wrongSelections === 0 &&
    binaryDeterministicFallbackCalibrationResult.holdoutMetrics
      .supportSelectionPrecision === 1 &&
    binaryDeterministicFallbackCalibrationResult.holdoutMetrics.spanAccuracy ===
      1,
  observations: binaryDeterministicFallbackObservations,
};

const report = {
  schemaVersion: 12,
  status: "MEASURED",
  evidenceBoundary:
    "Public synthetic source-disjoint shadow evaluation of multilingual evidence signals: reranker relevance/contrast plus a pinned multilingual binary entailment model. Calibration and holdout include explicit cross-lingual direct, indirect, wrong-relation and reversed-direction cases with disjoint synthetic sources. Binary observations also record deterministic passage-support diagnostics. A shadow-only syntax guard separately measures query-anchor direction, passive by-subject order and bare both/ambos coreference without changing production authority. A deterministic-first shadow comparison keeps proven passage support and lets the role-guarded binary verifier rescue only deterministic abstentions; it reports precision safety separately from the stricter zero-abstention promotion gate. A numerical-stability audit repeats fixed binary inference pairs within one process and records score/runtime fingerprints so cross-run calibration drift is observable before any promotion. A shadow-only language-pair analysis calibrates score-only midpoint thresholds independently for en->es and es->en, requires at least two direction-compatible gold and two non-gold candidates in both calibration and holdout, and freezes each calibration threshold before evaluating holdout. No signal is evidence truth or promoted by this report.",
  model: {
    id: MODEL,
    revision: REVISION,
    runtime: "@huggingface/transformers",
    dtype: "int8",
    task: "query-passage-cross-encoder-reranking",
    license: "apache-2.0",
  },
  loadLatencyMs,
  splitCounts: {
    calibration: CASES.filter((entry) => entry.split === "CALIBRATION").length,
    holdout: CASES.filter((entry) => entry.split === "HOLDOUT").length,
  },
  comparisons,
  binaryEntailmentComparison,
  binaryHypothesisSweepComparison,
  binaryRoleGuardedComparison,
  binaryDeterministicFallbackComparison,
  binaryNumericalStabilityAudit,
  binaryCrossLingualPairCalibration,
  promotionAllowed: false,
  productionDefaultChanged: false,
  enforcementEnabled: false,
};

const reportPath = path.resolve(
  process.env.AKP_EVIDENCE_VERIFIER_BGE_RERANKER_SHADOW_REPORT ??
    "reports/ci/evidence-verifier-bge-reranker-shadow-benchmark.json",
);
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(JSON.stringify(report, null, 2));
