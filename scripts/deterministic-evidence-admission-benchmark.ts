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
  unitType?: SearchHit["unitType"];
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
    unitType: input.unitType ?? "PARAGRAPH",
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
    id: "direct-decision-rule-relation",
    tier: "CORE",
    query: "Can ALTO notify BRIO?",
    candidates: [
      {
        label: "direct-decision-rule",
        title: "ALTO notification rule",
        type: "decision-rule",
        passage: "ALTO can notify BRIO after validation succeeds.",
        vectorRank: 5,
      },
      {
        label: "decision-rule-other-relation",
        title: "ALTO and BRIO reporting rule",
        type: "decision-rule",
        passage: "ALTO and BRIO are listed in separate operational reports.",
        vectorRank: 2,
      },
    ],
    goldLabels: ["direct-decision-rule"],
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
    id: "missing-contact-value",
    tier: "CORE",
    query: "What is the emergency support phone number?",
    candidates: [
      {
        label: "support-topic",
        title: "Emergency support",
        type: "concept",
        structuralOrder: 2,
        headingPath: ["Emergency support"],
        passage:
          "Emergency support requests are handled through authenticated tickets.",
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
    id: "infinitive-question-is-not-thematic-support",
    tier: "CORE",
    query: "¿Utilizar ALTO demuestra BRIO?",
    candidates: [
      {
        label: "topic-only",
        title: "ALTO and BRIO",
        passage: "ALTO and BRIO are discussed in the same catalog.",
      },
      {
        label: "reference-only",
        title: "ALTO and BRIO references",
        passage: "See [[claims/alto-demuestra-brio]] for the assertion.",
      },
    ],
    goldLabels: [],
  },
  {
    id: "yes-no-relation-requires-predicate",
    tier: "CORE",
    query: "¿Es obligatorio ALTO para BRIO?",
    candidates: [
      {
        label: "same-nouns",
        title: "ALTO and BRIO",
        passage: "ALTO and BRIO are listed together in an operations report.",
      },
    ],
    goldLabels: [],
  },
  {
    id: "wiki-link-is-not-an-assertion",
    tier: "CORE",
    query: "Can NEXO use QARO?",
    candidates: [
      {
        label: "link-only",
        title: "NEXO notes",
        passage: "See [[claims/nexo-can-use-qaro]] for the approved assertion.",
      },
    ],
    goldLabels: [],
  },
  {
    id: "claim-link-slug-is-not-relation-evidence",
    tier: "CORE",
    query: "Does NEXO require QARO?",
    candidates: [
      {
        label: "claim-reference",
        title: "NEXO integration",
        type: "claim",
        passage: "See [[claims/nexo-requires-qaro]] for the approved relation.",
      },
    ],
    goldLabels: [],
  },
  {
    id: "shared-resource-for-other-subjects",
    tier: "CORE",
    query: "Can intake and dispatch share a queue?",
    candidates: [
      {
        label: "wrong-share-subjects",
        title: "Resource observations",
        passage:
          "Intake and dispatch monitor two processors, although both processors use the same queue.",
      },
    ],
    goldLabels: [],
  },
  {
    id: "optionality-for-other-component",
    tier: "CORE",
    query: "Is a scheduler mandatory for processing jobs?",
    candidates: [
      {
        label: "wrong-optional-component",
        title: "Job operations",
        passage: "Jobs run on a scheduler with an optional audit collector.",
      },
    ],
    goldLabels: [],
  },
  {
    id: "insufficiency-for-other-subject",
    tier: "CORE",
    query: "Does a gateway prove that the architecture is secure?",
    candidates: [
      {
        label: "wrong-insufficient-subject",
        title: "Security notices",
        passage:
          "A gateway displays notices that a proxy alone is insufficient to establish security of the architecture.",
      },
    ],
    goldLabels: [],
  },
  {
    id: "shared-queue-across-responsibilities",
    tier: "SEMANTIC_FRONTIER",
    query: "Can ingestion and delivery share a queue?",
    candidates: [
      {
        label: "shared-queue",
        title: "Distinct processing responsibilities",
        passage:
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
    id: "optional-scheduler-in-spanish",
    tier: "SEMANTIC_FRONTIER",
    query: "¿Es obligatorio usar un scheduler para procesar trabajos?",
    candidates: [
      {
        label: "scheduler-optional",
        title: "Ejecución de trabajos",
        passage:
          "Los trabajos pueden procesarse directamente sin scheduler; incorporarlo es una opción operativa.",
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
    id: "component-does-not-prove-whole",
    tier: "SEMANTIC_FRONTIER",
    query: "Does middleware prove that an architecture is secure?",
    candidates: [
      {
        label: "insufficient-component",
        title: "Security assessment",
        passage:
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
  {
    id: "conditional-decision-table",
    tier: "SEMANTIC_FRONTIER",
    query: "When should partitioned dispatch be selected?",
    candidates: [
      {
        label: "dispatch-selection-matrix",
        title: "Partitioned dispatch selection",
        type: "rule",
        unitType: "TABLE",
        passage:
          "| Observed situation | Decision |\n|---|---|\n| Independent destinations with bursty traffic | Select partitioned dispatch |\n| One stable destination with small constant load | Use a single consumer |",
      },
      {
        label: "dispatch-metrics-table",
        title: "Partitioned dispatch selection",
        type: "rule",
        unitType: "TABLE",
        passage:
          "| Metric | Recorded value |\n|---|---|\n| Partitioned dispatch | Queue length |\n| Single consumer | Delivery count |",
      },
    ],
    goldLabels: ["dispatch-selection-matrix"],
  },
  {
    id: "bilingual-conditional-decision-table",
    tier: "SEMANTIC_FRONTIER",
    query: "When should batched delivery be selected?",
    candidates: [
      {
        label: "delivery-selection-matrix",
        title: "Batched delivery selection",
        type: "decision-rule",
        unitType: "TABLE",
        passage:
          "| Situación observada | Decisión |\n|---|---|\n| Varias entregas pequeñas al mismo destino | Seleccionar batched delivery |\n| Una entrega urgente independiente | Enviar directamente |",
      },
      {
        label: "delivery-metrics-table",
        title: "Batched delivery selection",
        type: "decision-rule",
        unitType: "TABLE",
        passage:
          "| Métrica | Valor registrado |\n|---|---|\n| Batched delivery | Número de entregas |\n| Envío directo | Duración observada |",
      },
    ],
    goldLabels: ["delivery-selection-matrix"],
  },
  {
    id: "requirement-wrong-predicate-or-component",
    tier: "CORE",
    query: "Is a checksum mandatory for record validation?",
    candidates: [
      {
        label: "reports-only",
        title: "Record validation",
        passage: "Record validation reports can be viewed without a checksum.",
      },
      {
        label: "simulation-only",
        title: "Record validation",
        passage: "Record validation can be simulated without a checksum.",
      },
      {
        label: "different-component",
        title: "Record validation",
        passage: "Record validation can continue without a checksummer.",
      },
    ],
    goldLabels: [],
  },
  {
    id: "table-decisions-are-open-questions",
    tier: "CORE",
    query: "When should manual reconciliation be selected?",
    candidates: [
      {
        label: "open-decision",
        title: "Reconciliation policy",
        type: "decision-rule",
        unitType: "TABLE",
        passage:
          "| Condition | Decision |\n|---|---|\n| Settlement mismatch | Should manual reconciliation be selected? |",
      },
      {
        label: "quoted-decision",
        title: "Reconciliation policy",
        type: "decision-rule",
        unitType: "TABLE",
        passage:
          '| Condition | Decision |\n|---|---|\n| Settlement mismatch | "Select manual reconciliation?" |',
      },
    ],
    goldLabels: [],
  },
  {
    id: "decision-count-is-not-a-decision",
    tier: "CORE",
    query: "When should manual reconciliation be selected?",
    candidates: [
      {
        label: "decision-count",
        title: "Reconciliation metrics",
        type: "rule",
        unitType: "TABLE",
        passage:
          "| Condition | Decision count |\n|---|---|\n| Settlement mismatch | Manual reconciliation: 12 |",
      },
    ],
    goldLabels: [],
  },
  {
    id: "ambiguous-table-column-roles",
    tier: "CORE",
    query: "When should isolated recovery be selected?",
    candidates: [
      {
        label: "ambiguous-decisions",
        title: "Recovery policy",
        type: "rule",
        unitType: "TABLE",
        passage:
          "| Condition | Decision | Decision |\n|---|---|---|\n| Checkpoint mismatch | Select isolated recovery | Reject isolated recovery |",
      },
    ],
    goldLabels: [],
  },
  {
    id: "quoted-question-with-unrelated-assertion",
    tier: "CORE",
    query: "Can ALFA call BETA?",
    candidates: [
      {
        label: "unresolved-question",
        title: "Open integration questions",
        passage: '"Can ALFA call BETA?" The deployment is still under review.',
      },
    ],
    goldLabels: [],
  },
  {
    id: "implicit-absence-requirement-proof",
    tier: "SEMANTIC_FRONTIER",
    query: "Is a checksum mandatory for record validation?",
    candidates: [
      {
        label: "absence-permits-validation",
        title: "Record validation",
        passage: "Record validation can continue without a checksum.",
      },
    ],
    goldLabels: ["absence-permits-validation"],
  },
  {
    id: "bilingual-implicit-absence-requirement-proof",
    tier: "SEMANTIC_FRONTIER",
    query: "¿Es obligatorio usar un coordinator para procesar trabajos?",
    candidates: [
      {
        label: "absence-permits-processing",
        title: "Ejecución de trabajos",
        passage:
          "Los trabajos pueden procesarse directamente sin coordinator; incorporarlo es una opción operativa.",
      },
    ],
    goldLabels: ["absence-permits-processing"],
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
    candidates: hits.map((candidate, index) => ({
      label: entry.candidates[index]!.label,
      unitType: candidate.unitType,
      passageSupport:
        result.candidateSignals.find(
          (signal) =>
            signal.candidateKey ===
            retrievalAnswerabilityCandidateKey(candidate),
        )?.passageSupport ?? null,
    })),
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
  schemaVersion: 2,
  status: corePasses ? "PROVEN" : "FAILED",
  evidenceBoundary:
    "Public synthetic deterministic evidence-admission benchmark. CORE is a CI gate; SEMANTIC_FRONTIER measures known paraphrase and structural-table limits without promoting a semantic verifier.",
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
