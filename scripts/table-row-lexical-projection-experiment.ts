import "dotenv/config";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Postgres } from "../packages/postgres/src/index.js";
import {
  parseKnowledgeUnits,
  projectTableRows,
} from "../packages/retrieval/src/index.js";

const execFile = promisify(execFileCallback);

type Split = "development" | "heldout";
type Arm = "raw-table-row-body" | "table-row-projection";
type Family =
  | "HEADER_VALUE"
  | "CAPTION_HEADER_VALUE"
  | "VALUE_ONLY_CONTROL"
  | "CROSS_ROW_NEGATIVE";

interface DocumentFixture {
  id: string;
  split: Split;
  title: string;
  source: string;
}

interface QuestionFixture {
  id: string;
  split: Split;
  family: Family;
  query: string;
  goldRowKey?: string;
}

interface RankedRow {
  rowKey: string;
  documentKey: string;
  score: number;
  fullRowMatch: boolean;
}

interface Observation {
  questionId: string;
  family: Family;
  query: string;
  goldRowKey?: string;
  rank: number | null;
  anyFullRowMatch: boolean;
  topRows: RankedRow[];
}

interface FamilySummary {
  questions: number;
  positiveQuestions: number;
  recallAt1: number | null;
  negativeQuestions: number;
  negativeFullRowMatchRate: number | null;
}

interface SplitSummary {
  split: Split;
  positiveQuestions: number;
  negativeQuestions: number;
  recallAt1: number | null;
  recallAt3: number | null;
  recallAt5: number | null;
  meanReciprocalRank: number | null;
  negativeFullRowMatchRate: number | null;
  byFamily: Record<Family, FamilySummary>;
  observations: Observation[];
}

const DOCUMENTS: DocumentFixture[] = [
  {
    id: "dev-operations",
    split: "development",
    title: "Operations handbook",
    source: [
      "# On-call operations",
      "<!-- akp-locator: page=2; table=4 -->",
      "Escalation roster",
      "",
      "<!-- akp-locator: page=2; table=4 -->",
      "| Region | Owner | Window |",
      "| --- | --- | --- |",
      "| Lima | Camila Torres | Dawn |",
      "| Quito | Mateo Ruiz | Morning |",
      "| Bogota | Irene Soto | Evening |",
    ].join("\n"),
  },
  {
    id: "dev-compliance",
    split: "development",
    title: "Records policy",
    source: [
      "# Retention assignments",
      "| Region | Custodian | Retention |",
      "| --- | --- | --- |",
      "| Arequipa | Jose Perez | SevenYears |",
      "| Cusco | Lucia Ramos | FiveYears |",
      "| Piura | Diego Salas | ThreeYears |",
    ].join("\n"),
  },
  {
    id: "dev-inventory",
    split: "development",
    title: "Warehouse controls",
    source: [
      "# Reorder matrix",
      "| SKU | Warehouse | Reorder |",
      "| --- | --- | --- |",
      "| Atlas42 | North | Eighteen |",
      "| Beacon09 | South | ThirtyOne |",
      "| Comet17 | East | TwentyFour |",
    ].join("\n"),
  },
  {
    id: "dev-reliability",
    split: "development",
    title: "Reliability report",
    source: [
      "# Service classes",
      "<!-- akp-locator: page=7; table=9 -->",
      "Quarterly accuracy matrix",
      "",
      "<!-- akp-locator: page=7; table=9 -->",
      "| Class | Quarter | Accuracy |",
      "| --- | --- | --- |",
      "| Bronze | Q1 | NinetyOne |",
      "| Silver | Q2 | NinetySeven |",
      "| Gold | Q3 | NinetyNine |",
    ].join("\n"),
  },
  {
    id: "hold-finance",
    split: "heldout",
    title: "Treasury limits",
    source: [
      "# Desk limits",
      "| Desk | Currency | Limit |",
      "| --- | --- | --- |",
      "| Delta | PEN | QuarterMillion |",
      "| Sigma | USD | HalfMillion |",
      "| Omega | EUR | OneMillion |",
    ].join("\n"),
  },
  {
    id: "hold-healthcare",
    split: "heldout",
    title: "Clinic directory",
    source: [
      "# Support coverage",
      "<!-- akp-locator: page=5; table=6 -->",
      "Clinic response roster",
      "",
      "<!-- akp-locator: page=5; table=6 -->",
      "| Clinic | Contact | SLA |",
      "| --- | --- | --- |",
      "| Surco | Elena Cruz | FourHours |",
      "| Miraflores | Bruno Leon | TwoHours |",
      "| Barranco | Rosa Diaz | SixHours |",
    ].join("\n"),
  },
  {
    id: "hold-travel",
    split: "heldout",
    title: "Route operations",
    source: [
      "# Boarding assignments",
      "| Route | Gate | Boarding |",
      "| --- | --- | --- |",
      "| LimaCusco | GateC | Morning |",
      "| LimaPiura | GateD | Afternoon |",
      "| LimaTacna | GateE | Evening |",
    ].join("\n"),
  },
  {
    id: "hold-people",
    split: "heldout",
    title: "Team capacity",
    source: [
      "# Staffing matrix",
      "| Team | Lead | Capacity |",
      "| --- | --- | --- |",
      "| Platform | Sofia Vega | Twelve |",
      "| Mobile | Andres Luna | Eight |",
      "| Data | Carla Mena | Ten |",
    ].join("\n"),
  },
];

function rowKey(documentId: string, table: number, row: number): string {
  return documentId + ":table:" + table + ":row:" + row;
}

const QUESTIONS: QuestionFixture[] = [
  {
    id: "dev-header-owner",
    split: "development",
    family: "HEADER_VALUE",
    query: "Region Lima Owner Camila Torres Window Dawn",
    goldRowKey: rowKey("dev-operations", 4, 1),
  },
  {
    id: "dev-caption-owner",
    split: "development",
    family: "CAPTION_HEADER_VALUE",
    query: "Escalation roster Region Quito Owner Mateo Ruiz",
    goldRowKey: rowKey("dev-operations", 4, 2),
  },
  {
    id: "dev-header-retention",
    split: "development",
    family: "HEADER_VALUE",
    query: "Region Cusco Custodian Lucia Ramos Retention FiveYears",
    goldRowKey: rowKey("dev-compliance", 1, 2),
  },
  {
    id: "dev-header-reorder",
    split: "development",
    family: "HEADER_VALUE",
    query: "SKU Beacon09 Warehouse South Reorder ThirtyOne",
    goldRowKey: rowKey("dev-inventory", 1, 2),
  },
  {
    id: "dev-caption-accuracy",
    split: "development",
    family: "CAPTION_HEADER_VALUE",
    query:
      "Quarterly accuracy matrix Class Silver Quarter Q2 Accuracy NinetySeven",
    goldRowKey: rowKey("dev-reliability", 9, 2),
  },
  {
    id: "dev-control-values",
    split: "development",
    family: "VALUE_ONLY_CONTROL",
    query: "Atlas42 North Eighteen",
    goldRowKey: rowKey("dev-inventory", 1, 1),
  },
  {
    id: "dev-control-values-two",
    split: "development",
    family: "VALUE_ONLY_CONTROL",
    query: "Bronze Q1 NinetyOne",
    goldRowKey: rowKey("dev-reliability", 9, 1),
  },
  {
    id: "dev-negative-cross-row",
    split: "development",
    family: "CROSS_ROW_NEGATIVE",
    query: "Region Lima Owner Mateo Ruiz",
  },
  {
    id: "dev-negative-cross-row-two",
    split: "development",
    family: "CROSS_ROW_NEGATIVE",
    query: "Class Gold Quarter Q2 Accuracy NinetyNine",
  },
  {
    id: "hold-header-finance",
    split: "heldout",
    family: "HEADER_VALUE",
    query: "Desk Sigma Currency USD Limit HalfMillion",
    goldRowKey: rowKey("hold-finance", 1, 2),
  },
  {
    id: "hold-caption-clinic",
    split: "heldout",
    family: "CAPTION_HEADER_VALUE",
    query:
      "Clinic response roster Clinic Surco Contact Elena Cruz SLA FourHours",
    goldRowKey: rowKey("hold-healthcare", 6, 1),
  },
  {
    id: "hold-header-route",
    split: "heldout",
    family: "HEADER_VALUE",
    query: "Route LimaPiura Gate GateD Boarding Afternoon",
    goldRowKey: rowKey("hold-travel", 1, 2),
  },
  {
    id: "hold-header-capacity",
    split: "heldout",
    family: "HEADER_VALUE",
    query: "Team Platform Lead Sofia Vega Capacity Twelve",
    goldRowKey: rowKey("hold-people", 1, 1),
  },
  {
    id: "hold-caption-clinic-two",
    split: "heldout",
    family: "CAPTION_HEADER_VALUE",
    query: "Clinic response roster Clinic Miraflores Contact Bruno Leon",
    goldRowKey: rowKey("hold-healthcare", 6, 2),
  },
  {
    id: "hold-control-values",
    split: "heldout",
    family: "VALUE_ONLY_CONTROL",
    query: "Delta PEN QuarterMillion",
    goldRowKey: rowKey("hold-finance", 1, 1),
  },
  {
    id: "hold-control-values-two",
    split: "heldout",
    family: "VALUE_ONLY_CONTROL",
    query: "Data Carla Mena Ten",
    goldRowKey: rowKey("hold-people", 1, 3),
  },
  {
    id: "hold-negative-cross-row",
    split: "heldout",
    family: "CROSS_ROW_NEGATIVE",
    query: "Desk Delta Currency USD Limit QuarterMillion",
  },
  {
    id: "hold-negative-cross-row-two",
    split: "heldout",
    family: "CROSS_ROW_NEGATIVE",
    query: "Team Mobile Lead Sofia Vega Capacity Eight",
  },
];

const FAMILIES: Family[] = [
  "HEADER_VALUE",
  "CAPTION_HEADER_VALUE",
  "VALUE_ONLY_CONTROL",
  "CROSS_ROW_NEGATIVE",
];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function gitHead(): Promise<string> {
  const result = await execFile("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
  });
  const value = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error("Unable to resolve Git HEAD");
  }
  return value;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function recall(ranks: readonly number[], k: number): number | null {
  if (ranks.length === 0) return null;
  return ranks.filter((rank) => rank > 0 && rank <= k).length / ranks.length;
}

function familySummary(
  observations: readonly Observation[],
  family: Family,
): FamilySummary {
  const selected = observations.filter((entry) => entry.family === family);
  const positives = selected.filter((entry) => entry.goldRowKey);
  const negatives = selected.filter((entry) => !entry.goldRowKey);
  const ranks = positives.map((entry) => entry.rank ?? 0);
  return {
    questions: selected.length,
    positiveQuestions: positives.length,
    recallAt1: recall(ranks, 1),
    negativeQuestions: negatives.length,
    negativeFullRowMatchRate:
      negatives.length === 0
        ? null
        : negatives.filter((entry) => entry.anyFullRowMatch).length /
          negatives.length,
  };
}

function summarize(split: Split, observations: Observation[]): SplitSummary {
  const questionIds = new Set(
    QUESTIONS.filter((question) => question.split === split).map(
      (question) => question.id,
    ),
  );
  const selected = observations.filter((entry) =>
    questionIds.has(entry.questionId),
  );
  const positives = selected.filter((entry) => entry.goldRowKey);
  const negatives = selected.filter((entry) => !entry.goldRowKey);
  const ranks = positives.map((entry) => entry.rank ?? 0);
  return {
    split,
    positiveQuestions: positives.length,
    negativeQuestions: negatives.length,
    recallAt1: recall(ranks, 1),
    recallAt3: recall(ranks, 3),
    recallAt5: recall(ranks, 5),
    meanReciprocalRank: mean(ranks.map((rank) => (rank > 0 ? 1 / rank : 0))),
    negativeFullRowMatchRate:
      negatives.length === 0
        ? null
        : negatives.filter((entry) => entry.anyFullRowMatch).length /
          negatives.length,
    byFamily: Object.fromEntries(
      FAMILIES.map((family) => [family, familySummary(selected, family)]),
    ) as Record<Family, FamilySummary>,
    observations: selected,
  };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const db = new Postgres(databaseUrl);
  try {
    await db.pool.query(
      [
        "create temporary table akp_table_row_document_eval (",
        "document_key text primary key,",
        "split text not null,",
        "title_vector tsvector not null,",
        "body_vector tsvector not null,",
        "search_vector tsvector not null",
        ") on commit preserve rows",
      ].join("\n"),
    );

    await db.pool.query(
      [
        "create temporary table akp_table_row_projection_eval (",
        "row_key text not null,",
        "document_key text not null,",
        "split text not null,",
        "arm text not null,",
        "structural_order integer not null,",
        "heading_vector tsvector not null,",
        "unit_vector tsvector not null,",
        "body_vector tsvector not null,",
        "search_vector tsvector not null,",
        "primary key(row_key, arm)",
        ") on commit preserve rows",
      ].join("\n"),
    );

    for (const document of DOCUMENTS) {
      await db.pool.query(
        [
          "insert into akp_table_row_document_eval(",
          "document_key,split,title_vector,body_vector,search_vector",
          ")",
          "select $1,$2,",
          "to_tsvector('simple', $3),",
          "to_tsvector('simple', $4),",
          "setweight(to_tsvector('simple', $3), 'B') ||",
          "setweight(to_tsvector('simple', $4), 'D')",
        ].join("\n"),
        [document.id, document.split, document.title, document.source],
      );
    }

    const materializedRows: Array<{
      rowKey: string;
      documentKey: string;
      split: Split;
      unitKey: string;
      structuralOrder: number;
      headingText: string;
      rawBody: string;
      projectedBody: string;
    }> = [];

    for (const document of DOCUMENTS) {
      const units = parseKnowledgeUnits(document.title, document.source);
      const projections = projectTableRows(document.title, document.source);
      for (const projection of projections) {
        const unit = units.find(
          (candidate) =>
            candidate.unitType === "TABLE_ROW" &&
            candidate.locator.table === projection.tableIndex &&
            candidate.locator.row === projection.rowIndex,
        );
        if (!unit) {
          throw new Error(
            "Missing TABLE_ROW unit for " +
              document.id +
              " table " +
              projection.tableIndex +
              " row " +
              projection.rowIndex,
          );
        }
        materializedRows.push({
          rowKey: rowKey(
            document.id,
            projection.tableIndex,
            projection.rowIndex,
          ),
          documentKey: document.id,
          split: document.split,
          unitKey: unit.unitKey,
          structuralOrder: unit.structuralOrder,
          headingText: unit.headingPath.join(" "),
          rawBody: unit.body,
          projectedBody: projection.lexicalText,
        });
      }
    }

    for (const row of materializedRows) {
      for (const arm of [
        "raw-table-row-body",
        "table-row-projection",
      ] as const) {
        const body =
          arm === "raw-table-row-body" ? row.rawBody : row.projectedBody;
        await db.pool.query(
          [
            "insert into akp_table_row_projection_eval(",
            "row_key,document_key,split,arm,structural_order,",
            "heading_vector,unit_vector,body_vector,search_vector",
            ")",
            "select",
            "$1,$2,$3,$4,$5,",
            "to_tsvector('simple', $6),",
            "to_tsvector('simple', $7),",
            "to_tsvector('simple', $8),",
            "setweight(to_tsvector('simple', $6), 'A') ||",
            "setweight(to_tsvector('simple', $7), 'B') ||",
            "setweight(to_tsvector('simple', $8), 'C')",
          ].join("\n"),
          [
            row.rowKey,
            row.documentKey,
            row.split,
            arm,
            row.structuralOrder,
            row.headingText,
            row.unitKey + " TABLE_ROW",
            body,
          ],
        );
      }
    }

    const observationsByArm = new Map<Arm, Observation[]>();
    for (const arm of ["raw-table-row-body", "table-row-projection"] as const) {
      const observations: Observation[] = [];
      for (const question of QUESTIONS) {
        const ranked = await db.pool.query<{
          row_key: string;
          document_key: string;
          score: number;
          full_row_match: boolean;
        }>(
          [
            "with query as (",
            "select plainto_tsquery('simple', $2) terms",
            "), eligible_documents as (",
            "select d.document_key,d.title_vector,d.body_vector,d.search_vector,",
            "q.terms",
            "from akp_table_row_document_eval d",
            "cross join query q",
            "where d.search_vector @@ q.terms",
            "or exists (",
            "select 1",
            "from akp_table_row_projection_eval matching_row",
            "where matching_row.document_key=d.document_key",
            "and matching_row.arm=$1",
            "and matching_row.search_vector @@ q.terms",
            ")",
            "), scored as (",
            "select d.document_key,best_row.row_key,",
            "20 * ts_rank_cd(d.title_vector,d.terms) +",
            "2 * ts_rank_cd(d.body_vector,d.terms) +",
            "coalesce(best_row.unit_score,0) score,",
            "coalesce(best_row.full_row_match,false) full_row_match",
            "from eligible_documents d",
            "left join lateral (",
            "select e.row_key,e.structural_order,",
            "12 * ts_rank_cd(e.heading_vector,d.terms) +",
            "8 * ts_rank_cd(e.unit_vector,d.terms) +",
            "ts_rank_cd(e.body_vector,d.terms) unit_score,",
            "e.search_vector @@ d.terms full_row_match",
            "from akp_table_row_projection_eval e",
            "where e.document_key=d.document_key",
            "and e.arm=$1",
            "order by unit_score desc,e.structural_order,e.row_key",
            "limit 1",
            ") best_row on true",
            ")",
            "select row_key,document_key,score,full_row_match",
            "from scored",
            "where row_key is not null",
            "order by score desc,document_key,row_key",
          ].join("\n"),
          [arm, question.query],
        );
        const topRows = ranked.rows.slice(0, 5).map((entry) => ({
          rowKey: entry.row_key,
          documentKey: entry.document_key,
          score: Number(entry.score),
          fullRowMatch: entry.full_row_match,
        }));
        const foundIndex = question.goldRowKey
          ? ranked.rows.findIndex(
              (entry) => entry.row_key === question.goldRowKey,
            )
          : -1;
        observations.push({
          questionId: question.id,
          family: question.family,
          query: question.query,
          ...(question.goldRowKey ? { goldRowKey: question.goldRowKey } : {}),
          rank: foundIndex >= 0 ? foundIndex + 1 : null,
          anyFullRowMatch: ranked.rows.some((entry) => entry.full_row_match),
          topRows,
        });
      }
      observationsByArm.set(arm, observations);
    }

    const summaries = Object.fromEntries(
      [...observationsByArm.entries()].map(([arm, observations]) => [
        arm,
        {
          development: summarize("development", observations),
          heldout: summarize("heldout", observations),
        },
      ]),
    ) as Record<Arm, { development: SplitSummary; heldout: SplitSummary }>;

    const baseline = summaries["raw-table-row-body"];
    const candidate = summaries["table-row-projection"];
    const familyRecall = (
      summary: SplitSummary,
      family: "HEADER_VALUE" | "CAPTION_HEADER_VALUE",
    ) => summary.byFamily[family].recallAt1 ?? 0;
    const controlRecall = (summary: SplitSummary) =>
      summary.byFamily.VALUE_ONLY_CONTROL.recallAt1 ?? 0;
    const negativeRate = (summary: SplitSummary) =>
      summary.negativeFullRowMatchRate ?? 0;

    const gates = {
      developmentHeaderImproves:
        familyRecall(candidate.development, "HEADER_VALUE") >
        familyRecall(baseline.development, "HEADER_VALUE"),
      developmentCaptionImproves:
        familyRecall(candidate.development, "CAPTION_HEADER_VALUE") >
        familyRecall(baseline.development, "CAPTION_HEADER_VALUE"),
      heldoutHeaderImproves:
        familyRecall(candidate.heldout, "HEADER_VALUE") >
        familyRecall(baseline.heldout, "HEADER_VALUE"),
      heldoutCaptionImproves:
        familyRecall(candidate.heldout, "CAPTION_HEADER_VALUE") >
        familyRecall(baseline.heldout, "CAPTION_HEADER_VALUE"),
      developmentControlsNoRegression:
        controlRecall(candidate.development) >=
        controlRecall(baseline.development),
      heldoutControlsNoRegression:
        controlRecall(candidate.heldout) >= controlRecall(baseline.heldout),
      developmentNegativesNoRegression:
        negativeRate(candidate.development) <=
        negativeRate(baseline.development),
      heldoutNegativesNoRegression:
        negativeRate(candidate.heldout) <= negativeRate(baseline.heldout),
      heldoutMrrNoRegression:
        (candidate.heldout.meanReciprocalRank ?? 0) >=
        (baseline.heldout.meanReciprocalRank ?? 0),
    };
    const outcome = Object.values(gates).every(Boolean) ? "PROMOTE" : "REJECT";

    const candidateSha = await gitHead();
    const baselineSha =
      process.env.AKP_TABLE_ROW_PROJECTION_BASELINE_SHA?.trim() || candidateSha;
    const corpusHash = sha256(
      JSON.stringify({ documents: DOCUMENTS, questions: QUESTIONS }),
    );
    const report = {
      schemaVersion: "akp.table-row-lexical-projection.v1",
      generatedAt: new Date().toISOString(),
      outcome,
      promotionScope: "retrieval-representation-experiment-only",
      productionDefaultsChanged: false,
      activationEnabled: false,
      independentVariable: "TABLE_ROW body representation",
      baseline: "canonical TABLE_ROW body",
      candidate: "TableRowProjection.lexicalText",
      runtimeParity: {
        queryParser: "plainto_tsquery('simple')",
        score:
          "12*ts_rank_cd(heading)+8*ts_rank_cd(unit-metadata)+ts_rank_cd(body)",
        eligibility:
          "document lexical search match OR full unit lexical search match",
        documentScore:
          "20*ts_rank_cd(title)+2*ts_rank_cd(body)+best-unit-score",
        bestUnitPerDocument:
          "lateral best unit by 12*heading+8*unit-metadata+body without requiring full unit match",
      },
      experiment: {
        baselineSha,
        candidateSha,
        corpusHash,
        corpusDocuments: DOCUMENTS.length,
        corpusRows: materializedRows.length,
        questions: QUESTIONS.length,
        splitProtocol:
          "FIXED_DOMAIN_SOURCE_DISJOINT_NO_TUNING_NOT_QUESTION_FAMILY_DISJOINT",
      },
      gates,
      arms: summaries,
      measured: [
        "row-level lexical Recall@1/3/5",
        "mean reciprocal rank",
        "header-value retrieval",
        "explicit-caption plus header-value retrieval",
        "value-only control retrieval",
        "cross-row negative full-row-match rate",
      ],
      notMeasured: [
        "document exact channel and non-table units",
        "query transformations and assertion recall",
        "vector retrieval",
        "fusion and reranking",
        "evidence admission",
        "citation precision",
        "private-vault retrieval",
        "production activation",
      ],
      limitation:
        "This is a controlled lexical representation probe over parser-derived Markdown table rows. It reproduces document lexical eligibility and best-row scoring for the signals represented by the fixture, but it does not include non-table units, exact/symbol channels, transformed queries, fusion, evidence admission or end-to-end R5/R6/R7/R9 closure.",
    };

    const output = path.resolve(
      process.env.AKP_TABLE_ROW_PROJECTION_REPORT ??
        ".work/table-row-lexical-projection/report.json",
    );
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n", "utf8");
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    (error instanceof Error ? (error.stack ?? error.message) : String(error)) +
      "\n",
  );
  process.exitCode = 1;
});
