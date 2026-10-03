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
};

type ShadowCase = {
  id: string;
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
try {
  for (const testCase of CASES) {
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
        passage: candidate.parentContext?.trim() || candidate.excerpt,
        unitType: candidate.unitType ?? null,
        parentUnitType: candidate.parentUnitType ?? null,
        documentType: candidate.type,
      });
      candidates.push({
        label: candidate.document.externalId,
        candidateKey: retrievalAnswerabilityCandidateKey(candidate),
        vectorRank:
          candidate.fusionContributions?.find(
            (contribution) => contribution.channel === "vector",
          )?.rank ?? null,
        hardRequirementsSatisfied: hardRequirementsSatisfied(baseline[index]!),
        verifierDecision: verification.decision,
        verifierScore: verification.score ?? null,
        evidenceSpan: verification.evidenceSpan ?? null,
        latencyMs: performance.now() - started,
      });
    }
    observations.push({
      id: testCase.id,
      goldLabels: testCase.goldLabels,
      candidates,
    });
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
    "Public synthetic bilingual shadow evaluation only. It does not promote a verifier or estimate production-corpus precision.",
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
  productionDefaultChanged: false,
  enforcementEnabled: false,
};

await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
