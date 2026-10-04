import "dotenv/config";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Postgres } from "../packages/postgres/src/index.js";
import {
  parseKnowledgeUnits,
  projectTableRows,
} from "../packages/retrieval/src/index.js";

const execFile = promisify(execFileCallback);

type Split = "development" | "heldout";
type Arm = "raw-row" | "explicit-caption-context";
type Family =
  | "CAPTION_DISAMBIGUATION"
  | "HEADER_VALUE_CONTROL"
  | "VALUE_ONLY_CONTROL"
  | "NON_CAPTION_NEGATIVE"
  | "CROSS_ROW_NEGATIVE"
  | "CROSS_DOCUMENT_NEGATIVE";

interface DocumentFixture {
  id: string;
  split: Split;
  title: string;
  source: string;
  expectedCaptionedTables: number[];
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
  recallAt3: number | null;
  negativeQuestions: number;
  falseFullRowMatchRate: number | null;
}

interface SplitSummary {
  split: Split;
  positiveQuestions: number;
  negativeQuestions: number;
  recallAt1: number | null;
  recallAt3: number | null;
  meanReciprocalRank: number | null;
  falseFullRowMatchRate: number | null;
  byFamily: Record<Family, FamilySummary>;
  observations: Observation[];
}

const DOCUMENTS: DocumentFixture[] = [
  {
    id: "dev-deploy",
    split: "development",
    title: "Deployment schedules",
    expectedCaptionedTables: [11, 12],
    source: [
      "# Deployment schedules",
      "<!-- akp-locator: page=2; table=11 -->",
      "Primary deployment roster",
      "",
      "<!-- akp-locator: page=2; table=11 -->",
      "| Service | Lead | Window |",
      "| --- | --- | --- |",
      "| Search | Nora Lane | Monday |",
      "| Billing | Omar Reed | Tuesday |",
      "",
      "<!-- akp-locator: page=2; table=12 -->",
      "Secondary deployment roster",
      "",
      "<!-- akp-locator: page=2; table=12 -->",
      "| Service | Lead | Window |",
      "| --- | --- | --- |",
      "| Search | Nora Lane | Monday |",
      "| Billing | Omar Reed | Tuesday |",
    ].join("\n"),
  },
  {
    id: "dev-access",
    split: "development",
    title: "Access review rosters",
    expectedCaptionedTables: [21, 22],
    source: [
      "# Access reviews",
      "<!-- akp-locator: page=4; table=21 -->",
      "Privileged access roster",
      "",
      "<!-- akp-locator: page=4; table=21 -->",
      "| System | Owner | Review |",
      "| --- | --- | --- |",
      "| Vault | Maya Frost | Monthly |",
      "| Gateway | Leo Hart | Quarterly |",
      "",
      "<!-- akp-locator: page=4; table=22 -->",
      "Standard access roster",
      "",
      "<!-- akp-locator: page=4; table=22 -->",
      "| System | Owner | Review |",
      "| --- | --- | --- |",
      "| Vault | Maya Frost | Monthly |",
      "| Gateway | Leo Hart | Quarterly |",
    ].join("\n"),
  },
  {
    id: "dev-assets",
    split: "development",
    title: "Custody registers",
    expectedCaptionedTables: [31, 32],
    source: [
      "# Custody registers",
      "<!-- akp-locator: sheet=2; table=31 -->",
      "Active custody ledger",
      "",
      "<!-- akp-locator: sheet=2; table=31 -->",
      "| Asset | Custodian | Site |",
      "| --- | --- | --- |",
      "| SensorK | Ivan Cole | DockOne |",
      "| RelayM | Tessa Ford | DockTwo |",
      "",
      "<!-- akp-locator: sheet=2; table=32 -->",
      "Reserve custody ledger",
      "",
      "<!-- akp-locator: sheet=2; table=32 -->",
      "| Asset | Custodian | Site |",
      "| --- | --- | --- |",
      "| SensorK | Ivan Cole | DockOne |",
      "| RelayM | Tessa Ford | DockTwo |",
    ].join("\n"),
  },
  {
    id: "dev-controls",
    split: "development",
    title: "Warehouse controls",
    expectedCaptionedTables: [],
    source: [
      "# Reorder matrix",
      "| SKU | Warehouse | Reorder |",
      "| --- | --- | --- |",
      "| Atlas42 | North | Eighteen |",
      "| Beacon09 | South | ThirtyOne |",
    ].join("\n"),
  },
  {
    id: "dev-nearby",
    split: "development",
    title: "Dispatch reference",
    expectedCaptionedTables: [],
    source: [
      "# Dispatch",
      "Historical dispatch roster",
      "",
      "| Route | Dispatcher | Slot |",
      "| --- | --- | --- |",
      "| RouteA | Liam Stone | Sunrise |",
      "| RouteB | Eva Marsh | Midday |",
    ].join("\n"),
  },
  {
    id: "dev-mismatch",
    split: "development",
    title: "Allocation reference",
    expectedCaptionedTables: [],
    source: [
      "# Allocation",
      "<!-- akp-locator: page=6; table=99 -->",
      "Legacy allocation matrix",
      "",
      "<!-- akp-locator: page=6; table=1 -->",
      "| Component | Owner | Budget |",
      "| --- | --- | --- |",
      "| Gateway | Nina Sharp | BudgetA |",
      "| Broker | Paul Reed | BudgetB |",
    ].join("\n"),
  },
  {
    id: "hold-transit",
    split: "heldout",
    title: "Operación de rutas",
    expectedCaptionedTables: [41, 42],
    source: [
      "# Operación de rutas",
      "<!-- akp-locator: page=3; table=41 -->",
      "Turnos de ruta principal",
      "",
      "<!-- akp-locator: page=3; table=41 -->",
      "| Ruta | Operador | Horario |",
      "| --- | --- | --- |",
      "| Andina | Ana Ruiz | Mañana |",
      "| Costera | Luis Peña | Tarde |",
      "",
      "<!-- akp-locator: page=3; table=42 -->",
      "Turnos de ruta alterna",
      "",
      "<!-- akp-locator: page=3; table=42 -->",
      "| Ruta | Operador | Horario |",
      "| --- | --- | --- |",
      "| Andina | Ana Ruiz | Mañana |",
      "| Costera | Luis Peña | Tarde |",
    ].join("\n"),
  },
  {
    id: "hold-energy",
    split: "heldout",
    title: "Grid assignments",
    expectedCaptionedTables: [51, 52],
    source: [
      "# Grid assignments",
      "<!-- akp-locator: page=8; table=51 -->",
      "Day grid assignment",
      "",
      "<!-- akp-locator: page=8; table=51 -->",
      "| Station | Engineer | Window |",
      "| --- | --- | --- |",
      "| SubstationA | Claire Moss | Dawn |",
      "| SubstationB | Mark Vale | Evening |",
      "",
      "<!-- akp-locator: page=8; table=52 -->",
      "Night grid assignment",
      "",
      "<!-- akp-locator: page=8; table=52 -->",
      "| Station | Engineer | Window |",
      "| --- | --- | --- |",
      "| SubstationA | Claire Moss | Dawn |",
      "| SubstationB | Mark Vale | Evening |",
    ].join("\n"),
  },
  {
    id: "hold-clinic",
    split: "heldout",
    title: "Directorio clínico",
    expectedCaptionedTables: [61, 62],
    source: [
      "# Directorio clínico",
      "<!-- akp-locator: page=5; table=61 -->",
      "Directorio de guardia primaria",
      "",
      "<!-- akp-locator: page=5; table=61 -->",
      "| Centro | Contacto | Turno |",
      "| --- | --- | --- |",
      "| Surco | Rosa Díaz | Temprano |",
      "| Lince | Bruno León | Noche |",
      "",
      "<!-- akp-locator: page=5; table=62 -->",
      "Directorio de guardia secundaria",
      "",
      "<!-- akp-locator: page=5; table=62 -->",
      "| Centro | Contacto | Turno |",
      "| --- | --- | --- |",
      "| Surco | Rosa Díaz | Temprano |",
      "| Lince | Bruno León | Noche |",
    ].join("\n"),
  },
  {
    id: "hold-insurance",
    split: "heldout",
    title: "Claims queues",
    expectedCaptionedTables: [71, 72],
    source: [
      "# Claims queues",
      "<!-- akp-locator: sheet=4; table=71 -->",
      "Primary claims queue",
      "",
      "<!-- akp-locator: sheet=4; table=71 -->",
      "| Line | Analyst | Cycle |",
      "| --- | --- | --- |",
      "| Home | Alice North | WeekOne |",
      "| Auto | Ben Lake | WeekTwo |",
      "",
      "<!-- akp-locator: sheet=4; table=72 -->",
      "Secondary claims queue",
      "",
      "<!-- akp-locator: sheet=4; table=72 -->",
      "| Line | Analyst | Cycle |",
      "| --- | --- | --- |",
      "| Home | Alice North | WeekOne |",
      "| Auto | Ben Lake | WeekTwo |",
    ].join("\n"),
  },
  {
    id: "hold-controls",
    split: "heldout",
    title: "Inventario regional",
    expectedCaptionedTables: [],
    source: [
      "# Inventario",
      "| Producto | Almacén | Lote |",
      "| --- | --- | --- |",
      "| Cobre | Norte | LoteRojo |",
      "| Estaño | Sur | LoteVerde |",
    ].join("\n"),
  },
  {
    id: "hold-nearby",
    split: "heldout",
    title: "Team capacity",
    expectedCaptionedTables: [],
    source: [
      "# Capacity",
      "Historic priority matrix",
      "",
      "| Team | Lead | Capacity |",
      "| --- | --- | --- |",
      "| Platform | Sofia Vega | Twelve |",
      "| Data | Carla Mena | Ten |",
    ].join("\n"),
  },
  {
    id: "hold-mismatch",
    split: "heldout",
    title: "Port status",
    expectedCaptionedTables: [],
    source: [
      "# Port status",
      "<!-- akp-locator: page=9; table=88 -->",
      "Archived port register",
      "",
      "<!-- akp-locator: page=9; table=1 -->",
      "| Port | Operator | State |",
      "| --- | --- | --- |",
      "| Callao | OperatorOne | Active |",
      "| Paita | OperatorTwo | Waiting |",
    ].join("\n"),
  },
];

function rowKey(documentId: string, tableIndex: number, rowIndex: number): string {
  return documentId + ":table:" + tableIndex + ":row:" + rowIndex;
}

const QUESTIONS: QuestionFixture[] = [
  {
    id: "dev-cap-deploy-primary",
    split: "development",
    family: "CAPTION_DISAMBIGUATION",
    query: "Primary deployment roster Service Search Lead Nora Lane Window Monday",
    goldRowKey: rowKey("dev-deploy", 11, 1),
  },
  {
    id: "dev-cap-deploy-secondary",
    split: "development",
    family: "CAPTION_DISAMBIGUATION",
    query: "Secondary deployment roster Service Search Lead Nora Lane Window Monday",
    goldRowKey: rowKey("dev-deploy", 12, 1),
  },
  {
    id: "dev-cap-access-privileged",
    split: "development",
    family: "CAPTION_DISAMBIGUATION",
    query: "Privileged access roster System Vault Owner Maya Frost Review Monthly",
    goldRowKey: rowKey("dev-access", 21, 1),
  },
  {
    id: "dev-cap-access-standard",
    split: "development",
    family: "CAPTION_DISAMBIGUATION",
    query: "Standard access roster System Vault Owner Maya Frost Review Monthly",
    goldRowKey: rowKey("dev-access", 22, 1),
  },
  {
    id: "dev-cap-assets-active",
    split: "development",
    family: "CAPTION_DISAMBIGUATION",
    query: "Active custody ledger Asset SensorK Custodian Ivan Cole Site DockOne",
    goldRowKey: rowKey("dev-assets", 31, 1),
  },
  {
    id: "dev-cap-assets-reserve",
    split: "development",
    family: "CAPTION_DISAMBIGUATION",
    query: "Reserve custody ledger Asset SensorK Custodian Ivan Cole Site DockOne",
    goldRowKey: rowKey("dev-assets", 32, 1),
  },
  {
    id: "dev-header-control",
    split: "development",
    family: "HEADER_VALUE_CONTROL",
    query: "SKU Beacon09 Warehouse South Reorder ThirtyOne",
    goldRowKey: rowKey("dev-controls", 1, 2),
  },
  {
    id: "dev-header-nearby",
    split: "development",
    family: "HEADER_VALUE_CONTROL",
    query: "Route RouteB Dispatcher Eva Marsh Slot Midday",
    goldRowKey: rowKey("dev-nearby", 1, 2),
  },
  {
    id: "dev-value-control",
    split: "development",
    family: "VALUE_ONLY_CONTROL",
    query: "Atlas42 North Eighteen",
    goldRowKey: rowKey("dev-controls", 1, 1),
  },
  {
    id: "dev-value-mismatch",
    split: "development",
    family: "VALUE_ONLY_CONTROL",
    query: "Broker Paul Reed BudgetB",
    goldRowKey: rowKey("dev-mismatch", 1, 2),
  },
  {
    id: "dev-neg-nearby",
    split: "development",
    family: "NON_CAPTION_NEGATIVE",
    query: "Historical dispatch roster Route RouteA Dispatcher Liam Stone",
  },
  {
    id: "dev-neg-mismatch",
    split: "development",
    family: "NON_CAPTION_NEGATIVE",
    query: "Legacy allocation matrix Component Gateway Owner Nina Sharp",
  },
  {
    id: "dev-neg-cross-row",
    split: "development",
    family: "CROSS_ROW_NEGATIVE",
    query: "Primary deployment roster Service Search Lead Omar Reed",
  },
  {
    id: "dev-neg-cross-document",
    split: "development",
    family: "CROSS_DOCUMENT_NEGATIVE",
    query: "Active custody ledger SKU Atlas42 Warehouse North",
  },
  {
    id: "hold-cap-transit-primary",
    split: "heldout",
    family: "CAPTION_DISAMBIGUATION",
    query: "Turnos de ruta principal Ruta Andina Operador Ana Ruiz Horario Mañana",
    goldRowKey: rowKey("hold-transit", 41, 1),
  },
  {
    id: "hold-cap-transit-secondary",
    split: "heldout",
    family: "CAPTION_DISAMBIGUATION",
    query: "Turnos de ruta alterna Ruta Andina Operador Ana Ruiz Horario Mañana",
    goldRowKey: rowKey("hold-transit", 42, 1),
  },
  {
    id: "hold-cap-energy-day",
    split: "heldout",
    family: "CAPTION_DISAMBIGUATION",
    query: "Day grid assignment Station SubstationA Engineer Claire Moss Window Dawn",
    goldRowKey: rowKey("hold-energy", 51, 1),
  },
  {
    id: "hold-cap-energy-night",
    split: "heldout",
    family: "CAPTION_DISAMBIGUATION",
    query: "Night grid assignment Station SubstationA Engineer Claire Moss Window Dawn",
    goldRowKey: rowKey("hold-energy", 52, 1),
  },
  {
    id: "hold-cap-clinic-primary",
    split: "heldout",
    family: "CAPTION_DISAMBIGUATION",
    query: "Directorio de guardia primaria Centro Surco Contacto Rosa Díaz Turno Temprano",
    goldRowKey: rowKey("hold-clinic", 61, 1),
  },
  {
    id: "hold-cap-clinic-secondary",
    split: "heldout",
    family: "CAPTION_DISAMBIGUATION",
    query: "Directorio de guardia secundaria Centro Surco Contacto Rosa Díaz Turno Temprano",
    goldRowKey: rowKey("hold-clinic", 62, 1),
  },
  {
    id: "hold-cap-insurance-primary",
    split: "heldout",
    family: "CAPTION_DISAMBIGUATION",
    query: "Primary claims queue Line Home Analyst Alice North Cycle WeekOne",
    goldRowKey: rowKey("hold-insurance", 71, 1),
  },
  {
    id: "hold-cap-insurance-secondary",
    split: "heldout",
    family: "CAPTION_DISAMBIGUATION",
    query: "Secondary claims queue Line Home Analyst Alice North Cycle WeekOne",
    goldRowKey: rowKey("hold-insurance", 72, 1),
  },
  {
    id: "hold-header-control",
    split: "heldout",
    family: "HEADER_VALUE_CONTROL",
    query: "Producto Estaño Almacén Sur Lote LoteVerde",
    goldRowKey: rowKey("hold-controls", 1, 2),
  },
  {
    id: "hold-header-nearby",
    split: "heldout",
    family: "HEADER_VALUE_CONTROL",
    query: "Team Data Lead Carla Mena Capacity Ten",
    goldRowKey: rowKey("hold-nearby", 1, 2),
  },
  {
    id: "hold-value-control",
    split: "heldout",
    family: "VALUE_ONLY_CONTROL",
    query: "Cobre Norte LoteRojo",
    goldRowKey: rowKey("hold-controls", 1, 1),
  },
  {
    id: "hold-value-mismatch",
    split: "heldout",
    family: "VALUE_ONLY_CONTROL",
    query: "Paita OperatorTwo Waiting",
    goldRowKey: rowKey("hold-mismatch", 1, 2),
  },
  {
    id: "hold-neg-nearby",
    split: "heldout",
    family: "NON_CAPTION_NEGATIVE",
    query: "Historic priority matrix Team Platform Lead Sofia Vega",
  },
  {
    id: "hold-neg-mismatch",
    split: "heldout",
    family: "NON_CAPTION_NEGATIVE",
    query: "Archived port register Port Callao Operator OperatorOne",
  },
  {
    id: "hold-neg-cross-row",
    split: "heldout",
    family: "CROSS_ROW_NEGATIVE",
    query: "Turnos de ruta principal Ruta Andina Operador Luis Peña",
  },
  {
    id: "hold-neg-cross-document",
    split: "heldout",
    family: "CROSS_DOCUMENT_NEGATIVE",
    query: "Night grid assignment Producto Cobre Almacén Norte",
  },
];

const FAMILIES: Family[] = [
  "CAPTION_DISAMBIGUATION",
  "HEADER_VALUE_CONTROL",
  "VALUE_ONLY_CONTROL",
  "NON_CAPTION_NEGATIVE",
  "CROSS_ROW_NEGATIVE",
  "CROSS_DOCUMENT_NEGATIVE",
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

async function candidateHeadSha(): Promise<string> {
  const explicit = process.env.AKP_TABLE_CAPTION_PARITY_CANDIDATE_SHA?.trim();
  if (explicit) return explicit;
  const eventPath = process.env.GITHUB_EVENT_PATH?.trim();
  if (eventPath) {
    const event = JSON.parse(await readFile(eventPath, "utf8")) as {
      pull_request?: { head?: { sha?: unknown } };
    };
    const value = event.pull_request?.head?.sha;
    if (typeof value === "string" && /^[0-9a-f]{40}$/u.test(value)) {
      return value;
    }
  }
  return gitHead();
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
    recallAt3: recall(ranks, 3),
    negativeQuestions: negatives.length,
    falseFullRowMatchRate:
      negatives.length === 0
        ? null
        : negatives.filter((entry) => entry.anyFullRowMatch).length /
          negatives.length,
  };
}

function summarize(split: Split, observations: Observation[]): SplitSummary {
  const ids = new Set(
    QUESTIONS.filter((question) => question.split === split).map(
      (question) => question.id,
    ),
  );
  const selected = observations.filter((entry) => ids.has(entry.questionId));
  const positives = selected.filter((entry) => entry.goldRowKey);
  const negatives = selected.filter((entry) => !entry.goldRowKey);
  const ranks = positives.map((entry) => entry.rank ?? 0);
  return {
    split,
    positiveQuestions: positives.length,
    negativeQuestions: negatives.length,
    recallAt1: recall(ranks, 1),
    recallAt3: recall(ranks, 3),
    meanReciprocalRank: mean(
      ranks.map((rank) => (rank > 0 ? 1 / rank : 0)),
    ),
    falseFullRowMatchRate:
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
  const client = await db.pool.connect();
  try {
    await client.query(
      [
        "create temporary table akp_caption_parity_documents (",
        "document_key text primary key,",
        "split text not null,",
        "title_vector tsvector not null,",
        "body_vector tsvector not null,",
        "search_vector tsvector not null",
        ") on commit preserve rows",
      ].join("\n"),
    );
    await client.query(
      [
        "create temporary table akp_caption_parity_rows (",
        "row_key text not null,",
        "document_key text not null,",
        "split text not null,",
        "arm text not null,",
        "structural_order integer not null,",
        "heading_vector tsvector not null,",
        "unit_vector tsvector not null,",
        "body_vector tsvector not null,",
        "context_vector tsvector not null,",
        "search_vector tsvector not null,",
        "primary key(row_key, arm)",
        ") on commit preserve rows",
      ].join("\n"),
    );

    for (const document of DOCUMENTS) {
      await client.query(
        [
          "insert into akp_caption_parity_documents(",
          "document_key,split,title_vector,body_vector,search_vector",
          ")",
          "select $1,$2,",
          "to_tsvector('simple',$3),",
          "to_tsvector('simple',$4),",
          "setweight(to_tsvector('simple',$3),'B') ||",
          "setweight(to_tsvector('simple',$4),'D')",
        ].join("\n"),
        [document.id, document.split, document.title, document.source],
      );
    }

    const rows: Array<{
      rowKey: string;
      documentKey: string;
      split: Split;
      unitKey: string;
      structuralOrder: number;
      headingText: string;
      rawBody: string;
      captionContext: string;
      captioned: boolean;
    }> = [];

    let explicitCaptionRows = 0;
    for (const document of DOCUMENTS) {
      const units = parseKnowledgeUnits(document.title, document.source);
      const projections = projectTableRows(document.title, document.source);
      for (const projection of projections) {
        const expectedCaption = document.expectedCaptionedTables.includes(
          projection.tableIndex,
        );
        if (Boolean(projection.caption) !== expectedCaption) {
          throw new Error(
            "Caption binding mismatch for " +
              document.id +
              " table " +
              projection.tableIndex,
          );
        }
        const unit = units.find(
          (candidate) =>
            candidate.unitType === "TABLE_ROW" &&
            candidate.locator.table === projection.tableIndex &&
            candidate.locator.row === projection.rowIndex,
        );
        if (!unit) {
          throw new Error(
            "Missing TABLE_ROW for " +
              document.id +
              " table " +
              projection.tableIndex +
              " row " +
              projection.rowIndex,
          );
        }
        const captioned = projection.caption !== undefined;
        if (captioned) explicitCaptionRows += 1;
        rows.push({
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
          captionContext: projection.caption
            ? "Caption: " + projection.caption
            : "",
          captioned,
        });
      }
    }

    const changedRows = rows.filter((row) => row.captionContext.length > 0).length;

    for (const row of rows) {
      for (const arm of ["raw-row", "explicit-caption-context"] as const) {
        const context = arm === "explicit-caption-context" ? row.captionContext : "";
        await client.query(
          [
            "insert into akp_caption_parity_rows(",
            "row_key,document_key,split,arm,structural_order,",
            "heading_vector,unit_vector,body_vector,context_vector,search_vector",
            ")",
            "select $1,$2,$3,$4,$5,",
            "to_tsvector('simple',$6),",
            "to_tsvector('simple',$7),",
            "to_tsvector('simple',$8),",
            "to_tsvector('simple',$9),",
            "setweight(to_tsvector('simple',$6),'A') ||",
            "setweight(to_tsvector('simple',$7),'B') ||",
            "setweight(to_tsvector('simple',$8),'C') ||",
            "setweight(to_tsvector('simple',$9),'C')",
          ].join("\n"),
          [
            row.rowKey,
            row.documentKey,
            row.split,
            arm,
            row.structuralOrder,
            row.headingText,
            row.unitKey + " TABLE_ROW",
            row.rawBody,
            context,
          ],
        );
      }
    }

    const observationsByArm = new Map<Arm, Observation[]>();
    for (const arm of ["raw-row", "explicit-caption-context"] as const) {
      const observations: Observation[] = [];
      for (const question of QUESTIONS) {
        const ranked = await client.query<{
          row_key: string;
          document_key: string;
          score: number;
          full_row_match: boolean;
        }>(
          [
            "with query as (",
            "select plainto_tsquery('simple',$2) terms",
            "), eligible_documents as (",
            "select d.document_key,d.title_vector,d.body_vector,q.terms",
            "from akp_caption_parity_documents d",
            "cross join query q",
            "where d.search_vector @@ q.terms",
            "or exists (",
            "select 1",
            "from akp_caption_parity_rows matching_row",
            "where matching_row.document_key=d.document_key",
            "and matching_row.arm=$1",
            "and matching_row.search_vector @@ q.terms",
            ")",
            "), scored as (",
            "select d.document_key,best_row.row_key,",
            "20*ts_rank_cd(d.title_vector,d.terms) +",
            "2*ts_rank_cd(d.body_vector,d.terms) +",
            "coalesce(best_row.unit_score,0) score,",
            "coalesce(best_row.full_row_match,false) full_row_match",
            "from eligible_documents d",
            "left join lateral (",
            "select r.row_key,r.structural_order,",
            "12*ts_rank_cd(r.heading_vector,d.terms) +",
            "8*ts_rank_cd(r.unit_vector,d.terms) +",
            "ts_rank_cd(r.body_vector,d.terms) +",
            "ts_rank_cd(r.context_vector,d.terms) unit_score,",
            "r.search_vector @@ d.terms full_row_match",
            "from akp_caption_parity_rows r",
            "where r.document_key=d.document_key and r.arm=$1",
            "order by unit_score desc,r.structural_order,r.row_key",
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
        const negativeScan = await client.query<{ any_match: boolean }>(
          [
            "with query as (select plainto_tsquery('simple',$2) terms)",
            "select exists(",
            "select 1 from akp_caption_parity_rows r cross join query q",
            "where r.arm=$1 and r.search_vector @@ q.terms",
            ") any_match",
          ].join("\n"),
          [arm, question.query],
        );
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
          anyFullRowMatch: negativeScan.rows[0]?.any_match ?? false,
          topRows: ranked.rows.slice(0, 5).map((entry) => ({
            rowKey: entry.row_key,
            documentKey: entry.document_key,
            score: Number(entry.score),
            fullRowMatch: entry.full_row_match,
          })),
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

    const baseline = summaries["raw-row"];
    const candidate = summaries["explicit-caption-context"];
    const familyRecall = (summary: SplitSummary, family: Family) =>
      summary.byFamily[family].recallAt1 ?? 0;
    const negativeRate = (summary: SplitSummary) =>
      summary.falseFullRowMatchRate ?? 0;

    const gates = {
      captionBindingMatchesFrozenFixture: true,
      changedRowsExactlyExplicitCaptionRows:
        changedRows === explicitCaptionRows && changedRows > 0,
      developmentCaptionRecallImproves:
        familyRecall(candidate.development, "CAPTION_DISAMBIGUATION") >
          familyRecall(baseline.development, "CAPTION_DISAMBIGUATION") &&
        familyRecall(candidate.development, "CAPTION_DISAMBIGUATION") >= 0.8,
      heldoutCaptionRecallImproves:
        familyRecall(candidate.heldout, "CAPTION_DISAMBIGUATION") >
          familyRecall(baseline.heldout, "CAPTION_DISAMBIGUATION") &&
        familyRecall(candidate.heldout, "CAPTION_DISAMBIGUATION") >= 0.8,
      heldoutCaptionRecallAt3AtLeastNinety:
        (candidate.heldout.byFamily.CAPTION_DISAMBIGUATION.recallAt3 ?? 0) >=
        0.9,
      developmentHeaderControlsNoRegression:
        familyRecall(candidate.development, "HEADER_VALUE_CONTROL") >=
        familyRecall(baseline.development, "HEADER_VALUE_CONTROL"),
      heldoutHeaderControlsNoRegression:
        familyRecall(candidate.heldout, "HEADER_VALUE_CONTROL") >=
        familyRecall(baseline.heldout, "HEADER_VALUE_CONTROL"),
      developmentValueControlsNoRegression:
        familyRecall(candidate.development, "VALUE_ONLY_CONTROL") >=
        familyRecall(baseline.development, "VALUE_ONLY_CONTROL"),
      heldoutValueControlsNoRegression:
        familyRecall(candidate.heldout, "VALUE_ONLY_CONTROL") >=
        familyRecall(baseline.heldout, "VALUE_ONLY_CONTROL"),
      developmentFalseFullRowMatchesRemainZero:
        negativeRate(candidate.development) === 0,
      heldoutFalseFullRowMatchesRemainZero:
        negativeRate(candidate.heldout) === 0,
      heldoutMrrImproves:
        (candidate.heldout.meanReciprocalRank ?? 0) >
        (baseline.heldout.meanReciprocalRank ?? 0),
    };
    const outcome = Object.values(gates).every(Boolean) ? "PROMOTE" : "REJECT";

    const report = {
      schemaVersion: "akp.table-caption-production-parity.v1",
      generatedAt: new Date().toISOString(),
      outcome,
      promotionScope: "production-wiring-eligibility-experiment-only",
      productionDefaultsChanged: false,
      activationEnabled: false,
      independentVariable:
        "explicit locator-bound caption as separate TABLE_ROW lexical context",
      baseline: "canonical TABLE_ROW lexical fields",
      candidate:
        "canonical TABLE_ROW lexical fields plus separate caption context at body weight",
      runtimeParity: {
        queryParser: "plainto_tsquery('simple')",
        documentEligibility:
          "document lexical match OR full unit lexical match",
        documentScore:
          "20*title + 2*document-body + best-unit-score",
        unitScore:
          "12*heading + 8*unit-metadata + body + lexical-context",
        bestUnitPerDocument:
          "lateral best unit by partial weighted score without requiring full unit match",
        negativeSemantics:
          "related document retrieval is allowed; negatives fail only on spurious full-row match",
      },
      experiment: {
        baselineSha: "c96b9e9d07dfa9f19c334344d5d1563851c79a7e",
        candidateSha: await candidateHeadSha(),
        corpusHash: sha256(
          JSON.stringify({ documents: DOCUMENTS, questions: QUESTIONS }),
        ),
        freshAfterExperiment: "#78",
        corpusDocuments: DOCUMENTS.length,
        corpusRows: rows.length,
        explicitCaptionRows,
        changedRows,
        questions: QUESTIONS.length,
        splitProtocol:
          "FRESH_DOMAIN_SOURCE_DISJOINT_PREDECLARED_BEFORE_EXECUTION",
        languages: ["en", "es"],
      },
      gates,
      arms: summaries,
      measured: [
        "production-like document lexical eligibility",
        "lateral best-row selection under partial score",
        "caption-disambiguation Recall@1/3",
        "header-value and value-only control Recall@1",
        "mean reciprocal rank",
        "negative full-row-match rate",
        "exact count of rows receiving caption context",
      ],
      notMeasured: [
        "exact and symbol retrieval channels",
        "query transformations and assertion recall",
        "vector retrieval",
        "fusion and reranking",
        "evidence admission",
        "citation precision",
        "private-vault retrieval",
        "production activation",
      ],
      limitation:
        "PROMOTE would justify only a separate schema/index/query wiring experiment with the feature off by default. It would not close R5/R6/R7/R9.",
    };

    const output = path.resolve(
      process.env.AKP_TABLE_CAPTION_PARITY_REPORT ??
        "reports/ci/table-caption-production-parity.json",
    );
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n", "utf8");
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } finally {
    client.release();
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
