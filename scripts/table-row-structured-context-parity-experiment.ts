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
type Arm = "raw-row" | "structured-row-context";
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
  expectedCaptions: Record<number, string>;
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
    id: "dev-release",
    split: "development",
    title: "Release calendars",
    expectedCaptions: {
      101: "Blue release matrix",
      102: "Green release matrix",
    },
    source: [
      "# Release calendars",
      "<!-- akp-locator: page=2; table=101 -->",
      "Blue release matrix",
      "",
      "<!-- akp-locator: page=2; table=101 -->",
      "| Component | Owner | Slot |",
      "| --- | --- | --- |",
      "| API | Mira Chen | SlotA |",
      "| Worker | Devon Price | SlotB |",
      "",
      "<!-- akp-locator: page=2; table=102 -->",
      "Green release matrix",
      "",
      "<!-- akp-locator: page=2; table=102 -->",
      "| Component | Owner | Slot |",
      "| --- | --- | --- |",
      "| API | Mira Chen | SlotA |",
      "| Worker | Devon Price | SlotB |",
    ].join("\n"),
  },
  {
    id: "dev-cert",
    split: "development",
    title: "Certificate plans",
    expectedCaptions: {
      111: "Approved certificate register",
      112: "Deferred certificate register",
    },
    source: [
      "# Certificate plans",
      "<!-- akp-locator: page=4; table=111 -->",
      "Approved certificate register",
      "",
      "<!-- akp-locator: page=4; table=111 -->",
      "| Node | Reviewer | Cycle |",
      "| --- | --- | --- |",
      "| NodeX | Kim Park | Annual |",
      "| NodeY | Luis Gray | SemiAnnual |",
      "",
      "<!-- akp-locator: page=4; table=112 -->",
      "Deferred certificate register",
      "",
      "<!-- akp-locator: page=4; table=112 -->",
      "| Node | Reviewer | Cycle |",
      "| --- | --- | --- |",
      "| NodeX | Kim Park | Annual |",
      "| NodeY | Luis Gray | SemiAnnual |",
    ].join("\n"),
  },
  {
    id: "dev-controls",
    split: "development",
    title: "Parts restock",
    expectedCaptions: {},
    source: [
      "# Parts restock",
      "| Part | Depot | Threshold |",
      "| --- | --- | --- |",
      "| Bolt77 | West | Forty |",
      "| Fuse12 | East | Twenty |",
    ].join("\n"),
  },
  {
    id: "dev-nearby",
    split: "development",
    title: "Dispatch shifts",
    expectedCaptions: {},
    source: [
      "# Dispatch shifts",
      "Archived dispatch matrix",
      "",
      "| Route | Coordinator | Window |",
      "| --- | --- | --- |",
      "| RouteK | Sara Moon | Noon |",
      "| RouteL | Eli Wood | Dusk |",
    ].join("\n"),
  },
  {
    id: "dev-mismatch",
    split: "development",
    title: "Broker allocations",
    expectedCaptions: {},
    source: [
      "# Broker allocations",
      "<!-- akp-locator: page=7; table=999 -->",
      "Retired broker ledger",
      "",
      "<!-- akp-locator: page=7; table=1 -->",
      "| Broker | Account | Band |",
      "| --- | --- | --- |",
      "| Orion | AcctA | TierOne |",
      "| Vega | AcctB | TierTwo |",
    ].join("\n"),
  },
  {
    id: "hold-lab",
    split: "heldout",
    title: "Operación de laboratorio",
    expectedCaptions: {
      201: "Turno de laboratorio norte",
      202: "Turno de laboratorio sur",
    },
    source: [
      "# Operación de laboratorio",
      "<!-- akp-locator: page=3; table=201 -->",
      "Turno de laboratorio norte",
      "",
      "<!-- akp-locator: page=3; table=201 -->",
      "| Muestra | Analista | Horario |",
      "| --- | --- | --- |",
      "| MuestraA | Elena Ríos | Mañana |",
      "| MuestraB | Pablo León | Tarde |",
      "",
      "<!-- akp-locator: page=3; table=202 -->",
      "Turno de laboratorio sur",
      "",
      "<!-- akp-locator: page=3; table=202 -->",
      "| Muestra | Analista | Horario |",
      "| --- | --- | --- |",
      "| MuestraA | Elena Ríos | Mañana |",
      "| MuestraB | Pablo León | Tarde |",
    ].join("\n"),
  },
  {
    id: "hold-weather",
    split: "heldout",
    title: "Sensor coverage",
    expectedCaptions: {
      211: "Day sensor register",
      212: "Night sensor register",
    },
    source: [
      "# Sensor coverage",
      "<!-- akp-locator: page=8; table=211 -->",
      "Day sensor register",
      "",
      "<!-- akp-locator: page=8; table=211 -->",
      "| Sensor | Technician | Window |",
      "| --- | --- | --- |",
      "| SensorA | Claire Snow | Dawn |",
      "| SensorB | Marco Reed | Evening |",
      "",
      "<!-- akp-locator: page=8; table=212 -->",
      "Night sensor register",
      "",
      "<!-- akp-locator: page=8; table=212 -->",
      "| Sensor | Technician | Window |",
      "| --- | --- | --- |",
      "| SensorA | Claire Snow | Dawn |",
      "| SensorB | Marco Reed | Evening |",
    ].join("\n"),
  },
  {
    id: "hold-school",
    split: "heldout",
    title: "Matrícula académica",
    expectedCaptions: {
      221: "Matrícula ordinaria",
      222: "Matrícula especial",
    },
    source: [
      "# Matrícula académica",
      "<!-- akp-locator: page=5; table=221 -->",
      "Matrícula ordinaria",
      "",
      "<!-- akp-locator: page=5; table=221 -->",
      "| Programa | Tutor | Cupo |",
      "| --- | --- | --- |",
      "| Ingeniería | Lucia Paz | Treinta |",
      "| Diseño | Rafael Sol | Veinte |",
      "",
      "<!-- akp-locator: page=5; table=222 -->",
      "Matrícula especial",
      "",
      "<!-- akp-locator: page=5; table=222 -->",
      "| Programa | Tutor | Cupo |",
      "| --- | --- | --- |",
      "| Ingeniería | Lucia Paz | Treinta |",
      "| Diseño | Rafael Sol | Veinte |",
    ].join("\n"),
  },
  {
    id: "hold-controls",
    split: "heldout",
    title: "Inventario de metales",
    expectedCaptions: {},
    source: [
      "# Inventario",
      "| Producto | Depósito | Lote |",
      "| --- | --- | --- |",
      "| Cobre | Norte | LoteRojo |",
      "| Estaño | Sur | LoteVerde |",
    ].join("\n"),
  },
  {
    id: "hold-nearby",
    split: "heldout",
    title: "Team allocation",
    expectedCaptions: {},
    source: [
      "# Team allocation",
      "Historic staffing grid",
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
    title: "Dock registry",
    expectedCaptions: {},
    source: [
      "# Dock registry",
      "<!-- akp-locator: page=9; table=888 -->",
      "Archived dock registry",
      "",
      "<!-- akp-locator: page=9; table=1 -->",
      "| Port | Operator | State |",
      "| --- | --- | --- |",
      "| Matarani | OpOne | Active |",
      "| Ilo | OpTwo | Waiting |",
    ].join("\n"),
  },
];

function rowKey(
  documentId: string,
  tableIndex: number,
  rowIndex: number,
): string {
  return documentId + ":table:" + tableIndex + ":row:" + rowIndex;
}

const QUESTIONS: QuestionFixture[] = [
  {
    id: "dev-cap-release-blue",
    split: "development",
    family: "CAPTION_DISAMBIGUATION",
    query: "Blue release matrix Component API Owner Mira Chen Slot SlotA",
    goldRowKey: rowKey("dev-release", 101, 1),
  },
  {
    id: "dev-cap-release-green",
    split: "development",
    family: "CAPTION_DISAMBIGUATION",
    query: "Green release matrix Component API Owner Mira Chen Slot SlotA",
    goldRowKey: rowKey("dev-release", 102, 1),
  },
  {
    id: "dev-cap-cert-approved",
    split: "development",
    family: "CAPTION_DISAMBIGUATION",
    query:
      "Approved certificate register Node NodeX Reviewer Kim Park Cycle Annual",
    goldRowKey: rowKey("dev-cert", 111, 1),
  },
  {
    id: "dev-cap-cert-deferred",
    split: "development",
    family: "CAPTION_DISAMBIGUATION",
    query:
      "Deferred certificate register Node NodeX Reviewer Kim Park Cycle Annual",
    goldRowKey: rowKey("dev-cert", 112, 1),
  },
  {
    id: "dev-header-control",
    split: "development",
    family: "HEADER_VALUE_CONTROL",
    query: "Part Fuse12 Depot East Threshold Twenty",
    goldRowKey: rowKey("dev-controls", 1, 2),
  },
  {
    id: "dev-header-nearby",
    split: "development",
    family: "HEADER_VALUE_CONTROL",
    query: "Route RouteL Coordinator Eli Wood Window Dusk",
    goldRowKey: rowKey("dev-nearby", 1, 2),
  },
  {
    id: "dev-value-control",
    split: "development",
    family: "VALUE_ONLY_CONTROL",
    query: "Bolt77 West Forty",
    goldRowKey: rowKey("dev-controls", 1, 1),
  },
  {
    id: "dev-value-mismatch",
    split: "development",
    family: "VALUE_ONLY_CONTROL",
    query: "Vega AcctB TierTwo",
    goldRowKey: rowKey("dev-mismatch", 1, 2),
  },
  {
    id: "dev-neg-nearby",
    split: "development",
    family: "NON_CAPTION_NEGATIVE",
    query: "Archived dispatch matrix Route RouteK Coordinator Sara Moon",
  },
  {
    id: "dev-neg-mismatch",
    split: "development",
    family: "NON_CAPTION_NEGATIVE",
    query: "Retired broker ledger Broker Orion Account AcctA",
  },
  {
    id: "dev-neg-cross-row",
    split: "development",
    family: "CROSS_ROW_NEGATIVE",
    query:
      "Blue release matrix Component API Owner Devon Price Slot SlotA",
  },
  {
    id: "dev-neg-cross-document",
    split: "development",
    family: "CROSS_DOCUMENT_NEGATIVE",
    query: "Approved certificate register Part Bolt77 Depot West",
  },
  {
    id: "hold-cap-lab-north",
    split: "heldout",
    family: "CAPTION_DISAMBIGUATION",
    query:
      "Turno de laboratorio norte Muestra MuestraA Analista Elena Ríos Horario Mañana",
    goldRowKey: rowKey("hold-lab", 201, 1),
  },
  {
    id: "hold-cap-lab-south",
    split: "heldout",
    family: "CAPTION_DISAMBIGUATION",
    query:
      "Turno de laboratorio sur Muestra MuestraA Analista Elena Ríos Horario Mañana",
    goldRowKey: rowKey("hold-lab", 202, 1),
  },
  {
    id: "hold-cap-weather-day",
    split: "heldout",
    family: "CAPTION_DISAMBIGUATION",
    query:
      "Day sensor register Sensor SensorA Technician Claire Snow Window Dawn",
    goldRowKey: rowKey("hold-weather", 211, 1),
  },
  {
    id: "hold-cap-weather-night",
    split: "heldout",
    family: "CAPTION_DISAMBIGUATION",
    query:
      "Night sensor register Sensor SensorA Technician Claire Snow Window Dawn",
    goldRowKey: rowKey("hold-weather", 212, 1),
  },
  {
    id: "hold-cap-school-ordinary",
    split: "heldout",
    family: "CAPTION_DISAMBIGUATION",
    query:
      "Matrícula ordinaria Programa Ingeniería Tutor Lucia Paz Cupo Treinta",
    goldRowKey: rowKey("hold-school", 221, 1),
  },
  {
    id: "hold-cap-school-special",
    split: "heldout",
    family: "CAPTION_DISAMBIGUATION",
    query:
      "Matrícula especial Programa Ingeniería Tutor Lucia Paz Cupo Treinta",
    goldRowKey: rowKey("hold-school", 222, 1),
  },
  {
    id: "hold-header-control",
    split: "heldout",
    family: "HEADER_VALUE_CONTROL",
    query: "Producto Estaño Depósito Sur Lote LoteVerde",
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
    query: "Ilo OpTwo Waiting",
    goldRowKey: rowKey("hold-mismatch", 1, 2),
  },
  {
    id: "hold-neg-nearby",
    split: "heldout",
    family: "NON_CAPTION_NEGATIVE",
    query: "Historic staffing grid Team Platform Lead Sofia Vega",
  },
  {
    id: "hold-neg-mismatch",
    split: "heldout",
    family: "NON_CAPTION_NEGATIVE",
    query: "Archived dock registry Port Matarani Operator OpOne",
  },
  {
    id: "hold-neg-cross-row",
    split: "heldout",
    family: "CROSS_ROW_NEGATIVE",
    query:
      "Turno de laboratorio norte Muestra MuestraA Analista Pablo León Horario Mañana",
  },
  {
    id: "hold-neg-cross-document",
    split: "heldout",
    family: "CROSS_DOCUMENT_NEGATIVE",
    query: "Night sensor register Producto Cobre Depósito Norte",
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
  const explicit = process.env.AKP_TABLE_ROW_STRUCTURED_CONTEXT_CANDIDATE_SHA?.trim();
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
    meanReciprocalRank: mean(ranks.map((rank) => (rank > 0 ? 1 / rank : 0))),
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
      structuredContext: string;
      captioned: boolean;
    }> = [];

    let explicitCaptionRows = 0;
    for (const document of DOCUMENTS) {
      const units = parseKnowledgeUnits(document.title, document.source);
      const projections = projectTableRows(document.title, document.source);
      for (const projection of projections) {
        const expectedCaption =
          document.expectedCaptions[projection.tableIndex];
        if ((projection.caption ?? undefined) !== expectedCaption) {
          throw new Error(
            "Caption binding mismatch for " +
              document.id +
              " table " +
              projection.tableIndex +
              ": expected " +
              String(expectedCaption) +
              " got " +
              String(projection.caption),
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
          structuredContext: projection.lexicalText,
          captioned,
        });
      }
    }

    const changedRows = rows.filter(
      (row) => row.structuredContext.length > 0,
    ).length;

    for (const row of rows) {
      for (const arm of ["raw-row", "structured-row-context"] as const) {
        const context =
          arm === "structured-row-context" ? row.structuredContext : "";
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
    for (const arm of ["raw-row", "structured-row-context"] as const) {
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
    const candidate = summaries["structured-row-context"];
    const familyRecall = (summary: SplitSummary, family: Family) =>
      summary.byFamily[family].recallAt1 ?? 0;
    const negativeRate = (summary: SplitSummary) =>
      summary.falseFullRowMatchRate ?? 0;

    const gates = {
      captionBindingMatchesFrozenFixture: true,
      changedRowsExactlyAllRows:
        changedRows === rows.length && changedRows > 0,
      developmentCaptionRecallImproves:
        familyRecall(candidate.development, "CAPTION_DISAMBIGUATION") >
          familyRecall(baseline.development, "CAPTION_DISAMBIGUATION") &&
        familyRecall(candidate.development, "CAPTION_DISAMBIGUATION") >= 0.75,
      heldoutCaptionRecallImproves:
        familyRecall(candidate.heldout, "CAPTION_DISAMBIGUATION") >
          familyRecall(baseline.heldout, "CAPTION_DISAMBIGUATION") &&
        familyRecall(candidate.heldout, "CAPTION_DISAMBIGUATION") >= 0.8,
      heldoutCaptionRecallAt3AtLeastNinety:
        (candidate.heldout.byFamily.CAPTION_DISAMBIGUATION.recallAt3 ?? 0) >=
        0.9,
      developmentHeaderControlsImprove:
        familyRecall(candidate.development, "HEADER_VALUE_CONTROL") >
          familyRecall(baseline.development, "HEADER_VALUE_CONTROL") &&
        familyRecall(candidate.development, "HEADER_VALUE_CONTROL") >= 0.5,
      heldoutHeaderControlsImprove:
        familyRecall(candidate.heldout, "HEADER_VALUE_CONTROL") >
          familyRecall(baseline.heldout, "HEADER_VALUE_CONTROL") &&
        familyRecall(candidate.heldout, "HEADER_VALUE_CONTROL") >= 0.5,
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
      schemaVersion: "akp.table-row-structured-context-parity.v1",
      generatedAt: new Date().toISOString(),
      outcome,
      promotionScope: "structured-row-context-experiment-only",
      productionDefaultsChanged: false,
      activationEnabled: false,
      independentVariable:
        "TableRowProjection.lexicalText as separate TABLE_ROW lexical context",
      baseline: "canonical TABLE_ROW lexical fields",
      candidate:
        "canonical TABLE_ROW lexical fields plus TableRowProjection.lexicalText at body weight",
      runtimeParity: {
        queryParser: "plainto_tsquery('simple')",
        documentEligibility:
          "document lexical match OR full unit lexical match",
        documentScore: "20*title + 2*document-body + best-unit-score",
        unitScore:
          "12*heading + 8*unit-metadata + body + structured-row-context",
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
        freshAfterExperiment: "#79",
        corpusDocuments: DOCUMENTS.length,
        corpusRows: rows.length,
        explicitCaptionRows,
        structuredContextRows: changedRows,
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
        "exact count of rows receiving structured row context",
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
        "PROMOTE would justify only a separate schema/index/query wiring experiment for TABLE_ROW structured lexical context with the feature off by default. It would not close R5/R6/R7/R9.",
    };

    const output = path.resolve(
      process.env.AKP_TABLE_ROW_STRUCTURED_CONTEXT_REPORT ??
        "reports/ci/table-row-structured-context-parity.json",
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
