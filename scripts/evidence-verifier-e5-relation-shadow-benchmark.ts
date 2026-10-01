import { shadowEvidenceMetrics as metrics } from "../packages/retrieval/scripts/shadow-evidence-metrics.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  LocalSemanticEmbeddingAdapter,
  normalizedAnswerabilityTokens,
} from "../packages/retrieval/src/index.js";

type Split = "CALIBRATION" | "HOLDOUT";
type Strategy =
  | "FULL_QUERY"
  | "CONTENT_QUERY"
  | "TITLE_RESIDUAL"
  | "RELATION_RESIDUAL"
  | "TOKEN_ALIGNMENT";

type Candidate = {
  label: string;
  title: string;
  passage: string;
  goldSpan?: string;
};

type Case = {
  id: string;
  split: Split;
  family: string;
  query: string;
  candidates: Candidate[];
  goldLabels: string[];
};

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
    candidates: [
      {
        label: "focused",
        title: "Focused handlers",
        passage:
          "Un manejador con una sola responsabilidad concentra sus cambios en un único motivo de negocio.",
        goldSpan:
          "Un manejador con una sola responsabilidad concentra sus cambios en un único motivo de negocio.",
      },
    ],
    goldLabels: ["focused"],
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
    candidates: [
      {
        label: "indirect",
        title: "Single-purpose modules",
        passage:
          "Un módulo con una sola responsabilidad concentra sus cambios en un único motivo de negocio.",
        goldSpan:
          "Un módulo con una sola responsabilidad concentra sus cambios en un único motivo de negocio.",
      },
    ],
    goldLabels: ["indirect"],
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
];

const QUERY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "could",
  "do",
  "does",
  "did",
  "el",
  "es",
  "every",
  "is",
  "la",
  "las",
  "los",
  "must",
  "para",
  "por",
  "puede",
  "pueden",
  "que",
  "should",
  "the",
  "un",
  "una",
  "usar",
  "use",
  "what",
  "when",
  "where",
  "why",
]);

function normalizeToken(value: string): string {
  const token = value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US");
  return token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token;
}

function contentTokens(value: string): string[] {
  return normalizedAnswerabilityTokens(value)
    .map(normalizeToken)
    .filter((token) => token.length >= 2 && !QUERY_STOPWORDS.has(token));
}

function queryTextFor(
  strategy: Strategy,
  query: string,
  title: string,
): string {
  if (strategy === "FULL_QUERY") return query;
  const queryTokens = contentTokens(query);
  if (strategy === "CONTENT_QUERY") return queryTokens.join(" ");
  const titleTokens = new Set(contentTokens(title));
  const residual = queryTokens.filter((token) => !titleTokens.has(token));
  return (residual.length >= 2 ? residual : queryTokens).join(" ");
}

function passageTextFor(
  strategy: Strategy,
  passage: string,
  title: string,
): string {
  if (strategy !== "RELATION_RESIDUAL" && strategy !== "TOKEN_ALIGNMENT")
    return passage;
  const titleTokens = new Set(contentTokens(title));
  const passageTokens = contentTokens(passage);
  const residual = passageTokens.filter((token) => !titleTokens.has(token));
  return (residual.length >= 2 ? residual : passageTokens).join(" ");
}

function sentenceWindows(
  passage: string,
): { text: string; start: number; end: number }[] {
  const windows: { text: string; start: number; end: number }[] = [];
  const matcher = /[^.!?;\n]+(?:[.!?;]|$)/gu;
  for (const match of passage.matchAll(matcher)) {
    if (match.index === undefined) continue;
    const raw = match[0];
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const start = match.index + leading;
    const end = match.index + raw.length - trailing;
    if (end <= start) continue;
    windows.push({ text: passage.slice(start, end), start, end });
  }
  if (windows.length > 0) return windows;
  const text = passage.trim();
  const start = passage.indexOf(text);
  return text ? [{ text, start, end: start + text.length }] : [];
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

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) {
    throw new Error("E5_RELATION_VECTOR_DIMENSION_MISMATCH");
  }
  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    score += left[index]! * right[index]!;
  }
  return score;
}

async function tokenAlignment(
  adapter: LocalSemanticEmbeddingAdapter,
  queryText: string,
  passageText: string,
): Promise<{ score: number; floor: number; matches: number[] }> {
  const queryTokens = contentTokens(queryText);
  const passageTokens = contentTokens(passageText);
  if (queryTokens.length === 0 || passageTokens.length === 0) {
    return { score: -1, floor: -1, matches: [] };
  }

  const queryVectors = await adapter.embedQueries(queryTokens);
  const passageVectors = await adapter.embedPassages(passageTokens);
  const matches = queryVectors.map((queryVector) =>
    Math.max(
      ...passageVectors.map((passageVector) =>
        cosine(queryVector, passageVector),
      ),
    ),
  );
  return {
    score: matches.reduce((sum, value) => sum + value, 0) / matches.length,
    floor: Math.min(...matches),
    matches,
  };
}

const strategies: Strategy[] = [
  "FULL_QUERY",
  "CONTENT_QUERY",
  "TITLE_RESIDUAL",
  "RELATION_RESIDUAL",
  "TOKEN_ALIGNMENT",
];
const adapter = new LocalSemanticEmbeddingAdapter({
  cacheDir: process.env.AKP_MODEL_CACHE_DIR,
  localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
});

const comparisons = [];
try {
  for (const strategy of strategies) {
    const started = performance.now();
    const observations = [];

    for (const testCase of CASES) {
      const candidates = [];
      for (const candidate of testCase.candidates) {
        const queryText = queryTextFor(
          strategy,
          testCase.query,
          candidate.title,
        );
        const windows = sentenceWindows(candidate.passage);
        const [queryVector] = await adapter.embedQueries([queryText]);
        const passageTexts = windows.map((window) =>
          passageTextFor(strategy, window.text, candidate.title),
        );
        let bestIndex = 0;
        let bestScore = Number.NEGATIVE_INFINITY;
        let bestAlignmentFloor: number | null = null;
        let bestAlignmentMatches: number[] | null = null;

        if (strategy === "TOKEN_ALIGNMENT") {
          for (let index = 0; index < passageTexts.length; index += 1) {
            const alignment = await tokenAlignment(
              adapter,
              queryText,
              passageTexts[index]!,
            );
            if (alignment.score > bestScore) {
              bestScore = alignment.score;
              bestIndex = index;
              bestAlignmentFloor = alignment.floor;
              bestAlignmentMatches = alignment.matches;
            }
          }
        } else {
          const passageVectors = await adapter.embedPassages(passageTexts);
          for (let index = 0; index < passageVectors.length; index += 1) {
            const score = cosine(queryVector!, passageVectors[index]!);
            if (score > bestScore) {
              bestScore = score;
              bestIndex = index;
            }
          }
        }
        const bestWindow = windows[bestIndex]!;
        const goldSpan = candidate.goldSpan ?? null;
        candidates.push({
          label: candidate.label,
          queryText,
          passageText: passageTexts[bestIndex]!,
          score: bestScore,
          alignmentFloor: bestAlignmentFloor,
          alignmentMatches: bestAlignmentMatches,
          directionCompatible: orderedAnchorsCompatible(
            testCase.query,
            bestWindow.text,
          ),
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
        0.5,
        0.55,
        0.6,
        0.65,
        0.7,
        0.75,
        0.8,
        0.85,
        0.9,
        0.95,
        ...observedScores.map((score) => Number(score.toFixed(6))),
      ]),
    ].sort((left, right) => left - right);

    const calibrationMetrics = thresholds.map((threshold) => ({
      threshold,
      ...metrics(calibration, threshold),
    }));
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
        .sort((left, right) => right.threshold - left.threshold)[0] ?? null;
    const holdoutMetrics =
      calibrationCandidate === null
        ? null
        : {
            threshold: calibrationCandidate.threshold,
            ...metrics(holdout, calibrationCandidate.threshold),
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
  await adapter.dispose();
}

const report = {
  schemaVersion: 2,
  status: "MEASURED",
  evaluationUse: "DEVELOPMENT_SHADOW",
  holdoutIndependence: "SOURCE_DISJOINT_ONLY",
  unseenQuestionFamilyHoldout: false,
  evidenceBoundary:
    "Public synthetic source-disjoint shadow evaluation of E5 relation alignment, including symmetric title-residual text and token-level residual alignment. Embedding similarity is not evidence truth and is never promoted by this report.",
  model: adapter.descriptor,
  splitCounts: {
    calibration: CASES.filter((entry) => entry.split === "CALIBRATION").length,
    holdout: CASES.filter((entry) => entry.split === "HOLDOUT").length,
  },
  comparisons,
  promotionAllowed: false,
  productionDefaultChanged: false,
  enforcementEnabled: false,
};

const reportPath = path.resolve(
  process.env.AKP_EVIDENCE_VERIFIER_E5_RELATION_SHADOW_REPORT ??
    "reports/ci/evidence-verifier-e5-relation-shadow-benchmark.json",
);
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(JSON.stringify(report, null, 2));
