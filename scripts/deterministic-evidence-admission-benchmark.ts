import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SearchHit } from "@akp/contracts";
import {
  assessRetrievalAnswerability,
  retrievalAnswerabilityCandidateKey,
} from "../packages/retrieval/src/index.js";

type Fixture = {
  label: string;
  title: string;
  passage: string;
  type?: string;
  aliases?: string[];
  structuralOrder?: number;
  headingPath?: string[];
  vectorRank?: number;
};

type AdmissionCase = {
  id: string;
  tier: "CORE" | "SEMANTIC_FRONTIER";
  query: string;
  candidates: Fixture[];
  goldLabels: string[];
};

function hit(input: Fixture): SearchHit {
  return {
    documentId: randomUUID(),
    vaultId: randomUUID(),
    unitId: randomUUID(),
    unitType: "PARAGRAPH",
    ...(input.structuralOrder === undefined
      ? {}
      : { structuralOrder: input.structuralOrder }),
    ...(input.headingPath ? { headingPath: input.headingPath } : {}),
    document: {
      externalId: input.label,
      path: `benchmark/${input.label}.md`,
      title: input.title,
      ...(input.aliases ? { aliases: input.aliases } : {}),
    },
    revision: "deterministic-admission-v1",
    title: input.title,
    type: input.type ?? "claim",
    trust: "MACHINE_SUPPORTED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1,
    reasons: ["deterministic-admission-benchmark"],
    fusionContributions: [
      {
        channel: "vector",
        rank: input.vectorRank ?? 1,
        channelWeight: 1,
        rawScore: 0.8,
        reason: "vector:deterministic-admission-benchmark",
      },
    ],
    excerpt: input.passage,
    citations: [],
  };
}

const CASES: AdmissionCase[] = [
  {
    id: "direct-generic-relation",
    tier: "CORE",
    query: "Can NEXO use QARO?",
    candidates: [
      {
        label: "direct",
        title: "NEXO integration",
        passage: "NEXO can use QARO for delivery.",
        vectorRank: 3,
      },
      {
        label: "same-entities-other-relation",
        title: "NEXO and QARO catalog",
        passage: "NEXO and QARO are documented in separate reports.",
        vectorRank: 1,
      },
    ],
    goldLabels: ["direct"],
  },
  {
    id: "reversed-relation",
    tier: "CORE",
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
    id: "bilingual-concept-definition",
    tier: "CORE",
    query: "What is adaptive failover routing?",
    candidates: [
      {
        label: "definition",
        title: "Adaptive failover routing",
        type: "concept",
        aliases: ["enrutamiento adaptativo"],
        structuralOrder: 2,
        headingPath: ["Adaptive failover routing"],
        passage:
          "El enrutamiento adaptativo selecciona un destino saludable y conserva una alternativa determinista cuando falla la ruta principal.",
        vectorRank: 4,
      },
    ],
    goldLabels: ["definition"],
  },
  {
    id: "thematic-intro-is-not-definition",
    tier: "CORE",
    query: "What is adaptive failover routing?",
    candidates: [
      {
        label: "operations",
        title: "Adaptive failover routing",
        type: "concept",
        aliases: ["enrutamiento adaptativo"],
        structuralOrder: 2,
        headingPath: ["Adaptive failover routing"],
        passage:
          "Latency, availability, and error counters are recorded every minute for operations.",
      },
    ],
    goldLabels: [],
  },
  {
    id: "direct-condition",
    tier: "CORE",
    query: "When should a bounded worker pool be chosen?",
    candidates: [
      {
        label: "condition",
        title: "Bounded worker pool selection",
        type: "rule",
        passage:
          "Choose a bounded worker pool when downstream capacity is limited and unbounded concurrency would overload the dependency.",
      },
    ],
    goldLabels: ["condition"],
  },
  {
    id: "direct-rationale",
    tier: "CORE",
    query: "Why do dependencies point toward domain policies?",
    candidates: [
      {
        label: "rationale",
        title: "Dependency direction",
        passage:
          "Dependencies point toward domain policies because this keeps domain decisions independent from framework mechanisms.",
      },
    ],
    goldLabels: ["rationale"],
  },
  {
    id: "missing-quantity",
    tier: "CORE",
    query: "What is the monthly operating cost?",
    candidates: [
      {
        label: "cost-topic",
        title: "Operating cost",
        passage:
          "The operating cost depends on deployment size and support requirements.",
      },
    ],
    goldLabels: [],
  },
  {
    id: "missing-year",
    tier: "CORE",
    query: "In what year was the migration completed?",
    candidates: [
      {
        label: "migration-topic",
        title: "Migration history",
        passage:
          "The migration was completed after the final verification run.",
      },
    ],
    goldLabels: [],
  },
  {
    id: "title-cannot-supply-generic-subject",
    tier: "CORE",
    query: "Can NEXO use QARO?",
    candidates: [
      {
        label: "title-only",
        title: "NEXO integration",
        type: "rule",
        passage: "Reviewers can use QARO while checking reports.",
      },
    ],
    goldLabels: [],
  },
  {
    id: "indirect-bilingual-responsibility",
    tier: "SEMANTIC_FRONTIER",
    query: "Does a single-purpose module reduce reasons to change?",
    candidates: [
      {
        label: "indirect",
        title: "Single-purpose modules",
        type: "claim",
        passage:
          "Un módulo con una sola responsabilidad concentra sus cambios en un único motivo de negocio.",
      },
    ],
    goldLabels: ["indirect"],
  },
];

const rows = CASES.map((entry) => {
  const hits = entry.candidates.map(hit);
  const result = assessRetrievalAnswerability(hits, entry.query);
  const selected = new Set(result.supportedCandidateKeys);
  const selectedLabels = hits.flatMap((candidate, index) =>
    selected.has(retrievalAnswerabilityCandidateKey(candidate))
      ? [entry.candidates[index]!.label]
      : [],
  );
  const gold = new Set(entry.goldLabels);
  const selectedGold = selectedLabels.filter((label) => gold.has(label));
  const selectedWrong = selectedLabels.filter((label) => !gold.has(label));
  const expectedAnswer = entry.goldLabels.length > 0;
  return {
    id: entry.id,
    tier: entry.tier,
    query: entry.query,
    goldLabels: entry.goldLabels,
    selectedLabels,
    supported: result.supported,
    reason: result.reason,
    falseAcceptance: !expectedAnswer && selectedLabels.length > 0,
    falseAbstention: expectedAnswer && selectedGold.length === 0,
    wrongSelection: selectedWrong.length > 0,
    supportSelectionPrecision:
      selectedLabels.length === 0
        ? null
        : selectedGold.length / selectedLabels.length,
  };
});

function metrics(tier: AdmissionCase["tier"]) {
  const scoped = rows.filter((row) => row.tier === tier);
  const positives = scoped.filter((row) => row.goldLabels.length > 0);
  const negatives = scoped.filter((row) => row.goldLabels.length === 0);
  const selected = scoped.flatMap((row) =>
    row.selectedLabels.map((label) => ({ row, label })),
  );
  const selectedGold = selected.filter(({ row, label }) =>
    row.goldLabels.includes(label),
  );
  return {
    cases: scoped.length,
    positiveCases: positives.length,
    negativeCases: negatives.length,
    falseAcceptances: negatives.filter((row) => row.falseAcceptance).length,
    falseAcceptanceRate:
      negatives.length === 0
        ? 0
        : negatives.filter((row) => row.falseAcceptance).length /
          negatives.length,
    falseAbstentions: positives.filter((row) => row.falseAbstention).length,
    falseAbstentionRate:
      positives.length === 0
        ? 0
        : positives.filter((row) => row.falseAbstention).length /
          positives.length,
    wrongSelections: scoped.filter((row) => row.wrongSelection).length,
    supportSelectionPrecision:
      selected.length === 0 ? 1 : selectedGold.length / selected.length,
  };
}

const core = metrics("CORE");
const semanticFrontier = metrics("SEMANTIC_FRONTIER");
const corePasses =
  core.falseAcceptances === 0 &&
  core.falseAbstentions === 0 &&
  core.wrongSelections === 0 &&
  core.supportSelectionPrecision === 1;

const report = {
  schemaVersion: 1,
  status: corePasses ? "PROVEN" : "FAILED",
  evidenceBoundary:
    "Public synthetic deterministic evidence-admission benchmark. CORE is a CI gate; SEMANTIC_FRONTIER measures known paraphrase limits without promoting a semantic verifier.",
  core,
  semanticFrontier,
  rows,
};

const outputPath = path.resolve(
  process.env.AKP_DETERMINISTIC_EVIDENCE_ADMISSION_REPORT ??
    "reports/ci/deterministic-evidence-admission-benchmark.json",
);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(JSON.stringify(report, null, 2));
if (!corePasses) process.exitCode = 1;
