import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import type { SearchHit } from "@akp/contracts";
import {
  collectCandidateAnswerabilitySignals,
  LocalMultilingualQaEvidenceVerifier,
  retrievalAnswerabilityCandidateKey,
} from "../packages/retrieval/src/index.js";

type CandidateFixture = {
  label: string;
  title: string;
  passage: string;
  vectorRank: number;
  goldSpan?: string;
};

type SlotCalibrationFamily =
  | "NAMED_ROLE"
  | "LOCATION"
  | "QUANTITY"
  | "DATE"
  | "DESTINATION"
  | "CONDITION_VALUE";

type ShadowCase = {
  id: string;
  query: string;
  candidates: CandidateFixture[];
  goldLabels: string[];
  family?: SlotCalibrationFamily;
};

function hit(input: CandidateFixture): SearchHit {
  return {
    documentId: randomUUID(),
    vaultId: randomUUID(),
    unitId: randomUUID(),
    unitType: "PARAGRAPH",
    document: {
      externalId: input.label,
      path: `benchmark/${input.label}.md`,
      title: input.title,
    },
    revision: "shadow-benchmark-v1",
    title: input.title,
    type: "concept",
    trust: "HUMAN_REVIEWED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1,
    reasons: ["shadow-benchmark"],
    fusionContributions: [
      {
        channel: "vector",
        rank: input.vectorRank,
        channelWeight: 1,
        rawScore: Math.max(0.1, 1 - input.vectorRank / 100),
        reason: "vector:shadow-benchmark",
      },
    ],
    parentContext: input.passage,
    excerpt: input.passage,
    citations: [],
  };
}

const CASES: ShadowCase[] = [
  {
    id: "avoid-history-log-operating-cost",
    query:
      "When should a durable history log be avoided because of operating cost?",
    candidates: [
      {
        label: "history-log-condition",
        title: "Avoid durable history logs without explicit temporal drivers",
        passage:
          "Durable history logs are justified by replay, audit reconstruction, or temporal queries. Without those drivers, they add unjustified operational cost.",
        vectorRank: 6,
      },
    ],
    goldLabels: ["history-log-condition"],
  },
  {
    id: "local-patterns-vs-architecture",
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
    id: "selective-architecture-views",
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
    id: "dependency-direction-rationale",
    query: "Why do dependencies point inward toward domain policies?",
    candidates: [
      {
        label: "dependency-rationale",
        title: "Dependency direction",
        passage:
          "Las dependencias apuntan hacia las políticas del dominio para mantenerlas independientes de frameworks y mecanismos externos.",
        vectorRank: 8,
      },
    ],
    goldLabels: ["dependency-rationale"],
  },
  {
    id: "duplicate-charge-replay",
    query: "How are duplicate charges prevented during replay?",
    candidates: [
      {
        label: "idempotency-replay",
        title: "Replay idempotency",
        passage:
          "A persisted idempotency key is checked before replay so the same charge is not applied twice.",
        vectorRank: 2,
      },
    ],
    goldLabels: ["idempotency-replay"],
  },
  {
    id: "unknown-monthly-cost",
    query: "What is the monthly operating cost of the subsystem?",
    candidates: [
      {
        label: "cost-without-amount",
        title: "Operating overhead",
        passage:
          "The subsystem adds recurring operational overhead and is reviewed monthly.",
        vectorRank: 1,
      },
    ],
    goldLabels: [],
  },
  {
    id: "unknown-year",
    query: "Which year did the compatibility window end?",
    candidates: [
      {
        label: "history-without-year",
        title: "Compatibility history",
        passage: "The compatibility window ended after the migration review.",
        vectorRank: 1,
      },
    ],
    goldLabels: [],
  },
  {
    id: "unknown-support-phone",
    query: "What is the guaranteed 24/7 support telephone number?",
    candidates: [
      {
        label: "support-without-phone",
        title: "Enterprise support",
        passage:
          "Enterprise support requests are opened through authenticated tickets.",
        vectorRank: 1,
      },
    ],
    goldLabels: [],
  },
  {
    id: "bilingual-functional-definition",
    query: "What is adaptive failover routing?",
    candidates: [
      {
        label: "adaptive-routing-definition",
        title: "Adaptive failover routing",
        passage:
          "El enrutamiento adaptativo selecciona un destino saludable y conserva una alternativa determinista cuando falla la ruta principal.",
        vectorRank: 4,
      },
      {
        label: "adaptive-routing-dashboard",
        title: "Adaptive routing dashboard",
        passage:
          "The dashboard records latency and availability for adaptive failover routing.",
        vectorRank: 8,
      },
    ],
    goldLabels: ["adaptive-routing-definition"],
  },
  {
    id: "generic-relation-same-entities",
    query: "Can NEXO use QARO?",
    candidates: [
      {
        label: "nexo-uses-qaro",
        title: "NEXO integration",
        passage: "NEXO can use QARO for delivery.",
        vectorRank: 3,
      },
      {
        label: "nexo-qaro-catalog",
        title: "NEXO and QARO catalog",
        passage: "NEXO and QARO are documented in separate reports.",
        vectorRank: 5,
      },
    ],
    goldLabels: ["nexo-uses-qaro"],
  },
  {
    id: "generic-relation-reversed",
    query: "Can ORCA call LUMA?",
    candidates: [
      {
        label: "reverse-call",
        title: "LUMA integration",
        passage: "LUMA can call ORCA during reconciliation.",
        vectorRank: 2,
      },
    ],
    goldLabels: [],
  },
  {
    id: "indirect-responsibility-relation",
    query: "Does a single-purpose module reduce reasons to change?",
    candidates: [
      {
        label: "single-purpose-change-reason",
        title: "Single-purpose modules",
        passage:
          "Un módulo con una sola responsabilidad concentra sus cambios en un único motivo de negocio.",
        vectorRank: 7,
      },
    ],
    goldLabels: ["single-purpose-change-reason"],
  },
  {
    id: "conditional-selection-rule",
    query: "When should a bounded worker pool be chosen?",
    candidates: [
      {
        label: "bounded-worker-condition",
        title: "Bounded worker pool selection",
        passage:
          "Choose a bounded worker pool when downstream capacity is limited and unbounded concurrency would overload the dependency.",
        vectorRank: 5,
      },
    ],
    goldLabels: ["bounded-worker-condition"],
  },
];

const SLOT_CALIBRATION_CASES: ShadowCase[] = [
  {
    id: "slot-cal-named-role-positive",
    family: "NAMED_ROLE",
    query: "Who is the named reviewer for KESTO?",
    candidates: [
      {
        label: "kesto-reviewer",
        title: "KESTO review ownership",
        passage: "MIRA is the named reviewer for KESTO.",
        vectorRank: 1,
        goldSpan: "MIRA",
      },
      {
        label: "kesto-review-metrics",
        title: "KESTO review telemetry",
        passage: "KESTO records review latency and approval status.",
        vectorRank: 2,
      },
    ],
    goldLabels: ["kesto-reviewer"],
  },
  {
    id: "slot-cal-named-role-negative",
    family: "NAMED_ROLE",
    query: "Who is the named reviewer for PAVO?",
    candidates: [
      {
        label: "pavo-review-topic",
        title: "PAVO review workflow",
        passage:
          "PAVO records review state and approval history, but this source does not name a reviewer.",
        vectorRank: 1,
      },
    ],
    goldLabels: [],
  },
  {
    id: "slot-cal-location-positive",
    family: "LOCATION",
    query: "Where is the RENO archive stored?",
    candidates: [
      {
        label: "reno-location",
        title: "RENO archive residency",
        passage: "The RENO archive is stored in region VELA.",
        vectorRank: 1,
        goldSpan: "region VELA",
      },
      {
        label: "reno-dashboard",
        title: "RENO monitoring",
        passage: "RENO dashboards are viewed from region VELA.",
        vectorRank: 2,
      },
    ],
    goldLabels: ["reno-location"],
  },
  {
    id: "slot-cal-location-negative",
    family: "LOCATION",
    query: "Where is the SUMA archive stored?",
    candidates: [
      {
        label: "suma-location-absent",
        title: "SUMA archive monitoring",
        passage:
          "SUMA reports archive latency from region NARO; storage residency is not defined here.",
        vectorRank: 1,
      },
    ],
    goldLabels: [],
  },
  {
    id: "slot-cal-quantity-positive",
    family: "QUANTITY",
    query: "How many retry attempts are allowed for TILO?",
    candidates: [
      {
        label: "tilo-retry-limit",
        title: "TILO retry policy",
        passage: "TILO allows 4 retry attempts before escalation.",
        vectorRank: 1,
        goldSpan: "4",
      },
      {
        label: "tilo-workers",
        title: "TILO workers",
        passage: "TILO currently runs 4 retry workers.",
        vectorRank: 2,
      },
    ],
    goldLabels: ["tilo-retry-limit"],
  },
  {
    id: "slot-cal-quantity-negative",
    family: "QUANTITY",
    query: "How many retry attempts are allowed for BERA?",
    candidates: [
      {
        label: "bera-workers-only",
        title: "BERA retry telemetry",
        passage:
          "BERA currently runs 6 retry workers; this source does not define the attempt limit.",
        vectorRank: 1,
      },
    ],
    goldLabels: [],
  },
  {
    id: "slot-cal-date-positive",
    family: "DATE",
    query: "When is the approved KORA maintenance window?",
    candidates: [
      {
        label: "kora-date",
        title: "KORA maintenance approval",
        passage: "The approved KORA maintenance window is 2027-04-16.",
        vectorRank: 1,
        goldSpan: "2027-04-16",
      },
      {
        label: "kora-history",
        title: "KORA maintenance history",
        passage: "KORA maintenance was reviewed during 2027 planning.",
        vectorRank: 2,
      },
    ],
    goldLabels: ["kora-date"],
  },
  {
    id: "slot-cal-date-negative",
    family: "DATE",
    query: "When is the approved SENA maintenance window?",
    candidates: [
      {
        label: "sena-date-absent",
        title: "SENA maintenance planning",
        passage:
          "SENA maintenance is reviewed during 2028 planning; no approved window is recorded here.",
        vectorRank: 1,
      },
    ],
    goldLabels: [],
  },
  {
    id: "slot-cal-destination-positive",
    family: "DESTINATION",
    query: "Which destination receives NIVA audit exports?",
    candidates: [
      {
        label: "niva-destination",
        title: "NIVA audit export",
        passage: "NIVA audit exports are written to the QUOR archive.",
        vectorRank: 1,
        goldSpan: "QUOR archive",
      },
      {
        label: "niva-observability",
        title: "NIVA export monitoring",
        passage: "NIVA monitors audit export latency in QUOR dashboards.",
        vectorRank: 2,
      },
    ],
    goldLabels: ["niva-destination"],
  },
  {
    id: "slot-cal-destination-negative",
    family: "DESTINATION",
    query: "Which destination receives LARO audit exports?",
    candidates: [
      {
        label: "laro-destination-absent",
        title: "LARO audit export monitoring",
        passage:
          "LARO reports export throughput and failures; this source does not define the destination.",
        vectorRank: 1,
      },
    ],
    goldLabels: [],
  },
  {
    id: "slot-cal-condition-positive",
    family: "CONDITION_VALUE",
    query: "What condition enables VIMO failover?",
    candidates: [
      {
        label: "vimo-condition",
        title: "VIMO failover policy",
        passage:
          "VIMO failover is enabled when the primary route is unhealthy.",
        vectorRank: 1,
        goldSpan: "when the primary route is unhealthy",
      },
      {
        label: "vimo-status",
        title: "VIMO failover dashboard",
        passage: "VIMO displays primary route health and failover status.",
        vectorRank: 2,
      },
    ],
    goldLabels: ["vimo-condition"],
  },
  {
    id: "slot-cal-condition-negative",
    family: "CONDITION_VALUE",
    query: "What condition enables DORO failover?",
    candidates: [
      {
        label: "doro-condition-absent",
        title: "DORO failover telemetry",
        passage:
          "DORO records failover events and route health; the enabling condition is not specified.",
        vectorRank: 1,
      },
    ],
    goldLabels: [],
  },
];

const reportPath = path.resolve(
  process.env.AKP_EVIDENCE_VERIFIER_SHADOW_REPORT ??
    "reports/ci/evidence-verifier-shadow-benchmark.json",
);
const verifier = new LocalMultilingualQaEvidenceVerifier({
  minimumSupportScore: 0.000001,
  cacheDir: process.env.AKP_MODEL_CACHE_DIR,
  localFilesOnly: false,
});

function hardRequirementsSatisfied(
  signal: ReturnType<typeof collectCandidateAnswerabilitySignals>[number],
): boolean {
  return (["QUANTITY", "DATE_YEAR"] as const).every(
    (cue) =>
      !signal.passageSupport.requiredAnswerCues.includes(cue) ||
      signal.passageSupport.matchedAnswerCues.includes(cue),
  );
}

const observations = [];
const slotCalibrationObservations = [];
try {
  for (const testCase of [...CASES, ...SLOT_CALIBRATION_CASES]) {
    const hits = testCase.candidates.map(hit);
    const baseline = collectCandidateAnswerabilitySignals(hits, testCase.query);
    const candidates = [];
    for (let index = 0; index < hits.length; index += 1) {
      const candidate = hits[index]!;
      const started = performance.now();
      const verification = await verifier.verify({
        query: testCase.query,
        candidateKey: retrievalAnswerabilityCandidateKey(candidate),
        title: candidate.title,
        passage: candidate.excerpt,
        unitType: candidate.unitType ?? null,
        parentUnitType: candidate.parentUnitType ?? null,
        documentType: candidate.type,
      });
      const fixture = testCase.candidates[index]!;
      const evidenceText = verification.evidenceSpan
        ? candidate.excerpt.slice(
            verification.evidenceSpan.startOffset,
            verification.evidenceSpan.endOffset,
          )
        : null;
      candidates.push({
        label: candidate.document.externalId,
        candidateKey: retrievalAnswerabilityCandidateKey(candidate),
        vectorRank:
          candidate.fusionContributions?.find(
            (contribution) => contribution.channel === "vector",
          )?.rank ?? null,
        hardRequirementsSatisfied: hardRequirementsSatisfied(baseline[index]!),
        verifierDecision: verification.decision,
        verifierReason: verification.reason,
        verifierScore: verification.score ?? null,
        evidenceSpan: verification.evidenceSpan ?? null,
        spanCorrect:
          fixture.goldSpan === undefined
            ? null
            : evidenceText?.trim() === fixture.goldSpan.trim(),
        latencyMs: performance.now() - started,
      });
    }
    const row = {
      id: testCase.id,
      family: testCase.family ?? null,
      goldLabels: testCase.goldLabels,
      candidates,
    };
    if (testCase.family) slotCalibrationObservations.push(row);
    else observations.push(row);
  }
} finally {
  await verifier.dispose();
}

const observedScores = observations.flatMap((entry) =>
  entry.candidates.flatMap((candidate) =>
    typeof candidate.verifierScore === "number"
      ? [candidate.verifierScore]
      : [],
  ),
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

const thresholdMetrics = thresholds.map((threshold) => {
  let expectedPositiveCases = 0;
  let expectedNegativeCases = 0;
  let falseAbstentions = 0;
  let falseAcceptances = 0;
  let selected = 0;
  let selectedGold = 0;

  for (const entry of observations) {
    const gold = new Set(entry.goldLabels);
    const accepted = entry.candidates.filter(
      (candidate) =>
        candidate.verifierDecision === "SUPPORTS" &&
        candidate.hardRequirementsSatisfied &&
        (candidate.verifierScore ?? 0) >= threshold,
    );
    const acceptedGold = accepted.filter((candidate) =>
      gold.has(candidate.label ?? ""),
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
    threshold,
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
});


const slotObservedScores = slotCalibrationObservations.flatMap((entry) =>
  entry.candidates.flatMap((candidate) =>
    typeof candidate.verifierScore === "number"
      ? [candidate.verifierScore]
      : [],
  ),
);
const slotThresholds = [
  ...new Set([
    0.01,
    0.025,
    0.05,
    0.075,
    0.1,
    0.15,
    0.2,
    0.3,
    0.4,
    0.5,
    0.6,
    0.7,
    0.8,
    0.9,
    ...slotObservedScores.map((score) => Number(score.toFixed(6))),
  ]),
].sort((left, right) => left - right);

const slotCalibrationMetrics = slotThresholds.map((threshold) => {
  let positiveCases = 0;
  let negativeCases = 0;
  let falseAbstentions = 0;
  let falseAcceptances = 0;
  let selected = 0;
  let selectedGold = 0;
  let selectedWrong = 0;
  let selectedGoldWithSpan = 0;
  let selectedGoldSpanCorrect = 0;

  for (const entry of slotCalibrationObservations) {
    const gold = new Set(entry.goldLabels);
    const accepted = entry.candidates.filter(
      (candidate) =>
        candidate.verifierDecision === "SUPPORTS" &&
        candidate.hardRequirementsSatisfied &&
        (candidate.verifierScore ?? 0) >= threshold,
    );
    const acceptedGold = accepted.filter((candidate) =>
      gold.has(candidate.label ?? ""),
    );
    const acceptedWrong = accepted.filter(
      (candidate) => !gold.has(candidate.label ?? ""),
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
    threshold,
    positiveCases,
    negativeCases,
    falseAbstentions,
    falseAbstentionRate:
      positiveCases === 0 ? null : falseAbstentions / positiveCases,
    falseAcceptances,
    falseAcceptanceRate:
      negativeCases === 0 ? null : falseAcceptances / negativeCases,
    selectedCandidates: selected,
    selectedGoldCandidates: selectedGold,
    wrongSelections: selectedWrong,
    supportSelectionPrecision: selected === 0 ? null : selectedGold / selected,
    spanAccuracy:
      selectedGold === 0 ||
      selectedGoldWithSpan !== selectedGold ||
      selectedGoldWithSpan === 0
        ? null
        : selectedGoldSpanCorrect / selectedGoldWithSpan,
  };
});

const slotCalibrationCandidate =
  slotCalibrationMetrics
    .filter(
      (metrics) =>
        metrics.falseAcceptances === 0 &&
        metrics.wrongSelections === 0 &&
        metrics.supportSelectionPrecision === 1 &&
        metrics.spanAccuracy === 1,
    )
    .sort(
      (left, right) =>
        left.falseAbstentions - right.falseAbstentions ||
        right.threshold - left.threshold,
    )[0] ?? null;

const slotCalibration = {
  status: "MEASURED",
  evaluationUse: "DEVELOPMENT_CALIBRATION_ONLY",
  holdoutEvaluated: false,
  thresholdTuningAllowed: true,
  model: {
    id: verifier.id,
    revision: "484112fae76dde6ad01b640192d559cbc2d488e1",
  },
  families: [
    ...new Set(
      SLOT_CALIBRATION_CASES.map((entry) => entry.family).filter(Boolean),
    ),
  ].sort(),
  cases: slotCalibrationObservations.length,
  metrics: slotCalibrationMetrics,
  calibrationCandidate: slotCalibrationCandidate,
  promotionAllowed: false,
  nextStep:
    slotCalibrationCandidate === null
      ? "REJECT this QA slot-reader candidate before blind holdout."
      : "Freeze this boundary in a versioned experiment SHA, then author a new family-disjoint holdout without reusing these cases or families.",
};

const promotionCandidates = thresholdMetrics.filter(
  (metrics) =>
    metrics.falseAcceptanceRate === 0 &&
    metrics.falseAbstentionRate === 0 &&
    metrics.supportSelectionPrecision === 1,
);

const report = {
  schemaVersion: 1,
  status: "MEASURED",
  evidenceBoundary:
    "Public synthetic bilingual shadow evaluation covering direct, negative, relational, definitional and conditional evidence. It does not promote a verifier or estimate production-corpus precision.",
  model: {
    id: verifier.id,
    provider: "local-transformers-js",
  },
  cases: observations,
  thresholdMetrics,
  promotionCandidate:
    promotionCandidates.length === 0
      ? null
      : promotionCandidates.sort(
          (left, right) => right.threshold - left.threshold,
        )[0],
  slotCalibration,
  productionDefaultChanged: false,
  enforcementEnabled: false,
};

await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
