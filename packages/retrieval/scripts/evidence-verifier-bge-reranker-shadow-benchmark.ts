import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  buildEvidenceRelationHypotheses,
  resolveLocalSemanticCacheDir,
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

const MODEL = "onnx-community/bge-reranker-v2-m3-ONNX";
const REVISION = "6f5ff65298512715a1e669753bc754d2bc8f367b";

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

const report = {
  schemaVersion: 2,
  status: "MEASURED",
  evidenceBoundary:
    "Public synthetic source-disjoint shadow evaluation of a multilingual cross-encoder reranker, including passage relevance, title-passage contrast, and a passage-to-positive/negative-relation polarity contrast. Score and polarity margin are calibrated only on calibration sources and frozen for holdout. Relevance or contrast is not evidence truth and is never promoted by this report.",
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
