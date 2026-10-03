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
type Arm = "raw-row" | "explicit-caption-augmentation";
type Family =
  | "CAPTION_BOUND"
  | "HEADER_VALUE_CONTROL"
  | "VALUE_ONLY_CONTROL"
  | "NON_CAPTION_NEGATIVE"
  | "CROSS_ROW_NEGATIVE"
  | "CROSS_TABLE_NEGATIVE";

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
}

interface Observation {
  questionId: string;
  family: Family;
  query: string;
  goldRowKey?: string;
  rank: number | null;
  returnedAny: boolean;
  topRows: RankedRow[];
}

interface FamilySummary {
  questions: number;
  positiveQuestions: number;
  recallAt1: number | null;
  recallAt3: number | null;
  negativeQuestions: number;
  falseMatchRate: number | null;
}

interface SplitSummary {
  split: Split;
  positiveQuestions: number;
  negativeQuestions: number;
  recallAt1: number | null;
  recallAt3: number | null;
  meanReciprocalRank: number | null;
  falseMatchRate: number | null;
  byFamily: Record<Family, FamilySummary>;
  observations: Observation[];
}

const DOCUMENTS: DocumentFixture[] = [
  {
    id: "dev-incident",
    split: "development",
    title: "Incident operations",
    expectedCaptionedTables: [12],
    source: [
      "# Incident coverage",
      "<!-- akp-locator: page=2; table=12 -->",
      "Escalation tier matrix",
      "",
      "<!-- akp-locator: page=2; table=12 -->",
      "| Region | Responder | Tier |",
      "| --- | --- | --- |",
      "| North | Mara Quinn | Critical |",
      "| South | Owen Pike | High |",
      "| East | Nora Bell | Medium |",
    ].join("\n"),
  },
  {
    id: "dev-assets",
    split: "development",
    title: "Asset custody",
    expectedCaptionedTables: [3],
    source: [
      "# Device custody",
      "<!-- akp-locator: page=4; table=3 -->",
      "Custody ledger alpha",
      "",
      "<!-- akp-locator: page=4; table=3 -->",
      "| Asset | Custodian | Site |",
      "| --- | --- | --- |",
      "| SensorK | Ivan Cole | DockOne |",
      "| RelayM | Tessa Ford | DockTwo |",
      "| ProbeR | Aaron West | DockThree |",
    ].join("\n"),
  },
  {
    id: "dev-nearby",
    split: "development",
    title: "Dispatch assignments",
    expectedCaptionedTables: [],
    source: [
      "# Dispatch board",
      "Historical dispatch roster",
      "",
      "| Route | Dispatcher | Slot |",
      "| --- | --- | --- |",
      "| RouteA | Liam Stone | Sunrise |",
      "| RouteB | Eva Marsh | Midday |",
      "| RouteC | Joel Hart | Sunset |",
    ].join("\n"),
  },
  {
    id: "dev-mismatch",
    split: "development",
    title: "Component allocation",
    expectedCaptionedTables: [],
    source: [
      "# Budget ownership",
      "<!-- akp-locator: page=8; table=99 -->",
      "Legacy allocation matrix",
      "",
      "| Component | Owner | Budget |",
      "| --- | --- | --- |",
      "| Gateway | Nina Sharp | BudgetA |",
      "| Broker | Paul Reed | BudgetB |",
      "| Portal | Mia Frost | BudgetC |",
    ].join("\n"),
  },
  {
    id: "dev-multi",
    split: "development",
    title: "Release calendars",
    expectedCaptionedTables: [41, 42],
    source: [
      "# Coordinated releases",
      "<!-- akp-locator: page=10; table=41 -->",
      "Primary release calendar",
      "",
      "<!-- akp-locator: page=10; table=41 -->",
      "| Service | Lead | Date |",
      "| --- | --- | --- |",
      "| Search | Kira Snow | Monday |",
      "| Billing | Leo Gray | Tuesday |",
      "",
      "<!-- akp-locator: page=10; table=42 -->",
      "Secondary release calendar",
      "",
      "<!-- akp-locator: page=10; table=42 -->",
      "| Service | Lead | Date |",
      "| --- | --- | --- |",
      "| Identity | Uma King | Wednesday |",
      "| Catalog | Eric Dawn | Thursday |",
    ].join("\n"),
  },
  {
    id: "hold-supply",
    split: "heldout",
    title: "Abastecimiento",
    expectedCaptionedTables: [21],
    source: [
      "# Suministro regional",
      "<!-- akp-locator: page=3; table=21 -->",
      "Matriz de abastecimiento regional",
      "",
      "<!-- akp-locator: page=3; table=21 -->",
      "| Producto | Almacén | Lote |",
      "| --- | --- | --- |",
      "| Cobre | Norte | LoteRojo |",
      "| Zinc | Centro | LoteAzul |",
      "| Estaño | Sur | LoteVerde |",
    ].join("\n"),
  },
  {
    id: "hold-clinic",
    split: "heldout",
    title: "Directorio clínico",
    expectedCaptionedTables: [5],
    source: [
      "# Cobertura clínica",
      "<!-- akp-locator: page=5; table=5 -->",
      "Directorio de respuesta clínica",
      "",
      "<!-- akp-locator: page=5; table=5 -->",
      "| Centro | Contacto | Turno |",
      "| --- | --- | --- |",
      "| Surco | Elena Cruz | Temprano |",
      "| Breña | Bruno León | Tarde |",
      "| Lince | Rosa Díaz | Noche |",
    ].join("\n"),
  },
  {
    id: "hold-customs",
    split: "heldout",
    title: "Operación aduanera",
    expectedCaptionedTables: [8],
    source: [
      "# Inspección de rutas",
      "<!-- akp-locator: page=7; table=8 -->",
      "Rutas de inspección aduanera",
      "",
      "<!-- akp-locator: page=7; table=8 -->",
      "| Ruta | Puerta | Horario |",
      "| --- | --- | --- |",
      "| Andina | PuertaA | Mañana |",
      "| Costera | PuertaB | Tarde |",
      "| Selva | PuertaC | Noche |",
    ].join("\n"),
  },
  {
    id: "hold-maintenance",
    split: "heldout",
    title: "Maintenance plan",
    expectedCaptionedTables: [14],
    source: [
      "# Service maintenance",
      "<!-- akp-locator: page=9; table=14 -->",
      "Maintenance ownership roster",
      "",
      "<!-- akp-locator: page=9; table=14 -->",
      "| Service | Engineer | Window |",
      "| --- | --- | --- |",
      "| Ledger | Priya Hale | Midnight |",
      "| Queue | Simon Vale | Dawn |",
      "| Search | Dana Kerr | Evening |",
    ].join("\n"),
  },
  {
    id: "hold-nearby",
    split: "heldout",
    title: "Capacidad operativa",
    expectedCaptionedTables: [],
    source: [
      "# Equipos activos",
      "Matriz de prioridad histórica",
      "",
      "| Equipo | Responsable | Capacidad |",
      "| --- | --- | --- |",
      "| Plataforma | Ana Ríos | Doce |",
      "| Datos | Luis Peña | Diez |",
      "| Móvil | Sara León | Ocho |",
    ].join("\n"),
  },
  {
    id: "hold-mismatch",
    split: "heldout",
    title: "Estado portuario",
    expectedCaptionedTables: [],
    source: [
      "# Operadores activos",
      "<!-- akp-locator: page=12; table=77 -->",
      "Registro archivado de puertos",
      "",
      "| Puerto | Operador | Estado |",
      "| --- | --- | --- |",
      "| Callao | OperadorUno | Activo |",
      "| Paita | OperadorDos | Espera |",
      "| Ilo | OperadorTres | Cerrado |",
    ].join("\n"),
  },
  {
    id: "hold-multi",
    split: "heldout",
    title: "Audit schedules",
    expectedCaptionedTables: [31, 32],
    source: [
      "# Dual audit plan",
      "<!-- akp-locator: page=15; table=31 -->",
      "Primary audit roster",
      "",
      "<!-- akp-locator: page=15; table=31 -->",
      "| Area | Auditor | Cycle |",
      "| --- | --- | --- |",
      "| Access | Mira Lowe | Weekly |",
      "| Storage | Theo Nash | Monthly |",
      "",
      "<!-- akp-locator: page=15; table=32 -->",
      "Secondary audit roster",
      "",
      "<!-- akp-locator: page=15; table=32 -->",
      "| Area | Auditor | Cycle |",
      "| --- | --- | --- |",
      "| Network | Cora Mills | Daily |",
      "| Backup | Ian Ross | Quarterly |",
    ].join("\n"),
  },
];

function rowKey(documentId: string, table: number, row: number): string {
  return documentId + ":table:" + table + ":row:" + row;
}

const QUESTIONS: QuestionFixture[] = [
  {
    id: "dev-cap-incident-1",
    split: "development",
    family: "CAPTION_BOUND",
    query:
      "Escalation tier matrix Region North Responder Mara Quinn Tier Critical",
    goldRowKey: rowKey("dev-incident", 12, 1),
  },
  {
    id: "dev-cap-incident-2",
    split: "development",
    family: "CAPTION_BOUND",
    query: "Escalation tier matrix Region South Responder Owen Pike Tier High",
    goldRowKey: rowKey("dev-incident", 12, 2),
  },
  {
    id: "dev-cap-assets-1",
    split: "development",
    family: "CAPTION_BOUND",
    query:
      "Custody ledger alpha Asset SensorK Custodian Ivan Cole Site DockOne",
    goldRowKey: rowKey("dev-assets", 3, 1),
  },
  {
    id: "dev-cap-assets-2",
    split: "development",
    family: "CAPTION_BOUND",
    query:
      "Custody ledger alpha Asset RelayM Custodian Tessa Ford Site DockTwo",
    goldRowKey: rowKey("dev-assets", 3, 2),
  },
  {
    id: "dev-cap-multi-primary",
    split: "development",
    family: "CAPTION_BOUND",
    query: "Primary release calendar Service Search Lead Kira Snow Date Monday",
    goldRowKey: rowKey("dev-multi", 41, 1),
  },
  {
    id: "dev-cap-multi-secondary",
    split: "development",
    family: "CAPTION_BOUND",
    query:
      "Secondary release calendar Service Identity Lead Uma King Date Wednesday",
    goldRowKey: rowKey("dev-multi", 42, 1),
  },
  {
    id: "dev-header-incident",
    split: "development",
    family: "HEADER_VALUE_CONTROL",
    query: "Region East Responder Nora Bell Tier Medium",
    goldRowKey: rowKey("dev-incident", 12, 3),
  },
  {
    id: "dev-header-nearby",
    split: "development",
    family: "HEADER_VALUE_CONTROL",
    query: "Route RouteB Dispatcher Eva Marsh Slot Midday",
    goldRowKey: rowKey("dev-nearby", 1, 2),
  },
  {
    id: "dev-header-mismatch",
    split: "development",
    family: "HEADER_VALUE_CONTROL",
    query: "Component Broker Owner Paul Reed Budget BudgetB",
    goldRowKey: rowKey("dev-mismatch", 1, 2),
  },
  {
    id: "dev-header-multi",
    split: "development",
    family: "HEADER_VALUE_CONTROL",
    query: "Service Catalog Lead Eric Dawn Date Thursday",
    goldRowKey: rowKey("dev-multi", 42, 2),
  },
  {
    id: "dev-value-assets",
    split: "development",
    family: "VALUE_ONLY_CONTROL",
    query: "ProbeR Aaron West DockThree",
    goldRowKey: rowKey("dev-assets", 3, 3),
  },
  {
    id: "dev-value-nearby",
    split: "development",
    family: "VALUE_ONLY_CONTROL",
    query: "RouteA Liam Stone Sunrise",
    goldRowKey: rowKey("dev-nearby", 1, 1),
  },
  {
    id: "dev-neg-nearby-prose",
    split: "development",
    family: "NON_CAPTION_NEGATIVE",
    query: "Historical dispatch roster Route RouteA Dispatcher Liam Stone",
  },
  {
    id: "dev-neg-mismatch-locator",
    split: "development",
    family: "NON_CAPTION_NEGATIVE",
    query: "Legacy allocation matrix Component Gateway Owner Nina Sharp",
  },
  {
    id: "dev-neg-cross-row",
    split: "development",
    family: "CROSS_ROW_NEGATIVE",
    query: "Escalation tier matrix Region North Responder Owen Pike",
  },
  {
    id: "dev-neg-cross-table",
    split: "development",
    family: "CROSS_TABLE_NEGATIVE",
    query: "Primary release calendar Service Identity Lead Uma King",
  },
  {
    id: "hold-cap-supply-1",
    split: "heldout",
    family: "CAPTION_BOUND",
    query:
      "Matriz de abastecimiento regional Producto Cobre Almacén Norte Lote LoteRojo",
    goldRowKey: rowKey("hold-supply", 21, 1),
  },
  {
    id: "hold-cap-supply-2",
    split: "heldout",
    family: "CAPTION_BOUND",
    query:
      "Matriz de abastecimiento regional Producto Zinc Almacén Centro Lote LoteAzul",
    goldRowKey: rowKey("hold-supply", 21, 2),
  },
  {
    id: "hold-cap-clinic-1",
    split: "heldout",
    family: "CAPTION_BOUND",
    query:
      "Directorio de respuesta clínica Centro Surco Contacto Elena Cruz Turno Temprano",
    goldRowKey: rowKey("hold-clinic", 5, 1),
  },
  {
    id: "hold-cap-clinic-2",
    split: "heldout",
    family: "CAPTION_BOUND",
    query:
      "Directorio de respuesta clínica Centro Breña Contacto Bruno León Turno Tarde",
    goldRowKey: rowKey("hold-clinic", 5, 2),
  },
  {
    id: "hold-cap-customs-1",
    split: "heldout",
    family: "CAPTION_BOUND",
    query:
      "Rutas de inspección aduanera Ruta Andina Puerta PuertaA Horario Mañana",
    goldRowKey: rowKey("hold-customs", 8, 1),
  },
  {
    id: "hold-cap-customs-2",
    split: "heldout",
    family: "CAPTION_BOUND",
    query:
      "Rutas de inspección aduanera Ruta Costera Puerta PuertaB Horario Tarde",
    goldRowKey: rowKey("hold-customs", 8, 2),
  },
  {
    id: "hold-cap-maint-1",
    split: "heldout",
    family: "CAPTION_BOUND",
    query:
      "Maintenance ownership roster Service Ledger Engineer Priya Hale Window Midnight",
    goldRowKey: rowKey("hold-maintenance", 14, 1),
  },
  {
    id: "hold-cap-maint-2",
    split: "heldout",
    family: "CAPTION_BOUND",
    query:
      "Maintenance ownership roster Service Queue Engineer Simon Vale Window Dawn",
    goldRowKey: rowKey("hold-maintenance", 14, 2),
  },
  {
    id: "hold-cap-multi-primary",
    split: "heldout",
    family: "CAPTION_BOUND",
    query: "Primary audit roster Area Access Auditor Mira Lowe Cycle Weekly",
    goldRowKey: rowKey("hold-multi", 31, 1),
  },
  {
    id: "hold-cap-multi-secondary",
    split: "heldout",
    family: "CAPTION_BOUND",
    query: "Secondary audit roster Area Network Auditor Cora Mills Cycle Daily",
    goldRowKey: rowKey("hold-multi", 32, 1),
  },
  {
    id: "hold-header-supply",
    split: "heldout",
    family: "HEADER_VALUE_CONTROL",
    query: "Producto Estaño Almacén Sur Lote LoteVerde",
    goldRowKey: rowKey("hold-supply", 21, 3),
  },
  {
    id: "hold-header-clinic",
    split: "heldout",
    family: "HEADER_VALUE_CONTROL",
    query: "Centro Lince Contacto Rosa Díaz Turno Noche",
    goldRowKey: rowKey("hold-clinic", 5, 3),
  },
  {
    id: "hold-header-customs",
    split: "heldout",
    family: "HEADER_VALUE_CONTROL",
    query: "Ruta Selva Puerta PuertaC Horario Noche",
    goldRowKey: rowKey("hold-customs", 8, 3),
  },
  {
    id: "hold-header-nearby",
    split: "heldout",
    family: "HEADER_VALUE_CONTROL",
    query: "Equipo Datos Responsable Luis Peña Capacidad Diez",
    goldRowKey: rowKey("hold-nearby", 1, 2),
  },
  {
    id: "hold-header-mismatch",
    split: "heldout",
    family: "HEADER_VALUE_CONTROL",
    query: "Puerto Paita Operador OperadorDos Estado Espera",
    goldRowKey: rowKey("hold-mismatch", 1, 2),
  },
  {
    id: "hold-header-multi",
    split: "heldout",
    family: "HEADER_VALUE_CONTROL",
    query: "Area Backup Auditor Ian Ross Cycle Quarterly",
    goldRowKey: rowKey("hold-multi", 32, 2),
  },
  {
    id: "hold-value-maintenance",
    split: "heldout",
    family: "VALUE_ONLY_CONTROL",
    query: "Search Dana Kerr Evening",
    goldRowKey: rowKey("hold-maintenance", 14, 3),
  },
  {
    id: "hold-value-nearby",
    split: "heldout",
    family: "VALUE_ONLY_CONTROL",
    query: "Plataforma Ana Ríos Doce",
    goldRowKey: rowKey("hold-nearby", 1, 1),
  },
  {
    id: "hold-value-mismatch",
    split: "heldout",
    family: "VALUE_ONLY_CONTROL",
    query: "Callao OperadorUno Activo",
    goldRowKey: rowKey("hold-mismatch", 1, 1),
  },
  {
    id: "hold-neg-nearby-prose",
    split: "heldout",
    family: "NON_CAPTION_NEGATIVE",
    query:
      "Matriz de prioridad histórica Equipo Plataforma Responsable Ana Ríos",
  },
  {
    id: "hold-neg-mismatch-locator",
    split: "heldout",
    family: "NON_CAPTION_NEGATIVE",
    query: "Registro archivado de puertos Puerto Callao Operador OperadorUno",
  },
  {
    id: "hold-neg-cross-row",
    split: "heldout",
    family: "CROSS_ROW_NEGATIVE",
    query:
      "Directorio de respuesta clínica Centro Surco Contacto Bruno León Turno Temprano",
  },
  {
    id: "hold-neg-cross-table",
    split: "heldout",
    family: "CROSS_TABLE_NEGATIVE",
    query: "Primary audit roster Area Network Auditor Cora Mills",
  },
  {
    id: "hold-neg-cross-doc",
    split: "heldout",
    family: "CROSS_TABLE_NEGATIVE",
    query:
      "Maintenance ownership roster Producto Cobre Almacén Norte Lote LoteRojo",
  },
];

const FAMILIES: Family[] = [
  "CAPTION_BOUND",
  "HEADER_VALUE_CONTROL",
  "VALUE_ONLY_CONTROL",
  "NON_CAPTION_NEGATIVE",
  "CROSS_ROW_NEGATIVE",
  "CROSS_TABLE_NEGATIVE",
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
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function recall(ranks: readonly number[], k: number): number | null {
  return ranks.length === 0
    ? null
    : ranks.filter((rank) => rank > 0 && rank <= k).length / ranks.length;
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
    falseMatchRate:
      negatives.length === 0
        ? null
        : negatives.filter((entry) => entry.returnedAny).length /
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
    meanReciprocalRank: mean(ranks.map((rank) => (rank > 0 ? 1 / rank : 0))),
    falseMatchRate:
      negatives.length === 0
        ? null
        : negatives.filter((entry) => entry.returnedAny).length /
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
        "create temporary table akp_caption_projection_eval (",
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

    const rows: Array<{
      rowKey: string;
      documentKey: string;
      split: Split;
      unitKey: string;
      structuralOrder: number;
      headingText: string;
      rawBody: string;
      candidateBody: string;
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
          candidateBody: captioned
            ? unit.body + "\nCaption: " + projection.caption
            : unit.body,
          captioned,
        });
      }
    }

    const changedRows = rows.filter(
      (row) => row.candidateBody !== row.rawBody,
    ).length;

    for (const row of rows) {
      for (const arm of ["raw-row", "explicit-caption-augmentation"] as const) {
        const body = arm === "raw-row" ? row.rawBody : row.candidateBody;
        await client.query(
          [
            "insert into akp_caption_projection_eval(",
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
    for (const arm of ["raw-row", "explicit-caption-augmentation"] as const) {
      const observations: Observation[] = [];
      for (const question of QUESTIONS) {
        const ranked = await client.query<{
          row_key: string;
          document_key: string;
          score: number;
        }>(
          [
            "with query as (",
            "select plainto_tsquery('simple', $2) terms",
            "), scored as (",
            "select e.row_key,e.document_key,e.structural_order,",
            "12 * ts_rank_cd(e.heading_vector,q.terms) +",
            "8 * ts_rank_cd(e.unit_vector,q.terms) +",
            "ts_rank_cd(e.body_vector,q.terms) score",
            "from akp_caption_projection_eval e",
            "cross join query q",
            "where e.arm=$1",
            "and e.search_vector @@ q.terms",
            "), best_unit_per_document as (",
            "select distinct on (document_key)",
            "row_key,document_key,structural_order,score",
            "from scored",
            "order by document_key,score desc,structural_order,row_key",
            ")",
            "select row_key,document_key,score",
            "from best_unit_per_document",
            "order by score desc,document_key,row_key",
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
          returnedAny: ranked.rows.length > 0,
          topRows: ranked.rows.slice(0, 5).map((entry) => ({
            rowKey: entry.row_key,
            documentKey: entry.document_key,
            score: Number(entry.score),
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
    const candidate = summaries["explicit-caption-augmentation"];
    const familyRecall1 = (summary: SplitSummary, family: Family) =>
      summary.byFamily[family].recallAt1 ?? 0;
    const negativeRate = (summary: SplitSummary) => summary.falseMatchRate ?? 0;

    const gates = {
      captionBindingMatchesFrozenFixture: true,
      changedRowsExactlyExplicitCaptionRows:
        changedRows === explicitCaptionRows && changedRows > 0,
      developmentCaptionRecallImproves:
        familyRecall1(candidate.development, "CAPTION_BOUND") >
          familyRecall1(baseline.development, "CAPTION_BOUND") &&
        familyRecall1(candidate.development, "CAPTION_BOUND") >= 0.8,
      heldoutCaptionRecallImproves:
        familyRecall1(candidate.heldout, "CAPTION_BOUND") >
          familyRecall1(baseline.heldout, "CAPTION_BOUND") &&
        familyRecall1(candidate.heldout, "CAPTION_BOUND") >= 0.8,
      heldoutCaptionRecallAt3AtLeastNinety:
        (candidate.heldout.byFamily.CAPTION_BOUND.recallAt3 ?? 0) >= 0.9,
      developmentHeaderControlsNoRegression:
        familyRecall1(candidate.development, "HEADER_VALUE_CONTROL") >=
        familyRecall1(baseline.development, "HEADER_VALUE_CONTROL"),
      heldoutHeaderControlsNoRegression:
        familyRecall1(candidate.heldout, "HEADER_VALUE_CONTROL") >=
        familyRecall1(baseline.heldout, "HEADER_VALUE_CONTROL"),
      developmentValueControlsNoRegression:
        familyRecall1(candidate.development, "VALUE_ONLY_CONTROL") >=
        familyRecall1(baseline.development, "VALUE_ONLY_CONTROL"),
      heldoutValueControlsNoRegression:
        familyRecall1(candidate.heldout, "VALUE_ONLY_CONTROL") >=
        familyRecall1(baseline.heldout, "VALUE_ONLY_CONTROL"),
      developmentFalseMatchesRemainZero:
        negativeRate(candidate.development) === 0 &&
        negativeRate(candidate.development) <=
          negativeRate(baseline.development),
      heldoutFalseMatchesRemainZero:
        negativeRate(candidate.heldout) === 0 &&
        negativeRate(candidate.heldout) <= negativeRate(baseline.heldout),
      heldoutMrrImproves:
        (candidate.heldout.meanReciprocalRank ?? 0) >
        (baseline.heldout.meanReciprocalRank ?? 0),
    };
    const outcome = Object.values(gates).every(Boolean) ? "PROMOTE" : "REJECT";

    const report = {
      schemaVersion: "akp.table-caption-lexical-augmentation.v1",
      generatedAt: new Date().toISOString(),
      outcome,
      promotionScope: "caption-representation-experiment-only",
      productionDefaultsChanged: false,
      activationEnabled: false,
      independentVariable:
        "append explicitly locator-bound table caption to canonical TABLE_ROW body",
      baseline: "canonical TABLE_ROW body",
      candidate:
        "canonical TABLE_ROW body plus explicit locator-bound caption only",
      runtimeParity: {
        queryParser: "plainto_tsquery('simple')",
        score:
          "12*ts_rank_cd(heading)+8*ts_rank_cd(unit-metadata)+ts_rank_cd(body)",
        eligibility:
          "setweight(heading,A)||setweight(unit-metadata,B)||setweight(body,C) @@ query",
        bestUnitPerDocument: true,
      },
      experiment: {
        baselineSha:
          process.env.AKP_TABLE_CAPTION_BASELINE_SHA?.trim() ||
          "c96b9e9d07dfa9f19c334344d5d1563851c79a7e",
        candidateSha: await gitHead(),
        corpusHash: sha256(
          JSON.stringify({ documents: DOCUMENTS, questions: QUESTIONS }),
        ),
        freshAfterExperiment: "#77",
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
        "caption-bound row Recall@1/3",
        "header-value control Recall@1",
        "value-only control Recall@1",
        "mean reciprocal rank",
        "nearby-prose false matches",
        "mismatched-locator false matches",
        "cross-row false matches",
        "cross-table and cross-document false matches",
        "exact count of rows changed by the candidate representation",
      ],
      notMeasured: [
        "document exact channel",
        "query transformations and assertion recall",
        "vector retrieval",
        "fusion and reranking",
        "evidence admission",
        "citation precision",
        "private-vault retrieval",
        "production activation",
      ],
      limitation:
        "A PROMOTE result would justify only a separate production-wiring experiment for explicit table captions. It would not close R5/R6/R7/R9.",
    };

    const output = path.resolve(
      process.env.AKP_TABLE_CAPTION_REPORT ??
        "reports/ci/table-caption-lexical-augmentation.json",
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
