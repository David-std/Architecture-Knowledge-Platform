import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  claimNextIngestJob,
  Postgres,
} from "../packages/postgres/src/index.js";

type Stats = {
  samples: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
};

type MemorySnapshot = {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
};

type ApiMeasurement = {
  requests: number;
  concurrency: number;
  successes: number;
  failures: number;
  throughputPerSecond: number;
  latency: Stats;
  crossVaultViolations: string[];
};

type Fixture = {
  organizationId: string;
  userId: string;
  spaceId: string;
  vaultIds: string[];
  token: string;
  tokenHash: string;
  corpusRevision: string;
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const outputPath = path.resolve(
  process.env.AKP_CONCURRENCY_REPORT ?? "reports/ci/concurrency-benchmark.json",
);
const searchRequests = positiveInteger(
  process.env.AKP_CONCURRENCY_SEARCH_REQUESTS,
  64,
);
const searchConcurrency = positiveInteger(
  process.env.AKP_CONCURRENCY_SEARCH_WORKERS,
  8,
);
const contextRequests = positiveInteger(
  process.env.AKP_CONCURRENCY_CONTEXT_REQUESTS,
  32,
);
const contextConcurrency = positiveInteger(
  process.env.AKP_CONCURRENCY_CONTEXT_WORKERS,
  4,
);
const ingestJobs = positiveInteger(process.env.AKP_CONCURRENCY_INGEST_JOBS, 48);
const ingestWorkers = positiveInteger(
  process.env.AKP_CONCURRENCY_INGEST_WORKERS,
  6,
);

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received ${value}`);
  }
  return parsed;
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
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
  const minimum = sorted[0];
  const maximum = sorted[sorted.length - 1];
  if (minimum === undefined || maximum === undefined) {
    throw new Error("Cannot summarize zero samples");
  }
  return {
    samples: samples.length,
    minMs: rounded(minimum),
    p50Ms: rounded(percentile(0.5)),
    p95Ms: rounded(percentile(0.95)),
    maxMs: rounded(maximum),
    meanMs: rounded(
      samples.reduce((total, sample) => total + sample, 0) / samples.length,
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function collectVaultIds(
  value: unknown,
  target = new Set<string>(),
): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectVaultIds(entry, target));
    return target;
  }
  if (!value || typeof value !== "object") return target;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "vaultId" && typeof entry === "string") target.add(entry);
    if (key === "vaultIds" && Array.isArray(entry)) {
      entry.forEach((candidate) => {
        if (typeof candidate === "string") target.add(candidate);
      });
    }
    collectVaultIds(entry, target);
  }
  return target;
}

async function runBounded(
  total: number,
  concurrency: number,
  operation: (index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(total, concurrency) },
    async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= total) return;
        await operation(index);
      }
    },
  );
  await Promise.all(workers);
}

function createFixture(): Fixture {
  const token = `akp-concurrency-${randomUUID()}`;
  return {
    organizationId: randomUUID(),
    userId: randomUUID(),
    spaceId: randomUUID(),
    vaultIds: [randomUUID(), randomUUID()],
    token,
    tokenHash: sha256(token),
    corpusRevision: `concurrency-${randomUUID()}`,
  };
}

async function seedFixture(db: Postgres, fixture: Fixture): Promise<void> {
  await db.pool.query(
    `insert into organizations(id,slug,name) values($1,$2,$3)`,
    [
      fixture.organizationId,
      `concurrency-${fixture.organizationId.slice(0, 8)}`,
      "Concurrency benchmark",
    ],
  );
  await db.pool.query(
    `insert into users(id,email,display_name) values($1,$2,$3)`,
    [
      fixture.userId,
      `concurrency-${fixture.userId}@example.invalid`,
      "Concurrency benchmark",
    ],
  );
  await db.pool.query(
    `insert into spaces(id,organization_id,slug,name,visibility,knowledge_repo_path)
     values($1,$2,$3,$4,'PRIVATE',$5)`,
    [
      fixture.spaceId,
      fixture.organizationId,
      `concurrency-${fixture.spaceId.slice(0, 8)}`,
      "Concurrency benchmark",
      `benchmark/concurrency/${fixture.spaceId}`,
    ],
  );
  await db.pool.query(
    `insert into memberships(user_id,space_id,role,path_prefix)
     values($1,$2,'ADMIN',null)`,
    [fixture.userId, fixture.spaceId],
  );
  await db.pool.query(
    `insert into api_tokens(user_id,token_hash,label,scopes)
     values($1,$2,'concurrency benchmark',$3::jsonb)`,
    [
      fixture.userId,
      fixture.tokenHash,
      JSON.stringify({
        spaces: [
          {
            spaceId: fixture.spaceId,
            pathPrefix: null,
            permissions: [
              "knowledge:read",
              "source:read",
              "source:write",
              "knowledge:propose",
              "knowledge:review",
              "eval:run",
              "admin",
            ],
          },
        ],
      }),
    ],
  );

  for (const [vaultIndex, vaultId] of fixture.vaultIds.entries()) {
    await db.pool.query(
      `insert into vaults(
         id,space_id,canonical_path,name,read_only,current_revision,
         vault_key,local_path,visibility,enabled
       ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)`,
      [
        vaultId,
        fixture.spaceId,
        `benchmark/concurrency/vault-${vaultIndex + 1}`,
        `Concurrency vault ${vaultIndex + 1}`,
        fixture.corpusRevision,
        `concurrency-${vaultIndex + 1}-${vaultId.slice(0, 8)}`,
      ],
    );
    await db.pool.query(
      `insert into vault_memberships(
         user_id,vault_id,role,path_prefix,permissions
       ) values($1,$2,'ADMIN',null,$3::jsonb)`,
      [
        fixture.userId,
        vaultId,
        JSON.stringify([
          "knowledge:read",
          "source:read",
          "source:write",
          "knowledge:propose",
          "knowledge:review",
          "eval:run",
          "admin",
        ]),
      ],
    );
    await db.pool.query(
      `insert into vault_index_revisions(
         space_id,vault_id,corpus_revision,lexical_revision,vector_revision,
         graph_revision,context_pack_revision,status,warnings
       ) values($1,$2,$3,$3,null,$3,$3,'DEGRADED',$4::jsonb)`,
      [
        fixture.spaceId,
        vaultId,
        fixture.corpusRevision,
        JSON.stringify(["VECTOR_DISABLED_FOR_CONCURRENCY_BENCHMARK"]),
      ],
    );

    const documentIds: string[] = [];
    for (let ordinal = 1; ordinal <= 40; ordinal += 1) {
      const documentId = randomUUID();
      const unitId = randomUUID();
      documentIds.push(documentId);
      const externalId = `concurrency-v${vaultIndex + 1}-${ordinal}`;
      const body = [
        `Concurrency benchmark document ${ordinal} in vault ${vaultIndex + 1}.`,
        "The retrieval probe measures bounded concurrent architecture knowledge search.",
        `Marker ${externalId} keeps tenant isolation observable.`,
      ].join(" ");
      const contentHash = sha256(body);
      await db.pool.query(
        `insert into knowledge_documents(
           id,space_id,vault_id,path,external_id,title,type,lifecycle,
           trust_tier,current_revision,body_cache,frontmatter,aliases,layer,
           content_hash,token_estimate,raw_links
         ) values($1,$2,$3,$4,$5,$6,'concept','ACTIVE','HUMAN_REVIEWED',
                  $7,$8,$9::jsonb,'{}','concept',$10,40,'[]'::jsonb)`,
        [
          documentId,
          fixture.spaceId,
          vaultId,
          `concepts/${externalId}.md`,
          externalId,
          `Concurrency document ${ordinal}`,
          fixture.corpusRevision,
          body,
          JSON.stringify({
            id: externalId,
            title: `Concurrency document ${ordinal}`,
            knowledge_layer: "concept",
          }),
          contentHash,
        ],
      );
      await db.pool.query(
        `insert into knowledge_units(
           id,document_id,space_id,vault_id,unit_key,unit_type,heading_path,body,
           content_hash,corpus_revision,document_revision,lifecycle,trust_tier,
           source_ids,token_estimate,parent_unit_id,permissions,locator,
           structural_order,container_only,embedding_eligible
         ) values($1,$2,$3,$4,$5,'PARAGRAPH',$6,$7,$8,$9,$9,'ACTIVE',
                  'HUMAN_REVIEWED','{}',40,null,'{}'::jsonb,$10::jsonb,
                  1,false,false)`,
        [
          unitId,
          documentId,
          fixture.spaceId,
          vaultId,
          `paragraph-${ordinal}`,
          [`Concurrency document ${ordinal}`],
          body,
          contentHash,
          fixture.corpusRevision,
          JSON.stringify({ path: `concepts/${externalId}.md` }),
        ],
      );
    }
    for (let ordinal = 0; ordinal < documentIds.length - 1; ordinal += 1) {
      await db.pool.query(
        `insert into knowledge_relations(
           space_id,from_document_id,to_document_id,relation_type,weight,provenance
         ) values($1,$2,$3,'related_to',1,'concurrency-benchmark')`,
        [fixture.spaceId, documentIds[ordinal], documentIds[ordinal + 1]],
      );
    }
  }
}

async function cleanupFixture(db: Postgres, fixture: Fixture): Promise<void> {
  await db.pool.query("delete from context_packets where space_id=$1", [
    fixture.spaceId,
  ]);
  await db.pool.query("delete from audit_events where space_id=$1", [
    fixture.spaceId,
  ]);
  await db.pool.query("delete from ingest_jobs where space_id=$1", [
    fixture.spaceId,
  ]);
  await db.pool.query("delete from knowledge_relations where space_id=$1", [
    fixture.spaceId,
  ]);
  await db.pool.query("delete from knowledge_units where space_id=$1", [
    fixture.spaceId,
  ]);
  await db.pool.query("delete from knowledge_documents where space_id=$1", [
    fixture.spaceId,
  ]);
  await db.pool.query("delete from vault_index_revisions where space_id=$1", [
    fixture.spaceId,
  ]);
  await db.pool.query("delete from vault_memberships where user_id=$1", [
    fixture.userId,
  ]);
  await db.pool.query("delete from api_tokens where user_id=$1", [
    fixture.userId,
  ]);
  await db.pool.query("delete from memberships where user_id=$1", [
    fixture.userId,
  ]);
  await db.pool.query("delete from vaults where space_id=$1", [
    fixture.spaceId,
  ]);
  await db.pool.query("delete from spaces where id=$1", [fixture.spaceId]);
  await db.pool.query("delete from users where id=$1", [fixture.userId]);
  await db.pool.query("delete from organizations where id=$1", [
    fixture.organizationId,
  ]);
}

async function measureApi(
  app: Awaited<
    ReturnType<(typeof import("../apps/api/src/server.js"))["buildServer"]>
  >,
  fixture: Fixture,
  endpoint: "/v1/search" | "/v1/context",
  total: number,
  concurrency: number,
): Promise<ApiMeasurement> {
  const latencies: number[] = [];
  const violations: string[] = [];
  let successes = 0;
  let failures = 0;
  const started = performance.now();
  await runBounded(total, concurrency, async (index) => {
    const vaultId = fixture.vaultIds[index % fixture.vaultIds.length];
    if (!vaultId) throw new Error("Missing benchmark vault");
    const requestStarted = performance.now();
    const response = await app.inject({
      method: "POST",
      url: endpoint,
      headers: { authorization: `Bearer ${fixture.token}` },
      payload: {
        query: `concurrency benchmark document ${(index % 20) + 1}`,
        intent: endpoint === "/v1/context" ? "CONCEPTUAL" : "EXACT_LOOKUP",
        spaceId: fixture.spaceId,
        vaultId,
        vaultIds: [],
        federated: false,
        types: [],
        minimumTrust: "MACHINE_SUPPORTED",
        mode: "SOURCE_BACKED",
        limit: 10,
        ...(endpoint === "/v1/context"
          ? { maxTokens: 2048, packetMode: "FULL_CONTEXT_PACKET" }
          : {}),
      },
    });
    latencies.push(performance.now() - requestStarted);
    if (response.statusCode >= 200 && response.statusCode < 300) {
      successes += 1;
      const body = response.json<unknown>();
      const observedVaultIds = collectVaultIds(body);
      const foreign = [...observedVaultIds].filter(
        (observed) => observed !== vaultId,
      );
      if (foreign.length > 0) {
        violations.push(`${endpoint}:${index}:${foreign.join(",")}`);
      }
    } else {
      failures += 1;
      violations.push(
        `${endpoint}:${index}:status-${response.statusCode}:${response.body.slice(0, 160)}`,
      );
    }
  });
  const elapsedSeconds = Math.max(0.001, (performance.now() - started) / 1000);
  return {
    requests: total,
    concurrency,
    successes,
    failures,
    throughputPerSecond: rounded(total / elapsedSeconds),
    latency: summarize(latencies),
    crossVaultViolations: violations,
  };
}

async function seedIngestJobs(
  db: Postgres,
  fixture: Fixture,
): Promise<string[]> {
  const eligible = await db.pool.query<{ count: string }>(
    `select count(*)::text as count
       from ingest_jobs
      where state in (
        'RECEIVED','HASHED','STORED','NORMALIZING','ANALYZING',
        'PLANNED','DRAFTED','VALIDATING'
      )
        and cancelled_at is null
        and next_attempt_at <= now()
        and (lease_expires_at is null or lease_expires_at < now())`,
  );
  if (Number(eligible.rows[0]?.count ?? 0) !== 0) {
    throw new Error(
      "CONCURRENCY_BENCHMARK_REQUIRES_NO_PREEXISTING_CLAIMABLE_INGEST_JOBS",
    );
  }
  const ids = Array.from({ length: ingestJobs }, () => randomUUID());
  for (const [index, id] of ids.entries()) {
    const vaultId = fixture.vaultIds[index % fixture.vaultIds.length];
    if (!vaultId) throw new Error("Missing benchmark vault");
    await db.pool.query(
      `insert into ingest_jobs(
         id,space_id,vault_id,source_uri,state,payload,created_by
       ) values($1,$2,$3,$4,'RECEIVED',$5::jsonb,$6)`,
      [
        id,
        fixture.spaceId,
        vaultId,
        `benchmark://concurrency/${id}`,
        JSON.stringify({ benchmark: true, ordinal: index }),
        fixture.userId,
      ],
    );
  }
  return ids;
}

async function measureWorkerClaims(
  db: Postgres,
  fixture: Fixture,
): Promise<{
  jobs: number;
  workers: number;
  claimed: number;
  uniqueClaims: number;
  duplicateClaims: string[];
  foreignClaims: string[];
  latency: Stats;
  throughputPerSecond: number;
  completedRows: number;
}> {
  const expectedIds = new Set(await seedIngestJobs(db, fixture));
  const claimIds: string[] = [];
  const latencies: number[] = [];
  const foreignClaims: string[] = [];
  const started = performance.now();
  await Promise.all(
    Array.from({ length: ingestWorkers }, async (_, workerIndex) => {
      const workerId = `concurrency-worker-${workerIndex + 1}`;
      while (true) {
        const claimStarted = performance.now();
        const claim = await claimNextIngestJob(db, workerId, 30);
        latencies.push(performance.now() - claimStarted);
        if (!claim) return;
        const id = String(claim.id);
        if (!expectedIds.has(id)) {
          foreignClaims.push(id);
          throw new Error(`Worker claimed non-benchmark ingest job ${id}`);
        }
        claimIds.push(id);
        await db.pool.query(
          `update ingest_jobs
              set state='COMPLETED',result=$2::jsonb,lease_owner=null,
                  lease_expires_at=null,heartbeat_at=now(),updated_at=now()
            where id=$1 and lease_owner=$3`,
          [id, JSON.stringify({ benchmark: true, workerId }), workerId],
        );
      }
    }),
  );
  const elapsedSeconds = Math.max(0.001, (performance.now() - started) / 1000);
  const counts = new Map<string, number>();
  claimIds.forEach((id) => counts.set(id, (counts.get(id) ?? 0) + 1));
  const duplicateClaims = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id, count]) => `${id}:${count}`);
  const completed = await db.pool.query<{ count: string }>(
    `select count(*)::text as count
       from ingest_jobs
      where space_id=$1 and state='COMPLETED'`,
    [fixture.spaceId],
  );
  return {
    jobs: ingestJobs,
    workers: ingestWorkers,
    claimed: claimIds.length,
    uniqueClaims: counts.size,
    duplicateClaims,
    foreignClaims,
    latency: summarize(latencies),
    throughputPerSecond: rounded(claimIds.length / elapsedSeconds),
    completedRows: Number(completed.rows[0]?.count ?? 0),
  };
}

async function databaseConnections(db: Postgres): Promise<number> {
  const result = await db.pool.query<{ count: string }>(
    `select count(*)::text as count
       from pg_stat_activity
      where datname=current_database()`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function main(): Promise<void> {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousVectorEnabled = process.env.AKP_VECTOR_ENABLED;
  process.env.NODE_ENV = "test";
  process.env.AKP_VECTOR_ENABLED = "false";

  const db = new Postgres(databaseUrl);
  const fixture = createFixture();
  const memoryBefore = memorySnapshot();
  const connectionsBefore = await databaseConnections(db);
  let app:
    | Awaited<
        ReturnType<(typeof import("../apps/api/src/server.js"))["buildServer"]>
      >
    | undefined;
  let failure: string | undefined;
  let search: ApiMeasurement | undefined;
  let context: ApiMeasurement | undefined;
  let workers: Awaited<ReturnType<typeof measureWorkerClaims>> | undefined;
  try {
    await seedFixture(db, fixture);
    const module = await import("../apps/api/src/server.js");
    app = module.buildServer();
    await app.ready();
    search = await measureApi(
      app,
      fixture,
      "/v1/search",
      searchRequests,
      searchConcurrency,
    );
    context = await measureApi(
      app,
      fixture,
      "/v1/context",
      contextRequests,
      contextConcurrency,
    );
    workers = await measureWorkerClaims(db, fixture);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  const memoryAfter = memorySnapshot();
  const connectionsAfter = await databaseConnections(db);
  const acceptance = {
    searchSuccessful:
      search?.successes === searchRequests && search.failures === 0,
    contextSuccessful:
      context?.successes === contextRequests && context.failures === 0,
    crossVaultIsolation:
      (search?.crossVaultViolations.length ?? 1) === 0 &&
      (context?.crossVaultViolations.length ?? 1) === 0,
    ingestClaimsExact:
      workers?.claimed === ingestJobs &&
      workers.uniqueClaims === ingestJobs &&
      workers.completedRows === ingestJobs,
    noDuplicateIngestClaims: workers?.duplicateClaims.length === 0,
    noForeignIngestClaims: workers?.foreignClaims.length === 0,
  };
  const status =
    !failure && Object.values(acceptance).every(Boolean) ? "PASSED" : "FAILED";
  const report = {
    schemaVersion: "akp.concurrency-benchmark.v1",
    generatedAt: new Date().toISOString(),
    status,
    evidenceLevel: "LOCAL_IN_PROCESS_API_AND_POSTGRES_CONCURRENCY",
    coverageStatus: "PARTIAL",
    execution: {
      nodeVersion: process.version,
      platform: process.platform,
      database: "DATABASE_URL-backed PostgreSQL",
      apiTransport:
        "Fastify inject: complete route/auth/serialization path without a TCP socket",
      retrievalVectorMode: "disabled; exact/lexical/graph/context paths only",
    },
    workload: {
      vaults: fixture.vaultIds.length,
      documentsPerVault: 40,
      searchRequests,
      searchConcurrency,
      contextRequests,
      contextConcurrency,
      ingestJobs,
      ingestWorkers,
    },
    acceptance,
    api: { search, context },
    workers,
    resources: {
      processMemoryBefore: memoryBefore,
      processMemoryAfter: memoryAfter,
      rssDeltaBytes: memoryAfter.rssBytes - memoryBefore.rssBytes,
      heapDeltaBytes: memoryAfter.heapUsedBytes - memoryBefore.heapUsedBytes,
      observableBenchmarkPool: {
        totalCount: db.pool.totalCount,
        idleCount: db.pool.idleCount,
        waitingCount: db.pool.waitingCount,
      },
      databaseConnectionsBefore: connectionsBefore,
      databaseConnectionsAfter: connectionsAfter,
    },
    measured: [
      "Concurrent authenticated /v1/search execution across two private vaults",
      "Concurrent authenticated /v1/context execution and ContextPacket persistence",
      "Per-operation p50/p95/mean/max latency and observed throughput",
      "Cross-vault response isolation under concurrent retrieval",
      "Concurrent production ingest-job leasing with SKIP LOCKED and multiple worker identities",
      "Duplicate and foreign ingest-job claim detection",
      "Node process memory delta and observable PostgreSQL client-pool state",
    ],
    notMeasured: [
      "TCP/TLS/network latency or reverse-proxy behavior",
      "semantic embedding-provider concurrency",
      "raw object-store upload throughput",
      "extractor/OCR throughput",
      "outbox retry/quarantine failure injection",
      "PostgreSQL restart behavior under active load",
      "host/container CPU and PostgreSQL server RAM",
      "production customer traffic or private vault data",
    ],
    limitations: [
      "This benchmark complements the 1K-100K synthetic scale harness; it does not replace that corpus-size evidence.",
      "Fastify inject exercises the API route, authentication and serialization stack in-process but excludes socket and proxy overhead.",
      "The ingest worker measurement targets durable leasing/claim contention, not the extractor or complete ingest state machine.",
      "Failure and retry semantics remain part of the dedicated resilience matrix rather than this latency benchmark.",
    ],
    ...(failure ? { failure } : {}),
  };

  try {
    if (app) await app.close();
    await cleanupFixture(db, fixture);
  } finally {
    await db.close();
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousVectorEnabled === undefined)
      delete process.env.AKP_VECTOR_ENABLED;
    else process.env.AKP_VECTOR_ENABLED = previousVectorEnabled;
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (status !== "PASSED") process.exitCode = 1;
}

await main();
