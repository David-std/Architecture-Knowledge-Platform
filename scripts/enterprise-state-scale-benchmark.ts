/**
 * P11 enterprise-state scale benchmark.
 *
 * Complements the 1K-100K corpus harness with dimensions whose cardinality is
 * not proportional to document count: federated graph/code state, temporal
 * facts, external work items, durable agent sessions and federation peers.
 * All fixture writes execute in one transaction and are rolled back.
 */
import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import pg from "pg";

type Numeric = number | string;

type Stats = {
  samples: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
};

type MemorySnapshot = {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
};

type StorageSnapshot = {
  databaseBytes: number;
  graphNodesBytes: number;
  graphEdgesBytes: number;
  temporalFactsBytes: number;
  workItemsBytes: number;
  agentSessionsBytes: number;
  federationPeersBytes: number;
};

type DimensionCounts = {
  epistemicGraphNodes: number;
  epistemicGraphEdges: number;
  codeSymbols: number;
  codeEdges: number;
  temporalFacts: number;
  workItems: number;
  agentSessions: number;
  federationPeers: number;
};

type Fixture = {
  runId: string;
  organizationId: string;
  spaceId: string;
  vaultId: string;
  truthRevisionHash: string;
};

type QueryMeasurement = {
  name: string;
  description: string;
  latency: Stats;
  rowsObserved: number[];
};

type TargetResult = {
  target: number;
  expected: DimensionCounts;
  observed: DimensionCounts;
  incremental: {
    previousTarget: number;
    addedEnterpriseRows: number;
    totalWriteMs: number;
    indexedWriteThroughputPerSecond: number;
  };
  writesMs: {
    epistemicNodes: number;
    epistemicEdges: number;
    codeSymbols: number;
    codeEdges: number;
    temporalFacts: number;
    workItems: number;
    agentSessions: number;
    federationPeers: number;
    analyze: number;
  };
  queryLatency: QueryMeasurement[];
  memory: {
    before: MemorySnapshot;
    after: MemorySnapshot;
    rssDeltaBytes: number;
    heapDeltaBytes: number;
  };
  storage: {
    before: StorageSnapshot;
    after: StorageSnapshot;
    delta: StorageSnapshot;
  };
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const args = process.argv.slice(2);

function argValue(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received ${value}`);
  }
  return parsed;
}

function parseTargets(value: string | undefined): number[] {
  const targets = (value ?? "100,1000,5000")
    .split(",")
    .map((entry) => positiveInteger(entry.trim(), 1));
  if (targets.length === 0) throw new Error("At least one target is required");
  if (targets.some((target) => target > 50_000)) {
    throw new Error("Enterprise-state targets above 50,000 are refused");
  }
  for (let index = 1; index < targets.length; index += 1) {
    if ((targets[index] ?? 0) <= (targets[index - 1] ?? 0)) {
      throw new Error("Enterprise-state targets must be strictly ascending");
    }
  }
  return targets;
}

const outputPath = path.resolve(
  argValue("--output") ?? "reports/scale/enterprise-state-scale-benchmark.json",
);
const targets = parseTargets(argValue("--targets"));
const iterations = positiveInteger(argValue("--iterations"), 20);
const seed = argValue("--seed") ?? "akp-enterprise-state-v1";

const client = new pg.Client({
  connectionString: databaseUrl,
  statement_timeout: 180_000,
});

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function asNumber(value: Numeric | null | undefined): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) throw new Error("Non-numeric database value");
  return parsed;
}

function summarize(samples: number[]): Stats {
  if (samples.length === 0) throw new Error("Cannot summarize zero samples");
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction: number): number => {
    const index = Math.max(
      0,
      Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1),
    );
    const value = sorted[index];
    if (value === undefined) throw new Error("Percentile outside sample set");
    return value;
  };
  return {
    samples: sorted.length,
    minMs: rounded(sorted[0] ?? 0),
    p50Ms: rounded(percentile(0.5)),
    p95Ms: rounded(percentile(0.95)),
    p99Ms: rounded(percentile(0.99)),
    maxMs: rounded(sorted[sorted.length - 1] ?? 0),
    meanMs: rounded(
      sorted.reduce((total, sample) => total + sample, 0) / sorted.length,
    ),
  };
}

function memorySnapshot(): MemorySnapshot {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function agentTarget(target: number): number {
  return Math.min(256, Math.max(4, Math.ceil(target / 40)));
}

function peerTarget(target: number): number {
  return Math.min(128, Math.max(4, Math.ceil(target / 100)));
}

function expectedCounts(target: number): DimensionCounts {
  return {
    epistemicGraphNodes: target,
    epistemicGraphEdges: Math.max(0, target - 1),
    codeSymbols: target,
    codeEdges: Math.max(0, target - 1),
    temporalFacts: target,
    workItems: target,
    agentSessions: agentTarget(target),
    federationPeers: peerTarget(target),
  };
}

async function timedQuery(
  text: string,
  values: unknown[] = [],
): Promise<number> {
  const started = performance.now();
  await client.query(text, values);
  return performance.now() - started;
}

async function createFixture(): Promise<Fixture> {
  const runId = randomUUID();
  const compact = runId.replaceAll("-", "").slice(0, 12);
  const organizationId = randomUUID();
  const spaceId = randomUUID();
  const vaultId = randomUUID();
  const truthRevisionHash = hash(`${seed}:${runId}:truth`);

  await client.query(
    "insert into organizations(id,slug,name) values($1,$2,$3)",
    [
      organizationId,
      `enterprise-scale-${compact}`,
      `Enterprise state scale ${runId}`,
    ],
  );
  await client.query(
    `insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values($1,$2,$3,$4,'PRIVATE',$5)`,
    [
      spaceId,
      organizationId,
      `enterprise-scale-${compact}`,
      `Enterprise state scale ${runId}`,
      `benchmark/enterprise/${runId}`,
    ],
  );
  await client.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,vault_key,
       local_path,visibility,enabled
     ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)`,
    [
      vaultId,
      spaceId,
      `benchmark/enterprise/${runId}/vault`,
      "Enterprise scale vault",
      `enterprise-${runId}`,
      `enterprise-${compact}`,
    ],
  );
  await client.query(
    `insert into truth_revisions(
       id,space_id,vault_id,revision_seq,revision_hash,parent_revision_hash,
       reason,resource_type,resource_id
     ) values($1,$2,$3,1,$4,null,'ENTERPRISE_SCALE_BENCHMARK',
              'BENCHMARK','enterprise-state')`,
    [randomUUID(), spaceId, vaultId, truthRevisionHash],
  );
  await client.query(
    `insert into truth_revision_heads(
       vault_id,space_id,revision_seq,revision_hash
     ) values($1,$2,1,$3)`,
    [vaultId, spaceId, truthRevisionHash],
  );

  return { runId, organizationId, spaceId, vaultId, truthRevisionHash };
}

function nodeInsertSql(domain: "EPISTEMIC" | "CODE", kind: string): string {
  return `
    insert into federated_graph_nodes(
      space_id,vault_id,graph_domain,scope_id,kind,canonical_key,revision,
      authorization_path,payload,payload_hash
    )
    select $1,$2,$3,$4,$5,
           $6 || i::text,$7,'benchmark',
           jsonb_build_object('benchmark',true,'ordinal',i),
           encode(digest($8 || ':' || $3 || ':node:' || i::text,'sha256'),'hex')
      from generate_series($9::int,$10::int) generated(i)
  `;
}

async function insertNodes(
  fixture: Fixture,
  domain: "EPISTEMIC" | "CODE",
  kind: string,
  prefix: string,
  start: number,
  end: number,
): Promise<number> {
  if (start > end) return 0;
  return timedQuery(nodeInsertSql(domain, kind), [
    fixture.spaceId,
    fixture.vaultId,
    domain,
    `vault:${fixture.vaultId}`,
    kind,
    prefix,
    `enterprise:${fixture.runId}`,
    fixture.runId,
    start,
    end,
  ]);
}

async function insertEdges(
  fixture: Fixture,
  domain: "EPISTEMIC" | "CODE",
  prefix: string,
  startOrdinal: number,
  endOrdinal: number,
): Promise<number> {
  if (startOrdinal > endOrdinal) return 0;
  return timedQuery(
    `insert into federated_graph_edges(
       space_id,owner_graph_domain,from_node_id,to_node_id,relation_type,
       authorization_path,derivation,source_ids,evidence_ids,locator_refs,
       provenance_revision,confidence,recorded_at,provenance_hash
     )
     select $1,$2,source_node.id,target_node.id,
            case when $2='CODE' then 'CALLS' else 'RELATED_TO' end,
            'benchmark','DETERMINISTIC_EXTRACTED','[]'::jsonb,'[]'::jsonb,
            '[]'::jsonb,$3,1.0,now(),
            encode(digest($4 || ':' || $2 || ':edge:' || i::text,'sha256'),'hex')
       from generate_series($5::int,$6::int) generated(i)
       join federated_graph_nodes source_node
         on source_node.space_id=$1
        and source_node.graph_domain=$2
        and source_node.canonical_key=$7 || i::text
        and source_node.revision=$3
       join federated_graph_nodes target_node
         on target_node.space_id=$1
        and target_node.graph_domain=$2
        and target_node.canonical_key=$7 || (i+1)::text
        and target_node.revision=$3`,
    [
      fixture.spaceId,
      domain,
      `enterprise:${fixture.runId}`,
      fixture.runId,
      startOrdinal,
      endOrdinal,
      prefix,
    ],
  );
}

async function insertTemporalFacts(
  fixture: Fixture,
  start: number,
  end: number,
): Promise<number> {
  if (start > end) return 0;
  return timedQuery(
    `with generated as (
       select i,gen_random_uuid() support_id,gen_random_uuid() fact_id
         from generate_series($5::int,$6::int) generated(i)
     ), support_insert as (
       insert into truth_support_sets(
         id,space_id,vault_id,state,source_revision_hashes
       )
       select support_id,$1,$2,'SUPPORTED',
              array[encode(digest($4 || ':support:' || i::text,'sha256'),'hex')]
         from generated
       returning id
     )
     insert into temporal_facts(
       id,space_id,vault_id,scope_id,authorization_path,subject_ref,predicate,
       object,valid_from,valid_to,recorded_at,source_episode_id,support_set_id,
       lifecycle,truth_revision_hash,truth_revision_seq
     )
     select g.fact_id,$1,$2,$3,'benchmark',
            'benchmark:subject:' || g.i::text,'state',
            jsonb_build_object('ordinal',g.i,'benchmark',true),
            timestamptz '2026-01-01 00:00:00+00'
              + g.i * interval '1 second',
            null,
            timestamptz '2026-01-01 00:00:00+00'
              + g.i * interval '1 second',
            null,g.support_id,'ACTIVE',$7,1
       from generated g
       join support_insert s on s.id=g.support_id`,
    [
      fixture.spaceId,
      fixture.vaultId,
      `vault:${fixture.vaultId}`,
      fixture.runId,
      start,
      end,
      fixture.truthRevisionHash,
    ],
  );
}

async function insertWorkItems(
  fixture: Fixture,
  start: number,
  end: number,
): Promise<number> {
  if (start > end) return 0;
  return timedQuery(
    `insert into external_object_refs(
       space_id,vault_id,provider,object_type,external_id,canonical_url,
       source_revision,title,authority,metadata
     )
     select $1,$2,'benchmark','WORK_ITEM',
            'work-' || i::text,
            'https://benchmark.invalid/work/' || i::text,
            $3,
            'Benchmark work item ' || i::text,
            'REFERENCE',
            jsonb_build_object('benchmark',true,'ordinal',i)
       from generate_series($4::int,$5::int) generated(i)`,
    [
      fixture.spaceId,
      fixture.vaultId,
      `enterprise:${fixture.runId}`,
      start,
      end,
    ],
  );
}

async function insertAgentSessions(
  fixture: Fixture,
  start: number,
  end: number,
): Promise<number> {
  if (start > end) return 0;
  return timedQuery(
    `insert into agent_sessions(
       space_id,vault_id,actor_id,project_id,purpose,context_budget,state
     )
     select $1,$2,null,null,
            'enterprise-scale-agent-' || i::text,
            4096,
            jsonb_build_object(
              'benchmarkRunId',$3::text,
              'ordinal',i,
              'status','ACTIVE'
            )
       from generate_series($4::int,$5::int) generated(i)`,
    [fixture.spaceId, fixture.vaultId, fixture.runId, start, end],
  );
}

async function insertPeers(
  fixture: Fixture,
  start: number,
  end: number,
): Promise<number> {
  if (start > end) return 0;
  return timedQuery(
    `insert into context_fabric_peers(
       organization_id,space_id,peer_key,display_name,endpoint,discovery_mode,
       trust_state,capabilities,revision,last_seen_at
     )
     select $1,$2,'benchmark-peer-' || i::text,
            'Benchmark peer ' || i::text,
            null,'CATALOG_ONLY','APPROVED',
            '{"schemaVersion":1,"federationModes":["CATALOG_ONLY"]}'::jsonb,
            $3,now()
       from generate_series($4::int,$5::int) generated(i)`,
    [
      fixture.organizationId,
      fixture.spaceId,
      `enterprise:${fixture.runId}`,
      start,
      end,
    ],
  );
}

async function countFixture(fixture: Fixture): Promise<DimensionCounts> {
  const result = await client.query<Record<keyof DimensionCounts, Numeric>>(
    `select
      (select count(*) from federated_graph_nodes
        where space_id=$1 and graph_domain='EPISTEMIC')::bigint
        as "epistemicGraphNodes",
      (select count(*) from federated_graph_edges
        where space_id=$1 and owner_graph_domain='EPISTEMIC')::bigint
        as "epistemicGraphEdges",
      (select count(*) from federated_graph_nodes
        where space_id=$1 and graph_domain='CODE')::bigint
        as "codeSymbols",
      (select count(*) from federated_graph_edges
        where space_id=$1 and owner_graph_domain='CODE')::bigint
        as "codeEdges",
      (select count(*) from temporal_facts where vault_id=$2)::bigint
        as "temporalFacts",
      (select count(*) from external_object_refs
        where vault_id=$2 and provider='benchmark')::bigint
        as "workItems",
      (select count(*) from agent_sessions
        where space_id=$1 and state->>'benchmarkRunId'=$3)::bigint
        as "agentSessions",
      (select count(*) from context_fabric_peers
        where organization_id=$4 and space_id=$1)::bigint
        as "federationPeers"`,
    [
      fixture.spaceId,
      fixture.vaultId,
      fixture.runId,
      fixture.organizationId,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Enterprise benchmark counts unavailable");
  return {
    epistemicGraphNodes: asNumber(row.epistemicGraphNodes),
    epistemicGraphEdges: asNumber(row.epistemicGraphEdges),
    codeSymbols: asNumber(row.codeSymbols),
    codeEdges: asNumber(row.codeEdges),
    temporalFacts: asNumber(row.temporalFacts),
    workItems: asNumber(row.workItems),
    agentSessions: asNumber(row.agentSessions),
    federationPeers: asNumber(row.federationPeers),
  };
}

async function storageSnapshot(): Promise<StorageSnapshot> {
  const result = await client.query<Record<keyof StorageSnapshot, Numeric>>(
    `select
      pg_database_size(current_database())::bigint as "databaseBytes",
      pg_total_relation_size('federated_graph_nodes'::regclass)::bigint
        as "graphNodesBytes",
      pg_total_relation_size('federated_graph_edges'::regclass)::bigint
        as "graphEdgesBytes",
      pg_total_relation_size('temporal_facts'::regclass)::bigint
        as "temporalFactsBytes",
      pg_total_relation_size('external_object_refs'::regclass)::bigint
        as "workItemsBytes",
      pg_total_relation_size('agent_sessions'::regclass)::bigint
        as "agentSessionsBytes",
      pg_total_relation_size('context_fabric_peers'::regclass)::bigint
        as "federationPeersBytes"`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("Storage snapshot unavailable");
  return {
    databaseBytes: asNumber(row.databaseBytes),
    graphNodesBytes: asNumber(row.graphNodesBytes),
    graphEdgesBytes: asNumber(row.graphEdgesBytes),
    temporalFactsBytes: asNumber(row.temporalFactsBytes),
    workItemsBytes: asNumber(row.workItemsBytes),
    agentSessionsBytes: asNumber(row.agentSessionsBytes),
    federationPeersBytes: asNumber(row.federationPeersBytes),
  };
}

function subtractStorage(
  after: StorageSnapshot,
  before: StorageSnapshot,
): StorageSnapshot {
  return Object.fromEntries(
    Object.keys(after).map((key) => [
      key,
      Math.max(
        0,
        after[key as keyof StorageSnapshot] -
          before[key as keyof StorageSnapshot],
      ),
    ]),
  ) as StorageSnapshot;
}

async function measureQuery(
  name: string,
  description: string,
  text: string,
  values: unknown[],
): Promise<QueryMeasurement> {
  const samples: number[] = [];
  const rowsObserved: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    const result = await client.query(text, values);
    samples.push(performance.now() - started);
    rowsObserved.push(result.rowCount ?? result.rows.length);
  }
  return {
    name,
    description,
    latency: summarize(samples),
    rowsObserved,
  };
}

async function queryMeasurements(
  fixture: Fixture,
  target: number,
): Promise<QueryMeasurement[]> {
  const midpoint = Math.max(1, Math.floor(target / 2));
  return Promise.all([
    measureQuery(
      "epistemic-neighborhood",
      "Indexed epistemic node lookup followed by outgoing-edge expansion.",
      `select e.id
         from federated_graph_nodes n
         join federated_graph_edges e on e.from_node_id=n.id
        where n.space_id=$1 and n.graph_domain='EPISTEMIC'
          and n.canonical_key=$2 and e.owner_graph_domain='EPISTEMIC'`,
      [fixture.spaceId, `epistemic:${midpoint}`],
    ),
    measureQuery(
      "code-symbol-neighborhood",
      "Indexed CODE symbol lookup followed by CALLS edge expansion.",
      `select e.id
         from federated_graph_nodes n
         join federated_graph_edges e on e.from_node_id=n.id
        where n.space_id=$1 and n.graph_domain='CODE'
          and n.canonical_key=$2 and e.owner_graph_domain='CODE'`,
      [fixture.spaceId, `code:symbol:${midpoint}`],
    ),
    measureQuery(
      "temporal-current-fact",
      "Current temporal fact lookup by vault, subject and predicate.",
      `select id,object
         from temporal_facts
        where vault_id=$1 and subject_ref=$2 and predicate='state'
          and valid_from<=now() and (valid_to is null or valid_to>now())
        order by truth_revision_seq desc,recorded_at desc
        limit 10`,
      [fixture.vaultId, `benchmark:subject:${midpoint}`],
    ),
    measureQuery(
      "work-item-lookup",
      "Indexed external work-item lookup using provider/type/external id.",
      `select id,title
         from external_object_refs
        where vault_id=$1 and provider='benchmark'
          and object_type='WORK_ITEM' and external_id=$2`,
      [fixture.vaultId, `work-${midpoint}`],
    ),
    measureQuery(
      "agent-session-scan",
      "Recent durable agent-session state for the benchmark workspace.",
      `select id
         from agent_sessions
        where space_id=$1 and state->>'benchmarkRunId'=$2
        order by updated_at desc
        limit 50`,
      [fixture.spaceId, fixture.runId],
    ),
    measureQuery(
      "federation-peer-catalog",
      "Approved federation-peer catalog lookup for one team space.",
      `select id,peer_key
         from context_fabric_peers
        where space_id=$1 and trust_state='APPROVED'
        order by updated_at desc
        limit 100`,
      [fixture.spaceId],
    ),
  ]);
}

async function analyzeEnterpriseTables(): Promise<number> {
  return timedQuery(
    `analyze federated_graph_nodes;
     analyze federated_graph_edges;
     analyze temporal_facts;
     analyze external_object_refs;
     analyze agent_sessions;
     analyze context_fabric_peers;`,
  );
}

async function measurePoolPressure(): Promise<{
  operations: number;
  poolMax: number;
  maxTotalCount: number;
  maxIdleCount: number;
  maxWaitingCount: number;
  throughputPerSecond: number;
  latency: Stats;
}> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  const latencies: number[] = [];
  let maxTotalCount = 0;
  let maxIdleCount = 0;
  let maxWaitingCount = 0;
  const operations = 32;
  const started = performance.now();
  const monitor = setInterval(() => {
    maxTotalCount = Math.max(maxTotalCount, pool.totalCount);
    maxIdleCount = Math.max(maxIdleCount, pool.idleCount);
    maxWaitingCount = Math.max(maxWaitingCount, pool.waitingCount);
  }, 2);
  try {
    await Promise.all(
      Array.from({ length: operations }, async (_, index) => {
        const operationStarted = performance.now();
        await pool.query("select pg_sleep(0.02),$1::int as ordinal", [index]);
        latencies.push(performance.now() - operationStarted);
      }),
    );
  } finally {
    clearInterval(monitor);
    maxTotalCount = Math.max(maxTotalCount, pool.totalCount);
    maxIdleCount = Math.max(maxIdleCount, pool.idleCount);
    maxWaitingCount = Math.max(maxWaitingCount, pool.waitingCount);
    await pool.end();
  }
  const elapsedSeconds = Math.max(0.001, (performance.now() - started) / 1000);
  return {
    operations,
    poolMax: 8,
    maxTotalCount,
    maxIdleCount,
    maxWaitingCount,
    throughputPerSecond: rounded(operations / elapsedSeconds),
    latency: summarize(latencies),
  };
}

async function main(): Promise<void> {
  await client.connect();
  let fixture: Fixture | undefined;
  let transactionOpen = false;
  let failure: string | undefined;
  let cleanupSucceeded = false;
  const results: TargetResult[] = [];
  const processMemoryBefore = memorySnapshot();
  let poolPressure:
    | Awaited<ReturnType<typeof measurePoolPressure>>
    | undefined;

  try {
    await client.query("begin");
    transactionOpen = true;
    fixture = await createFixture();

    let previousTarget = 0;
    let previousStorage = await storageSnapshot();
    for (const target of targets) {
      const expected = expectedCounts(target);
      const memoryBefore = memorySnapshot();
      const storageBefore = previousStorage;
      const writeStarted = performance.now();

      const epistemicNodes = await insertNodes(
        fixture,
        "EPISTEMIC",
        "CONCEPT",
        "epistemic:",
        previousTarget + 1,
        target,
      );
      const epistemicEdges = await insertEdges(
        fixture,
        "EPISTEMIC",
        "epistemic:",
        Math.max(1, previousTarget),
        target - 1,
      );
      const codeSymbols = await insertNodes(
        fixture,
        "CODE",
        "SYMBOL",
        "code:symbol:",
        previousTarget + 1,
        target,
      );
      const codeEdges = await insertEdges(
        fixture,
        "CODE",
        "code:symbol:",
        Math.max(1, previousTarget),
        target - 1,
      );
      const temporalFacts = await insertTemporalFacts(
        fixture,
        previousTarget + 1,
        target,
      );
      const workItems = await insertWorkItems(
        fixture,
        previousTarget + 1,
        target,
      );

      const previousAgents = agentTarget(previousTarget);
      const currentAgents = agentTarget(target);
      const agentSessions = await insertAgentSessions(
        fixture,
        previousTarget === 0 ? 1 : previousAgents + 1,
        currentAgents,
      );

      const previousPeers = peerTarget(previousTarget);
      const currentPeers = peerTarget(target);
      const federationPeers = await insertPeers(
        fixture,
        previousTarget === 0 ? 1 : previousPeers + 1,
        currentPeers,
      );

      const analyze = await analyzeEnterpriseTables();
      const totalWriteMs = performance.now() - writeStarted;
      const observed = await countFixture(fixture);
      const queries = await queryMeasurements(fixture, target);
      const memoryAfter = memorySnapshot();
      const storageAfter = await storageSnapshot();

      const addedEnterpriseRows =
        Math.max(0, target - previousTarget) * 6 +
        Math.max(0, currentAgents - previousAgents) +
        Math.max(0, currentPeers - previousPeers) -
        (previousTarget === 0 ? 2 : 0);

      results.push({
        target,
        expected,
        observed,
        incremental: {
          previousTarget,
          addedEnterpriseRows,
          totalWriteMs: rounded(totalWriteMs),
          indexedWriteThroughputPerSecond: rounded(
            addedEnterpriseRows /
              Math.max(0.001, totalWriteMs / 1000),
          ),
        },
        writesMs: {
          epistemicNodes: rounded(epistemicNodes),
          epistemicEdges: rounded(epistemicEdges),
          codeSymbols: rounded(codeSymbols),
          codeEdges: rounded(codeEdges),
          temporalFacts: rounded(temporalFacts),
          workItems: rounded(workItems),
          agentSessions: rounded(agentSessions),
          federationPeers: rounded(federationPeers),
          analyze: rounded(analyze),
        },
        queryLatency: queries,
        memory: {
          before: memoryBefore,
          after: memoryAfter,
          rssDeltaBytes: memoryAfter.rssBytes - memoryBefore.rssBytes,
          heapDeltaBytes: memoryAfter.heapUsedBytes - memoryBefore.heapUsedBytes,
        },
        storage: {
          before: storageBefore,
          after: storageAfter,
          delta: subtractStorage(storageAfter, storageBefore),
        },
      });

      previousTarget = target;
      previousStorage = storageAfter;
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (transactionOpen) {
      try {
        await client.query("rollback");
        transactionOpen = false;
      } catch (error) {
        failure ??= error instanceof Error ? error.message : String(error);
      }
    }
    if (fixture) {
      const remaining = await client.query<{ count: Numeric }>(
        "select count(*)::bigint count from organizations where id=$1",
        [fixture.organizationId],
      );
      cleanupSucceeded = asNumber(remaining.rows[0]?.count) === 0;
    }
    await client.end();
  }

  try {
    poolPressure = await measurePoolPressure();
  } catch (error) {
    failure ??= error instanceof Error ? error.message : String(error);
  }

  const exactRows =
    results.length === targets.length &&
    results.every(
      (result) =>
        JSON.stringify(result.expected) === JSON.stringify(result.observed),
    );
  const acceptance = {
    exactTargetSet:
      JSON.stringify(results.map((result) => result.target)) ===
      JSON.stringify(targets),
    exactDimensionRows: exactRows,
    rollbackCleanupSucceeded: cleanupSucceeded,
    p99Reported:
      results.length > 0 &&
      results.every((result) =>
        result.queryLatency.every(
          (measurement) => Number.isFinite(measurement.latency.p99Ms),
        ),
      ),
    poolBounded:
      Boolean(poolPressure) &&
      (poolPressure?.maxTotalCount ?? 99) <=
        (poolPressure?.poolMax ?? 0),
  };
  const status =
    !failure && Object.values(acceptance).every(Boolean) ? "PASSED" : "FAILED";
  const report = {
    schemaVersion: "akp.enterprise-state-scale-benchmark.v1",
    generatedAt: new Date().toISOString(),
    status,
    evidenceLevel: "SYNTHETIC_TRANSACTIONAL_ENTERPRISE_STATE",
    coverageStatus: "PARTIAL",
    execution: {
      nodeVersion: process.version,
      platform: process.platform,
      targets,
      iterations,
      seed,
      isolation:
        "single disposable PostgreSQL database; benchmark fixture is transactionally rolled back",
    },
    acceptance,
    results,
    dbPoolPressure: poolPressure,
    resources: {
      processMemoryBefore,
      processMemoryAfter: memorySnapshot(),
    },
    measured: [
      "EPISTEMIC federated graph nodes and edges at multiple scales",
      "CODE symbol-like nodes and CALLS edges at multiple scales",
      "Temporal facts and immutable support-set growth",
      "External work-item reference growth",
      "Durable agent-session state growth",
      "Federation peer catalog growth",
      "p50/p95/p99 query latency for indexed enterprise-state lookups",
      "Incremental indexed-write throughput and ANALYZE maintenance time",
      "Node process memory and PostgreSQL relation/database storage growth",
      "PostgreSQL client-pool saturation using a bounded 8-connection pool",
    ],
    notMeasured: [
      {
        dimension: "documents/units/vector rows",
        reason:
          "Covered by load-scale-benchmark at 1K, 10K, 50K and 100K document/unit/vector rows.",
      },
      {
        dimension: "concurrent agent request throughput and queue retry rate",
        reason:
          "Covered by concurrency-benchmark; this harness measures durable agent-session cardinality and DB pool pressure.",
      },
      {
        dimension: "remote federation network throughput",
        reason:
          "Peer catalog cardinality is measured here; network failure/timeout semantics belong to the P11 resilience suite.",
      },
    ],
    limitations: [
      "Synthetic local/team scale evidence is not an internet-scale SaaS capacity claim.",
      "Graph and CODE rows use the production federated graph schema but synthetic deterministic payloads.",
      "P99 uses the configured iteration count and is only meaningful when enough samples are requested.",
      "Storage is observed before transactional rollback; PostgreSQL may retain allocated pages after rollback in the disposable database.",
    ],
    cleanup: {
      mode: "TRANSACTION_ROLLBACK",
      succeeded: cleanupSucceeded,
    },
    ...(failure ? { failure } : {}),
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (status !== "PASSED") process.exitCode = 1;
}

await main();
