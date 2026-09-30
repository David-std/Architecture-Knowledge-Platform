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
        score: bestScore,
        polarityMargin: bestPolarityMargin,
        directionCompatible:
          hypotheses.length > 0 &&
          orderedAnchorsCompatible(testCase.query, bestWindow.text),
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
      goldLabels: testCase.goldLabels,
      candidates,
    });
  }
  return observations;
}

async function evaluateBinaryTopicBridgeCases() {
  const observations = [];
  for (const testCase of CASES) {
    const candidates = [];
    for (const candidate of testCase.candidates) {
      const hypotheses = shadowRelationHypothesisCandidates(
        testCase.query,
        candidate.title,
      );
      const windows = sentenceWindows(candidate.passage);
      let bestIndex = 0;
      let bestScore = 0;
      let bestPassageScore = 0;
      let bestPolarityMargin = 0;
      let bestPassagePolarityMargin = 0;
      let bestPolarityConsistent = false;
      let selectedHypothesisSource: string | null = null;
      let selectedPositiveHypothesis: string | null = null;
      let selectedNegativeHypothesis: string | null = null;
      let selectedAnswerPolarity: "POSITIVE" | "NEGATIVE" | null = null;

      for (const hypothesis of hypotheses) {
        for (let index = 0; index < windows.length; index += 1) {
          const window = windows[index]!;
          const topicalPremise = `Topic: ${candidate.title}. Evidence: ${window.text}`;
          const [
            passagePositive,
            passageNegative,
            topicalPositive,
            topicalNegative,
          ] = await Promise.all([
            binaryEntailmentScore(window.text, hypothesis.positive),
            binaryEntailmentScore(window.text, hypothesis.negative),
            binaryEntailmentScore(topicalPremise, hypothesis.positive),
            binaryEntailmentScore(topicalPremise, hypothesis.negative),
          ]);
          const passageScore = Math.max(passagePositive, passageNegative);
          const score = Math.max(topicalPositive, topicalNegative);
          const passagePolarity =
            passagePositive >= passageNegative ? "POSITIVE" : "NEGATIVE";
          const answerPolarity =
            topicalPositive >= topicalNegative ? "POSITIVE" : "NEGATIVE";
          const polarityMargin = Math.abs(topicalPositive - topicalNegative);
          const passagePolarityMargin = Math.abs(
            passagePositive - passageNegative,
          );
          const polarityConsistent = passagePolarity === answerPolarity;

          if (
            score > bestScore ||
            (score === bestScore && passageScore > bestPassageScore)
          ) {
            bestScore = score;
            bestPassageScore = passageScore;
            bestPolarityMargin = polarityMargin;
            bestPassagePolarityMargin = passagePolarityMargin;
            bestPolarityConsistent = polarityConsistent;
            bestIndex = index;
            selectedHypothesisSource = hypothesis.source;
            selectedPositiveHypothesis = hypothesis.positive;
            selectedNegativeHypothesis = hypothesis.negative;
            selectedAnswerPolarity = answerPolarity;
          }
        }
      }

      const bestWindow = windows[bestIndex]!;
      const goldSpan = candidate.goldSpan ?? null;
      candidates.push({
        label: candidate.label,
        score: bestScore,
        passageScore: bestPassageScore,
        polarityMargin: bestPolarityMargin,
        passagePolarityMargin: bestPassagePolarityMargin,
        polarityConsistent: bestPolarityConsistent,
        directionCompatible:
          hypotheses.length > 0 &&
          orderedAnchorsCompatible(testCase.query, bestWindow.text),
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
      goldLabels: testCase.goldLabels,
      candidates,
    });
  }
  return observations;
}

function topicBridgeMetrics(
  observations: Awaited<ReturnType<typeof evaluateBinaryTopicBridgeCases>>,
  threshold: number,
  minimumPassageScore: number,
) {
  return metrics(
    observations.map((entry) => ({
      ...entry,
      candidates: entry.candidates.map((candidate) => ({
        ...candidate,
        directionCompatible:
          candidate.directionCompatible &&
          candidate.polarityConsistent &&
          candidate.passageScore >= minimumPassageScore,
      })),
    })),
    threshold,
    0,
  );
}

function calibrateBinaryTopicBridge(
  observations: Awaited<ReturnType<typeof evaluateBinaryTopicBridgeCases>>,
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
  const passageFloors = [
    ...new Set([
      0,
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
          Number(candidate.passageScore.toFixed(6)),
        ),
      ),
    ]),
  ].sort((left, right) => left - right);

  const calibrationMetrics = thresholds.flatMap((threshold) =>
    passageFloors.map((minimumPassageScore) => ({
      threshold,
      minimumPassageScore,
      ...topicBridgeMetrics(calibration, threshold, minimumPassageScore),
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
          right.minimumPassageScore - left.minimumPassageScore,
      )[0] ?? null;
  const holdoutMetrics =
    calibrationCandidate === null
      ? null
      : {
          threshold: calibrationCandidate.threshold,
          minimumPassageScore: calibrationCandidate.minimumPassageScore,
          ...topicBridgeMetrics(
            holdout,
            calibrationCandidate.threshold,
            calibrationCandidate.minimumPassageScore,
          ),
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
  };
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

const binaryStarted = performance.now();
let binaryObservations: Awaited<ReturnType<typeof evaluateBinaryCases>>;
let binaryHypothesisSweepObservations: Awaited<
  ReturnType<typeof evaluateBinaryCases>
>;
let binaryTopicBridgeObservations: Awaited<
  ReturnType<typeof evaluateBinaryTopicBridgeCases>
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
  binaryTopicBridgeObservations = await evaluateBinaryTopicBridgeCases();
} finally {
  await binaryModel.dispose?.();
}

const binaryCalibrationResult = calibrateBinaryObservations(binaryObservations);
const binarySweepCalibrationResult = calibrateBinaryObservations(
  binaryHypothesisSweepObservations,
);
const binarySweepScoreOnlyMidpoint = scoreOnlyMidpointCalibration(
  binaryHypothesisSweepObservations,
);
const binaryTopicBridgeCalibrationResult = calibrateBinaryTopicBridge(
  binaryTopicBridgeObservations,
);

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
};

const binaryTopicBridgeComparison = {
  model: binaryEntailmentComparison.model,
  hypothesisStrategy:
    "shadow-only title-as-topic bridge; passage-only score floor and answer-polarity consistency are mandatory",
  calibrationCandidate: binaryTopicBridgeCalibrationResult.calibrationCandidate,
  holdoutMetrics: binaryTopicBridgeCalibrationResult.holdoutMetrics,
  holdoutPassesAcceptance:
    binaryTopicBridgeCalibrationResult.holdoutPassesAcceptance,
  observations: binaryTopicBridgeObservations,
};

const report = {
  schemaVersion: 6,
  status: "MEASURED",
  evidenceBoundary:
    "Public synthetic source-disjoint shadow evaluation of multilingual evidence signals: reranker relevance/contrast plus a pinned multilingual binary entailment model. A separate shadow-only fallback hypothesis sweep isolates missing parser coverage without replacing hypotheses already produced by the production parser. A title-as-topic bridge is measured separately and cannot admit evidence unless the passage-only entailment score clears an independently calibrated floor with consistent answer polarity. All thresholds are derived only from calibration labels and frozen for holdout. No signal is evidence truth or promoted by this report.",
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
  binaryTopicBridgeComparison,
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
