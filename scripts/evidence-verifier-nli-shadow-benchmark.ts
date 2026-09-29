import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { SearchHit } from "@akp/contracts";
import {
  LOCAL_MULTILINGUAL_NLI_MDEBERTA_DESCRIPTOR,
  LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR,
  LocalMultilingualNliEvidenceVerifier,
  retrievalAnswerabilityCandidateKey,
} from "../packages/retrieval/src/index.js";

type EvaluationSplit = "CALIBRATION" | "HOLDOUT";

type CandidateFixture = {
  label: string;
  title: string;
  passage: string;
  vectorRank: number;
};

type ShadowCase = {
  id: string;
  split: EvaluationSplit;
  query: string;
  candidates: CandidateFixture[];
  goldLabels: string[];
};

function hit(input: CandidateFixture): SearchHit {
  return {
    documentId: randomUUID(),
    vaultId: randomUUID(),
    unitId: randomUUID(),
    unitType: "PARAGRAPH",
    document: {
      externalId: input.label,
      path: `benchmark/nli/${input.label}.md`,
      title: input.title,
    },
    revision: "nli-shadow-benchmark-v1",
    title: input.title,
    type: "concept",
    trust: "HUMAN_REVIEWED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1,
    reasons: ["nli-shadow-benchmark"],
    fusionContributions: [
      {
        channel: "vector",
        rank: input.vectorRank,
        channelWeight: 1,
        rawScore: Math.max(0.1, 1 - input.vectorRank / 100),
        reason: "vector:nli-shadow-benchmark",
      },
    ],
    parentContext: input.passage,
    excerpt: input.passage,
    citations: [],
  };
}

const CASES: ShadowCase[] = [
  {
    id: "patterns-do-not-define-architecture",
    split: "CALIBRATION",
    query:
      "Do Strategy and Adapter patterns define the overall system architecture?",
    candidates: [
      {
        label: "patterns-not-architecture",
        title: "Local patterns are not system architecture",
        passage:
          "Strategy y Adapter son patrones locales. No determinan el conjunto de módulos, límites ni la dirección global de dependencias del sistema.",
        vectorRank: 1,
      },
      {
        label: "adapter-uniqueness-strategy",
        title: "Persistence adapter example",
        passage:
          "The persistence adapter defines a uniqueness strategy for generated record keys.",
        vectorRank: 51,
      },
    ],
    goldLabels: ["patterns-not-architecture"],
  },
  {
    id: "views-not-mandatory",
    split: "CALIBRATION",
    query: "Does ViewMap require every level of diagram?",
    candidates: [
      {
        label: "selective-views",
        title: "ViewMap selective views",
        passage:
          "Las vistas de ViewMap se seleccionan según la necesidad; no son una lista obligatoria de entregables.",
        vectorRank: 34,
      },
    ],
    goldLabels: ["selective-views"],
  },
  {
    id: "repository-not-vendor-bound",
    split: "CALIBRATION",
    query: "Does the Repository pattern require a specific database vendor?",
    candidates: [
      {
        label: "repository-abstraction",
        title: "Repository abstraction",
        passage:
          "El patrón Repository abstrae la persistencia y no exige un proveedor específico de base de datos.",
        vectorRank: 4,
      },
    ],
    goldLabels: ["repository-abstraction"],
  },
  {
    id: "audit-retention-unknown",
    split: "CALIBRATION",
    query: "Does the audit policy require seven-year retention?",
    candidates: [
      {
        label: "audit-fields-only",
        title: "Audit record fields",
        passage:
          "The audit policy records the actor, action and timestamp for each governed change.",
        vectorRank: 2,
      },
    ],
    goldLabels: [],
  },
  {
    id: "circuit-breaker-not-service-boundary",
    split: "HOLDOUT",
    query: "Do circuit breakers define service boundaries?",
    candidates: [
      {
        label: "breaker-failure-control",
        title: "Circuit breaker scope",
        passage:
          "Los circuit breakers controlan fallos transitorios; no determinan los límites entre servicios.",
        vectorRank: 7,
      },
      {
        label: "boundary-breaker-threshold",
        title: "Service boundary example",
        passage:
          "A service boundary publishes the circuit breaker threshold used by one outbound client.",
        vectorRank: 21,
      },
    ],
    goldLabels: ["breaker-failure-control"],
  },
  {
    id: "idempotency-prevents-duplicate-processing",
    split: "HOLDOUT",
    query: "Does an idempotency key prevent duplicate processing?",
    candidates: [
      {
        label: "idempotency-deduplication",
        title: "Idempotency key",
        passage:
          "Una clave de idempotencia evita procesar dos veces la misma operación cuando se repite la solicitud.",
        vectorRank: 3,
      },
    ],
    goldLabels: ["idempotency-deduplication"],
  },
  {
    id: "feature-flags-not-module-architecture",
    split: "HOLDOUT",
    query: "Do feature flags define the module architecture?",
    candidates: [
      {
        label: "feature-flags-rollout",
        title: "Feature flag responsibility",
        passage:
          "Feature flags control rollout decisions; they do not define module boundaries or the architecture of the system.",
        vectorRank: 5,
      },
    ],
    goldLabels: ["feature-flags-rollout"],
  },
  {
    id: "cache-vendor-unknown",
    split: "HOLDOUT",
    query: "Does the cache adapter require Redis?",
    candidates: [
      {
        label: "cache-deployment-example",
        title: "Cache deployment",
        passage:
          "One deployment configures the cache adapter with Redis and a five-minute expiration.",
        vectorRank: 1,
      },
    ],
    goldLabels: [],
  },
  {
    id: "bounded-queue-controls-backpressure",
    split: "HOLDOUT",
    query: "Can a bounded queue control backpressure?",
    candidates: [
      {
        label: "bounded-queue-backpressure",
        title: "Bounded queue",
        passage:
          "Una cola acotada controla la contrapresión al limitar cuántos elementos pueden quedar pendientes.",
        vectorRank: 6,
      },
    ],
    goldLabels: ["bounded-queue-backpressure"],
  },
  {
    id: "migration-authorization-unknown",
    split: "HOLDOUT",
    query: "Does a schema migration establish the authorization policy?",
    candidates: [
      {
        label: "migration-tables",
        title: "Schema migration",
        passage:
          "The schema migration establishes new tables used to store authorization policy records.",
        vectorRank: 2,
      },
    ],
    goldLabels: [],
  },
];

const reportPath = path.resolve(
  process.env.AKP_EVIDENCE_VERIFIER_NLI_SHADOW_REPORT ??
    "reports/ci/evidence-verifier-nli-shadow-benchmark.json",
);

const MODEL_DESCRIPTORS = [
  LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR,
  LOCAL_MULTILINGUAL_NLI_MDEBERTA_DESCRIPTOR,
] as const;

const modelRuns = [];
for (const modelDescriptor of MODEL_DESCRIPTORS) {
  const verifier = new LocalMultilingualNliEvidenceVerifier({
    minimumEntailmentScore: 0,
    minimumPolarityMargin: 0,
    modelDescriptor,
    cacheDir: process.env.AKP_MODEL_CACHE_DIR,
    localFilesOnly: false,
  });
  const observations = [];
  try {
    for (const testCase of CASES) {
      const candidates = [];
      for (const fixture of testCase.candidates) {
        const candidate = hit(fixture);
        const started = performance.now();
        const verification = await verifier.verify({
          query: testCase.query,
          candidateKey: retrievalAnswerabilityCandidateKey(candidate),
          title: candidate.title,
          passage: candidate.parentContext?.trim() || candidate.excerpt,
          unitType: candidate.unitType ?? null,
          parentUnitType: candidate.parentUnitType ?? null,
          documentType: candidate.type,
        });
        candidates.push({
          label: fixture.label,
          candidateKey: retrievalAnswerabilityCandidateKey(candidate),
          vectorRank: fixture.vectorRank,
          verifierDecision: verification.decision,
          verifierScore: verification.score ?? null,
          verifierReason: verification.reason,
          evidenceSpan: verification.evidenceSpan ?? null,
          latencyMs: performance.now() - started,
        });
      }
      observations.push({
        id: testCase.id,
        split: testCase.split,
        goldLabels: testCase.goldLabels,
        candidates,
      });
    }
  } finally {
    await verifier.dispose();
  }
  modelRuns.push({
    modelDescriptor,
    verifierId: verifier.id,
    observations,
  });
}

function metricsFor(
  rows: typeof observations,
  threshold: number,
): {
  falseAbstentionRate: number;
  falseAcceptanceRate: number;
  supportSelectionPrecision: number;
  selectedCandidates: number;
  selectedGoldCandidates: number;
} {
  let expectedPositiveCases = 0;
  let expectedNegativeCases = 0;
  let falseAbstentions = 0;
  let falseAcceptances = 0;
  let selected = 0;
  let selectedGold = 0;

  for (const entry of rows) {
    const gold = new Set(entry.goldLabels);
    const accepted = entry.candidates.filter(
      (candidate) =>
        candidate.verifierDecision === "SUPPORTS" &&
        (candidate.verifierScore ?? 0) >= threshold,
    );
    const acceptedGold = accepted.filter((candidate) =>
      gold.has(candidate.label),
    );
    selected += accepted.length;
    selectedGold += acceptedGold.length;

    if (gold.size > 0) {
      expectedPositiveCases += 1;
      if (acceptedGold.length === 0) falseAbstentions += 1;
    } else {
      expectedNegativeCases += 1;
      if (accepted.length > 0) falseAcceptances += 1;
    }
  }

  return {
    falseAbstentionRate:
      expectedPositiveCases === 0
        ? 0
        : falseAbstentions / expectedPositiveCases,
    falseAcceptanceRate:
      expectedNegativeCases === 0
        ? 0
        : falseAcceptances / expectedNegativeCases,
    supportSelectionPrecision: selected === 0 ? 0 : selectedGold / selected,
    selectedCandidates: selected,
    selectedGoldCandidates: selectedGold,
  };
}

const comparisons = modelRuns.map((modelRun) => {
  const calibration = modelRun.observations.filter(
    (entry) => entry.split === "CALIBRATION",
  );
  const holdout = modelRun.observations.filter(
    (entry) => entry.split === "HOLDOUT",
  );
  const observedCalibrationScores = calibration.flatMap((entry) =>
    entry.candidates.flatMap((candidate) =>
      typeof candidate.verifierScore === "number"
        ? [candidate.verifierScore]
        : [],
    ),
  );
  const thresholds = [
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
      ...observedCalibrationScores.map((score) => Number(score.toFixed(6))),
    ]),
  ].sort((left, right) => left - right);

  const calibrationMetrics = thresholds.map((threshold) => ({
    threshold,
    ...metricsFor(calibration, threshold),
  }));
  const calibrationCandidate =
    calibrationMetrics
      .filter(
        (metrics) =>
          metrics.falseAcceptanceRate === 0 &&
          metrics.falseAbstentionRate === 0 &&
          metrics.supportSelectionPrecision === 1,
      )
      .sort((left, right) => right.threshold - left.threshold)[0] ?? null;
  const holdoutMetrics =
    calibrationCandidate === null
      ? null
      : {
          threshold: calibrationCandidate.threshold,
          ...metricsFor(holdout, calibrationCandidate.threshold),
        };

  return {
    modelDescriptor: modelRun.modelDescriptor,
    verifierId: modelRun.verifierId,
    cases: modelRun.observations,
    calibrationMetrics,
    calibrationCandidate,
    holdoutMetrics,
    holdoutPassesAcceptance:
      holdoutMetrics !== null &&
      holdoutMetrics.falseAcceptanceRate === 0 &&
      holdoutMetrics.falseAbstentionRate === 0 &&
      holdoutMetrics.supportSelectionPrecision === 1,
  };
});

const report = {
  schemaVersion: 2,
  status: "MEASURED",
  evidenceBoundary:
    "Public synthetic bilingual calibration/holdout shadow comparison only. No threshold or verifier is promoted by this report.",
  splitCounts: {
    calibration: CASES.filter((entry) => entry.split === "CALIBRATION").length,
    holdout: CASES.filter((entry) => entry.split === "HOLDOUT").length,
  },
  comparisons,
  productionDefaultChanged: false,
  enforcementEnabled: false,
  promotionAllowed: false,
};

await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
