import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const outputPath = path.resolve(
  process.env.AKP_FILTERED_ANN_REPORT ??
    "reports/ci/filtered-ann-baseline.json",
);
const dimensions = 64;
const topK = 5;
const vaultA = "40000000-0000-4000-8000-000000000001";
const vaultB = "40000000-0000-4000-8000-000000000002";
const vaultC = "40000000-0000-4000-8000-000000000003";

type ProbeRow = {
  vaultId: string;
  path: string;
  externalId: string;
  content: string;
  embedding: number[];
};

type SearchRow = {
  id: string;
  vault_id: string;
  path: string;
  external_id: string;
  distance: number;
};

type SearchMode = "EXACT" | "HNSW_FILTERED" | "HNSW_ITERATIVE" | "HNSW_PARTIAL";

type ScenarioMeasurement = {
  scenario: string;
  mode: SearchMode;
  queries: number;
  meanRecallAtK: number;
  minimumRecallAtK: number;
  meanReturned: number;
  leakageCount: number;
  planIndexNames: string[];
};

function normalize(values: number[]): number[] {
  const magnitude = Math.sqrt(
    values.reduce((sum, value) => sum + value * value, 0),
  );
  return values.map((value) => value / magnitude);
}

function clusterVector(
  cluster: number,
  noise: number,
  variant: number,
): number[] {
  const values = Array.from({ length: dimensions }, () => 0);
  values[cluster] = 1;
  values[16 + ((cluster + variant) % 32)] = noise;
  values[48 + (variant % 16)] = noise * 0.35;
  return normalize(values);
}

function backgroundVector(seed: number): number[] {
  const values = Array.from({ length: dimensions }, (_, index) => {
    const raw =
      Math.sin((seed + 1) * (index + 3) * 0.731) +
      Math.cos((seed + 7) * (index + 1) * 0.193);
    return raw;
  });
  return normalize(values);
}

function vectorLiteral(values: number[]): string {
  return `[${values.map((value) => value.toFixed(9)).join(",")}]`;
}

function buildRows(): { rows: ProbeRow[]; queries: number[][] } {
  const rows: ProbeRow[] = [];
  const queries: number[][] = [];

  for (let cluster = 0; cluster < 8; cluster += 1) {
    queries.push(clusterVector(cluster, 0, 0));

    for (let rank = 0; rank < 10; rank += 1) {
      const externalId = `shared-symbol-${cluster}-${rank}`;
      rows.push({
        vaultId: vaultA,
        path: `authorized/cluster-${cluster}/target-${rank}.md`,
        externalId,
        content: `shared context cluster ${cluster} target ${rank}`,
        embedding: clusterVector(cluster, 0.04 + rank * 0.003, rank),
      });

      rows.push({
        vaultId: vaultB,
        path: `authorized/cluster-${cluster}/duplicate-${rank}.md`,
        externalId,
        content: `shared context cluster ${cluster} target ${rank}`,
        embedding: clusterVector(cluster, 0.004 + rank * 0.0002, rank + 1),
      });
    }

    for (let rank = 0; rank < 24; rank += 1) {
      rows.push({
        vaultId: vaultA,
        path: `private/cluster-${cluster}/decoy-${rank}.md`,
        externalId: `private-decoy-${cluster}-${rank}`,
        content: `private decoy cluster ${cluster} ${rank}`,
        embedding: clusterVector(cluster, 0.006 + rank * 0.00025, rank + 3),
      });
      rows.push({
        vaultId: vaultC,
        path: `authorized/cluster-${cluster}/decoy-${rank}.md`,
        externalId: `external-decoy-${cluster}-${rank}`,
        content: `external decoy cluster ${cluster} ${rank}`,
        embedding: clusterVector(cluster, 0.008 + rank * 0.00025, rank + 5),
      });
    }
  }

  for (let seed = 0; seed < 1200; seed += 1) {
    rows.push({
      vaultId: seed % 2 === 0 ? vaultB : vaultC,
      path: `background/${seed}.md`,
      externalId: `background-${seed}`,
      content: `background context ${seed}`,
      embedding: backgroundVector(seed),
    });
  }

  return { rows, queries };
}

async function insertRows(client: PoolClient, rows: ProbeRow[]): Promise<void> {
  const batchSize = 100;
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const values: unknown[] = [];
    const tuples = batch.map((row, index) => {
      const offset = index * 5;
      values.push(
        row.vaultId,
        row.path,
        row.externalId,
        row.content,
        vectorLiteral(row.embedding),
      );
      return `($${offset + 1}::uuid,$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5}::vector(64))`;
    });
    await client.query(
      `insert into p0_filtered_ann_probe(vault_id,path,external_id,content,embedding)
       values ${tuples.join(",")}`,
      values,
    );
  }
}

function collectIndexNames(plan: unknown): string[] {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record["Index Name"] === "string")
      names.add(record["Index Name"]);
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(plan);
  return [...names].sort();
}

async function configureMode(
  client: PoolClient,
  mode: SearchMode,
): Promise<void> {
  await client.query("set enable_bitmapscan=off");
  if (mode === "EXACT") {
    await client.query("set enable_indexscan=off");
    await client.query("set enable_seqscan=on");
    return;
  }

  await client.query("set enable_indexscan=on");
  await client.query("set enable_seqscan=off");
  await client.query("set hnsw.ef_search=8");
  if (mode === "HNSW_ITERATIVE") {
    await client.query("set hnsw.iterative_scan='strict_order'");
    await client.query("set hnsw.max_scan_tuples=20000");
  } else {
    await client.query("set hnsw.iterative_scan='off'");
  }
}

async function search(
  client: PoolClient,
  query: number[],
  pathPattern: string,
): Promise<SearchRow[]> {
  const result = await client.query<SearchRow>(
    `select id::text,vault_id::text,path,external_id,
            (embedding <=> $1::vector(64))::float8 as distance
       from p0_filtered_ann_probe
      where vault_id=$2::uuid and path like $3
      order by embedding <=> $1::vector(64)
      limit $4`,
    [vectorLiteral(query), vaultA, pathPattern, topK],
  );
  return result.rows;
}

async function explain(
  client: PoolClient,
  query: number[],
  pathPattern: string,
): Promise<string[]> {
  const result = await client.query<{ "QUERY PLAN": unknown }>(
    `explain (format json)
     select id
       from p0_filtered_ann_probe
      where vault_id='${vaultA}'::uuid and path like '${pathPattern}'
      order by embedding <=> '${vectorLiteral(query)}'::vector(64)
      limit ${topK}`,
  );
  return collectIndexNames(result.rows[0]?.["QUERY PLAN"]);
}

function recall(expected: SearchRow[], actual: SearchRow[]): number {
  const expectedIds = new Set(expected.map((row) => row.id));
  if (expectedIds.size === 0) return 1;
  const hits = actual.filter((row) => expectedIds.has(row.id)).length;
  return hits / expectedIds.size;
}

async function measureScenario(
  client: PoolClient,
  queries: number[][],
  exactResults: SearchRow[][],
  scenario: string,
  pathPattern: string,
  mode: SearchMode,
): Promise<ScenarioMeasurement> {
  await configureMode(client, mode);
  const recalls: number[] = [];
  const returned: number[] = [];
  let leakageCount = 0;
  const planIndexNames = new Set<string>();

  for (let index = 0; index < queries.length; index += 1) {
    const actual = await search(client, queries[index]!, pathPattern);
    recalls.push(recall(exactResults[index]!, actual));
    returned.push(actual.length);
    leakageCount += actual.filter(
      (row) =>
        row.vault_id !== vaultA ||
        (pathPattern === "authorized/%" && !row.path.startsWith("authorized/")),
    ).length;
    const names = await explain(client, queries[index]!, pathPattern);
    names.forEach((name) => planIndexNames.add(name));
  }

  return {
    scenario,
    mode,
    queries: queries.length,
    meanRecallAtK:
      recalls.reduce((sum, value) => sum + value, 0) / recalls.length,
    minimumRecallAtK: Math.min(...recalls),
    meanReturned:
      returned.reduce((sum, value) => sum + value, 0) / returned.length,
    leakageCount,
    planIndexNames: [...planIndexNames].sort(),
  };
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();
try {
  const extension = await client.query<{ extversion: string }>(
    "select extversion from pg_extension where extname='vector'",
  );
  if (!extension.rows[0])
    throw new Error("pgvector extension is not installed.");

  await client.query(`
    create temp table p0_filtered_ann_probe(
      id bigserial primary key,
      vault_id uuid not null,
      path text not null,
      external_id text not null,
      content text not null,
      embedding vector(64) not null
    )
  `);
  const fixture = buildRows();
  await insertRows(client, fixture.rows);
  await client.query("analyze p0_filtered_ann_probe");

  await configureMode(client, "EXACT");
  const exactVault = [] as SearchRow[][];
  const exactAuthorized = [] as SearchRow[][];
  for (const query of fixture.queries) {
    exactVault.push(await search(client, query, "%"));
    exactAuthorized.push(await search(client, query, "authorized/%"));
  }

  await client.query(
    "create index p0_filtered_ann_hnsw_idx on p0_filtered_ann_probe using hnsw (embedding vector_cosine_ops)",
  );
  await client.query("analyze p0_filtered_ann_probe");

  const measurements: ScenarioMeasurement[] = [];
  measurements.push(
    await measureScenario(
      client,
      fixture.queries,
      exactVault,
      "VAULT_FILTER",
      "%",
      "HNSW_FILTERED",
    ),
  );
  measurements.push(
    await measureScenario(
      client,
      fixture.queries,
      exactAuthorized,
      "VAULT_PLUS_PATH_ACL",
      "authorized/%",
      "HNSW_FILTERED",
    ),
  );

  let iterativeScanSupported = true;
  try {
    measurements.push(
      await measureScenario(
        client,
        fixture.queries,
        exactAuthorized,
        "VAULT_PLUS_PATH_ACL",
        "authorized/%",
        "HNSW_ITERATIVE",
      ),
    );
  } catch (error) {
    iterativeScanSupported = false;
    console.warn(
      `hnsw.iterative_scan unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  await client.query("drop index p0_filtered_ann_hnsw_idx");
  await client.query(`
    create index p0_filtered_ann_authorized_idx
      on p0_filtered_ann_probe using hnsw (embedding vector_cosine_ops)
      where vault_id='${vaultA}'::uuid and path like 'authorized/%'
  `);
  await client.query("analyze p0_filtered_ann_probe");
  measurements.push(
    await measureScenario(
      client,
      fixture.queries,
      exactAuthorized,
      "VAULT_PLUS_PATH_ACL",
      "authorized/%",
      "HNSW_PARTIAL",
    ),
  );

  const leakageCount = measurements.reduce(
    (sum, measurement) => sum + measurement.leakageCount,
    0,
  );
  if (leakageCount !== 0) {
    throw new Error(
      `Filtered ANN baseline observed ${leakageCount} leaked rows.`,
    );
  }

  const report = {
    schemaVersion: 1,
    evidenceLevel: "P0_FILTERED_ANN_BASELINE",
    status: "PROVEN",
    productionDefaultChanged: false,
    productionIndexSelected: false,
    claimBoundary:
      "This measures pgvector filtered ANN behavior on an isolated adversarial fixture. It does not select a production ANN strategy or claim semantic quality on the registered product corpus.",
    pgvectorVersion: extension.rows[0].extversion,
    fixture: {
      dimensions,
      rows: fixture.rows.length,
      queryCount: fixture.queries.length,
      topK,
      duplicateIdentifiersAcrossVaults: true,
      duplicateTextAcrossVaults: true,
      restrictivePathAcl: "authorized/%",
      adversarialCloserUnauthorizedNeighbors: true,
    },
    iterativeScanSupported,
    measurements,
    alternatives: {
      iterativeScan: iterativeScanSupported ? "MEASURED" : "UNAVAILABLE",
      partialIndex: "MEASURED",
      partitioning: "DEFERRED",
    },
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  client.release();
  await pool.end();
}
