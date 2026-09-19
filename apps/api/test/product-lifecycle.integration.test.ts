import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "dotenv";
import { Client } from "minio";
import { Postgres, grantVaultMembership, registerVault } from "@akp/postgres";
import { repositoryPublicationKey } from "../src/projections.js";

config({
  path: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../.env",
  ),
});

const execFileAsync = promisify(execFile);

const defaultSpace = "00000000-0000-0000-0000-000000000003";
const admin = "00000000-0000-0000-0000-000000000002";
const vaultKey = "e2e-product-lifecycle";
const eventConsumer = "e2e-product-lifecycle";
const token = `e2e-product-lifecycle-${randomUUID()}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const headers = { authorization: `Bearer ${token}` };

let app: FastifyInstance;
let db: Postgres;
let fixtureRoot: string;
let sourceRoot: string;
let managedRepository: string;
let vaultId: string;
let firstJobId: string;
let firstReviewId: string;
let secondJobId: string;
let secondReviewId: string;
let firstSourceHash: string;
let secondSourceHash: string;
let sourceObjectKeys: string[] = [];

const previousEnvironment = {
  nodeEnv: process.env.NODE_ENV,
  managedRepository: process.env.AKP_MANAGED_REPO,
  ingestRoots: process.env.AKP_INGEST_ROOTS,
  eventConsumer: process.env.AKP_EVENT_CONSUMER,
};

function sourceContent(label: string, marker: string): string {
  return `# ${label}

This disposable source proves the real ingest, extraction, review, publication,
worker and search path. The stable search marker is ${marker}.

The content is intentionally substantive enough for the deterministic
extractor to produce a canonical DocumentArtifact and searchable units.
`;
}

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  attempts = 30,
): Promise<T> {
  let last: T | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

async function runWorkerDrain(): Promise<void> {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const worker = path.join(root, "apps", "worker", "src", "worker.ts");
  const result = await execFileAsync(process.execPath, [tsx, worker], {
    cwd: root,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_ENV: "test",
      AKP_WORKER_DRAIN: "true",
      AKP_EVENT_CONSUMER: eventConsumer,
      AKP_MANAGED_REPO: managedRepository,
      AKP_INGEST_ROOTS: sourceRoot,
      AKP_EXTRACTOR_URL:
        process.env.AKP_EXTRACTOR_URL ?? "http://127.0.0.1:8090",
      AKP_RAW_ENDPOINT:
        process.env.AKP_RAW_ENDPOINT ?? "http://127.0.0.1:19000",
      AKP_RAW_BUCKET: process.env.AKP_RAW_BUCKET ?? "akp-raw",
      AKP_RAW_ACCESS_KEY: process.env.AKP_RAW_ACCESS_KEY ?? "akp",
      AKP_RAW_SECRET_KEY: process.env.AKP_RAW_SECRET_KEY ?? "change-me",
      AKP_EXTRACTOR_TOKEN:
        process.env.AKP_EXTRACTOR_TOKEN ?? "local-extractor-development-token",
      AKP_VECTOR_ENABLED: "false",
    },
  });
  if (result.stderr.trim()) {
    // Keep useful worker diagnostics in the failure if the child exits cleanly.
    expect(result.stderr).not.toContain("UnhandledPromiseRejection");
  }
}

async function removeRawObjects(keys: readonly string[]): Promise<void> {
  if (!keys.length) return;
  const endpoint = new URL(
    process.env.AKP_RAW_ENDPOINT ?? "http://127.0.0.1:19000",
  );
  const client = new Client({
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || 80),
    useSSL: endpoint.protocol === "https:",
    accessKey: process.env.AKP_RAW_ACCESS_KEY ?? "akp",
    secretKey: process.env.AKP_RAW_SECRET_KEY ?? "change-me",
  });
  const bucket = process.env.AKP_RAW_BUCKET ?? "akp-raw";
  await Promise.all(
    [...new Set(keys)].map((key) =>
      client.removeObject(bucket, key).catch(() => undefined),
    ),
  );
}

/**
 * Remove mutable rows from a deterministic test vault. Outbox events are
 * intentionally retained: the platform makes them append-only evidence and
 * their foreign key keeps the vault registry row addressable after cleanup.
 */
async function purgeMutableFixtures(): Promise<void> {
  if (!db || !vaultId) return;
  const sourceRows = await db.pool.query<{ object_key: string }>(
    "select object_key from sources where vault_id=$1",
    [vaultId],
  );
  sourceObjectKeys.push(...sourceRows.rows.map((row) => row.object_key));

  const documentRows = await db.pool.query<{ id: string }>(
    "select id from knowledge_documents where vault_id=$1",
    [vaultId],
  );
  const documentIds = documentRows.rows.map((row) => row.id);
  const jobRows = await db.pool.query<{ id: string }>(
    "select id from ingest_jobs where vault_id=$1",
    [vaultId],
  );
  const jobIds = jobRows.rows.map((row) => row.id);
  const reviewRows = await db.pool.query<{ id: string }>(
    "select id from reviews where vault_id=$1",
    [vaultId],
  );
  const reviewIds = reviewRows.rows.map((row) => row.id);

  // Delivery attempts are append-only evidence, just like event_outbox;
  // remove only the mutable current delivery rows below.
  await db.pool.query("delete from event_deliveries where consumer_name=$1", [
    eventConsumer,
  ]);
  await db.pool.query("delete from event_consumers where consumer_name=$1", [
    eventConsumer,
  ]);
  await db.pool.query(
    "delete from repository_publication_locks where repository_key=$1",
    [repositoryPublicationKey(managedRepository)],
  );
  await db.pool.query("delete from context_packets where vault_id=$1", [
    vaultId,
  ]);
  await db.pool.query("delete from eval_runs where vault_id=$1", [vaultId]);
  await db.pool.query("delete from knowledge_lint_runs where vault_id=$1", [
    vaultId,
  ]);
  await db.pool.query("delete from error_book where vault_id=$1", [vaultId]);
  await db.pool.query("delete from schema_dry_runs where vault_id=$1", [
    vaultId,
  ]);
  await db.pool.query("delete from agent_sessions where vault_id=$1", [
    vaultId,
  ]);
  await db.pool.query("delete from projects where vault_id=$1", [vaultId]);
  await db.pool.query("delete from incremental_index_runs where vault_id=$1", [
    vaultId,
  ]);
  await db.pool.query("delete from vault_index_revisions where vault_id=$1", [
    vaultId,
  ]);
  if (reviewIds.length) {
    await db.pool.query(
      "delete from review_comments where review_id=any($1::uuid[])",
      [reviewIds],
    );
    await db.pool.query(
      "delete from document_leases where review_id=any($1::uuid[])",
      [reviewIds],
    );
  }
  if (documentIds.length) {
    await db.pool.query(
      "update knowledge_documents set invalidated_by=null where id=any($1::uuid[])",
      [documentIds],
    );
    await db.pool.query(
      "delete from contradiction_members where document_id=any($1::uuid[])",
      [documentIds],
    );
    await db.pool.query(
      "delete from knowledge_relations where from_document_id=any($1::uuid[]) or to_document_id=any($1::uuid[])",
      [documentIds],
    );
    await db.pool.query(
      "delete from document_evidence where document_id=any($1::uuid[])",
      [documentIds],
    );
    await db.pool.query(
      "delete from unit_embeddings where unit_id in (select id from knowledge_units where document_id=any($1::uuid[]))",
      [documentIds],
    );
    await db.pool.query(
      "delete from knowledge_versions where document_id=any($1::uuid[])",
      [documentIds],
    );
    await db.pool.query(
      "delete from knowledge_units where document_id=any($1::uuid[])",
      [documentIds],
    );
    await db.pool.query(
      "delete from knowledge_documents where id=any($1::uuid[])",
      [documentIds],
    );
  }
  await db.pool.query("delete from contradiction_clusters where vault_id=$1", [
    vaultId,
  ]);
  await db.pool.query("delete from embedding_generations where vault_id=$1", [
    vaultId,
  ]);
  if (jobIds.length) {
    await db.pool.query(
      "delete from compilation_plans where job_id=any($1::uuid[])",
      [jobIds],
    );
    await db.pool.query(
      "delete from ingest_job_events where job_id=any($1::uuid[])",
      [jobIds],
    );
  }
  await db.pool.query("delete from reviews where vault_id=$1", [vaultId]);
  await db.pool.query("delete from ingest_jobs where vault_id=$1", [vaultId]);
  const sourceIds = (
    await db.pool.query<{ id: string }>(
      "select id from sources where vault_id=$1",
      [vaultId],
    )
  ).rows.map((row) => row.id);
  if (sourceIds.length) {
    await db.pool.query(
      "delete from document_evidence where evidence_id in (select id from evidence where source_id=any($1::uuid[]))",
      [sourceIds],
    );
    await db.pool.query(
      "delete from evidence where source_id=any($1::uuid[])",
      [sourceIds],
    );
    await db.pool.query(
      "delete from source_artifacts where source_id=any($1::uuid[])",
      [sourceIds],
    );
  }
  await db.pool.query("delete from sources where vault_id=$1", [vaultId]);
  await db.pool.query("delete from audit_events where vault_id=$1", [vaultId]);
  await db.pool.query("delete from api_tokens where token_hash=$1", [
    tokenHash,
  ]);
  await db.pool.query("delete from vault_memberships where vault_id=$1", [
    vaultId,
  ]);
  await db.pool.query("update vaults set enabled=false where id=$1", [vaultId]);
  await removeRawObjects(sourceObjectKeys);
}

async function seedEventConsumerForJob(jobId: string): Promise<void> {
  await db.pool.query(
    `insert into event_consumers(consumer_name,enabled,max_attempts,lease_seconds)
     values($1,true,8,60)
     on conflict(consumer_name) do update set enabled=true,max_attempts=8,lease_seconds=60`,
    [eventConsumer],
  );
  // Mark historical events as already consumed for this dedicated test
  // consumer. New events still enter PENDING through the database trigger.
  await db.pool.query(
    `insert into event_deliveries(event_id,consumer_name,status,completed_at)
     select event_id,$1,'SUCCEEDED',now() from event_outbox
     on conflict(event_id,consumer_name) do nothing`,
    [eventConsumer],
  );
  const extraction = await db.pool.query<{ event_id: string }>(
    `select event_id from event_outbox
      where event_type='ExtractionRequested' and resource_id=$1
      order by created_at desc limit 1`,
    [jobId],
  );
  const eventId = extraction.rows[0]?.event_id;
  if (!eventId)
    throw new Error(`Missing ExtractionRequested event for ${jobId}`);
  await db.pool.query(
    `update event_deliveries
        set status='PENDING',completed_at=null,next_attempt_at=now()
      where event_id=$1 and consumer_name=$2`,
    [eventId, eventConsumer],
  );
}

async function submitIngest(
  label: string,
  marker: string,
): Promise<{ jobId: string; sourcePath: string; sha256: string }> {
  const sourcePath = path.join(sourceRoot, `${label}-${randomUUID()}.md`);
  const content = sourceContent(label, marker);
  await writeFile(sourcePath, content, "utf8");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const response = await app.inject({
    method: "POST",
    url: "/v1/ingest",
    headers,
    payload: {
      spaceId: defaultSpace,
      vaultId,
      sourceUri: sourcePath,
      expectedSha256: sha256,
      title: label,
      mediaType: "text/markdown",
      policy: "REVIEW_REQUIRED",
    },
  });
  expect(response.statusCode).toBe(202);
  const body = response.json() as { jobId: string; state: string };
  expect(body.state).toBe("RECEIVED");
  return { jobId: body.jobId, sourcePath, sha256 };
}

async function reviewIdForJob(jobId: string): Promise<string> {
  const row = await waitFor(
    async () =>
      db.pool.query<{
        state: string;
        stage_outputs: Record<string, unknown>;
        error: unknown;
      }>("select state,stage_outputs,error from ingest_jobs where id=$1", [
        jobId,
      ]),
    (result) => result.rows[0]?.state === "REVIEW_REQUIRED",
    `ingest job ${jobId} to reach REVIEW_REQUIRED`,
  );
  const reviewId = row.rows[0]?.stage_outputs?.reviewId;
  if (typeof reviewId !== "string") {
    throw new Error(`Worker did not persist reviewId for ${jobId}`);
  }
  return reviewId;
}

async function decide(
  reviewId: string,
  decision: "APPROVE" | "REJECT",
  reason: string,
) {
  return app.inject({
    method: "POST",
    url: `/v1/reviews/${reviewId}/decision`,
    headers,
    payload: { decision, reason },
  });
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests.");
  }
  process.env.NODE_ENV = "test";
  fixtureRoot = await mkdtemp(path.join(tmpdir(), "akp-product-lifecycle-"));
  sourceRoot = path.join(fixtureRoot, "captured-sources");
  managedRepository = path.join(fixtureRoot, "managed-repository");
  await mkdir(sourceRoot, { recursive: true });
  process.env.AKP_MANAGED_REPO = managedRepository;
  process.env.AKP_INGEST_ROOTS = sourceRoot;
  process.env.AKP_EVENT_CONSUMER = eventConsumer;

  db = new Postgres(process.env.DATABASE_URL);
  const vault = await registerVault(
    db,
    {
      vaultKey,
      name: "E2E Product Lifecycle",
      spaceId: defaultSpace,
      gitRepository: null,
      defaultBranch: "main",
      localPath: path.join(fixtureRoot, "canonical-vault"),
      contentRoots: ["."],
      sourceRoots: [sourceRoot],
      schemaProfile: {},
      evalPack: {
        name: "generic",
        version: "1",
        enabled: true,
        criticalCases: [],
      },
      retrievalConfig: {},
      permissions: {},
      visibility: "PRIVATE",
      enabled: true,
    },
    { ownerUserId: admin },
  );
  vaultId = vault.id;
  await purgeMutableFixtures();
  await db.pool.query(
    "update vaults set enabled=true,current_revision='fixture:initial' where id=$1",
    [vaultId],
  );
  await grantVaultMembership(db, {
    userId: admin,
    vaultId,
    role: "ADMIN",
    permissions: [
      "knowledge:read",
      "source:read",
      "source:write",
      "knowledge:propose",
      "knowledge:review",
      "eval:run",
      "admin",
    ],
  });
  await db.pool.query(
    `insert into api_tokens(user_id,token_hash,label,scopes)
     values($1,$2,$3,$4::jsonb)`,
    [
      admin,
      tokenHash,
      "product lifecycle E2E",
      JSON.stringify({
        spaces: [
          {
            spaceId: defaultSpace,
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
  const module = await import("../src/server.js");
  app = module.buildServer({
    contextTokenizer: {
      id: "e2e-char4",
      label: "E2E deterministic char/4 tokenizer",
      quality: "APPROXIMATE" as const,
      approximate: true,
      count: (text: string) => Math.ceil(text.length / 4),
    },
  });
});

afterAll(async () => {
  if (app) await app.close();
  if (db) {
    await purgeMutableFixtures().catch(() => undefined);
    await db.close();
  }
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  if (previousEnvironment.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousEnvironment.nodeEnv;
  if (previousEnvironment.managedRepository === undefined)
    delete process.env.AKP_MANAGED_REPO;
  else process.env.AKP_MANAGED_REPO = previousEnvironment.managedRepository;
  if (previousEnvironment.ingestRoots === undefined)
    delete process.env.AKP_INGEST_ROOTS;
  else process.env.AKP_INGEST_ROOTS = previousEnvironment.ingestRoots;
  if (previousEnvironment.eventConsumer === undefined)
    delete process.env.AKP_EVENT_CONSUMER;
  else process.env.AKP_EVENT_CONSUMER = previousEnvironment.eventConsumer;
});

describe("product lifecycle E2E", () => {
  it("ingests, reviews, publishes, indexes with the real worker, searches, rejects, and rolls back", async () => {
    const firstMarker = `publication-marker-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const first = await submitIngest("published-product-source", firstMarker);
    firstJobId = first.jobId;
    firstSourceHash = first.sha256;
    await seedEventConsumerForJob(first.jobId);
    await runWorkerDrain();
    firstReviewId = await reviewIdForJob(first.jobId);
    const pendingReview = await app.inject({
      method: "GET",
      url: `/v1/reviews/${firstReviewId}`,
      headers,
    });
    expect(pendingReview.statusCode, pendingReview.body).toBe(200);
    const pendingReviewBody = pendingReview.json() as {
      id: string;
      status: string;
      vault_id: string;
      impact_manifest?: {
        proposedChanges?: Array<{ path?: string; content?: string }>;
      };
    };
    expect(pendingReviewBody).toMatchObject({
      id: firstReviewId,
      status: "PENDING",
      vault_id: vaultId,
    });

    const originalChange =
      pendingReviewBody.impact_manifest?.proposedChanges?.[0];
    if (!originalChange?.path || typeof originalChange.content !== "string") {
      throw new Error(
        "E2E review did not expose its proposed Markdown change.",
      );
    }
    const requestedChanges = await decide(
      firstReviewId,
      "REQUEST_CHANGES",
      "E2E requests a revision before publication",
    );
    expect(requestedChanges.statusCode).toBe(200);
    expect(requestedChanges.json()).toMatchObject({
      id: firstReviewId,
      status: "CHANGES_REQUESTED",
    });

    const revisionMarker = `revision-marker-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const revised = await app.inject({
      method: "POST",
      url: `/v1/reviews/${firstReviewId}/revise`,
      headers,
      payload: {
        summary: "E2E revised source summary",
        changes: [
          {
            path: originalChange.path,
            content: `${originalChange.content}\n\nRevision marker: ${revisionMarker}\n`,
            reason: "E2E adds the requested review correction",
          },
        ],
      },
    });
    expect(revised.statusCode, revised.body).toBe(200);
    expect(revised.json()).toMatchObject({
      id: firstReviewId,
      status: "CHANGES_REQUESTED",
      draftRevision: 2,
    });

    const approved = await decide(
      firstReviewId,
      "APPROVE",
      "E2E publication approved after deterministic review",
    );
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      id: firstReviewId,
      status: "APPROVED",
      indexing: "PENDING",
    });

    await runWorkerDrain();
    const indexed = await db.pool.query<{
      state: string;
      source_id: string;
      artifact_count: number;
      evidence_count: number;
      document_id: string;
      body_cache: string;
      unit_count: number;
      index_status: string;
      index_warnings: string[];
      corpus_revision: string;
      lexical_revision: string;
      graph_revision: string;
      context_pack_revision: string;
      vector_revision: string | null;
    }>(
      `select j.state,j.stage_outputs->>'sourceId' source_id,
                (select count(*)::int from source_artifacts a join sources s on s.id=a.source_id
                  where s.vault_id=j.vault_id and s.sha256=$2) artifact_count,
                (select count(*)::int from evidence e join sources s on s.id=e.source_id
                  where s.vault_id=j.vault_id and s.sha256=$2) evidence_count,
                d.id document_id,d.body_cache,
                (select count(*)::int from knowledge_units u where u.document_id=d.id) unit_count,
                i.status index_status,i.warnings index_warnings,i.corpus_revision,
                i.lexical_revision,i.graph_revision,i.context_pack_revision,
                i.vector_revision
           from ingest_jobs j
           join knowledge_documents d on d.vault_id=j.vault_id
             and d.frontmatter->>'source_sha256'=$2
           join vault_index_revisions i on i.vault_id=j.vault_id
          where j.id=$1`,
      [firstJobId, firstSourceHash],
    );
    expect(indexed.rows[0], JSON.stringify(indexed.rows)).toMatchObject({
      state: "COMPLETED",
      artifact_count: 1,
      evidence_count: 1,
      unit_count: expect.any(Number),
    });
    expect(indexed.rows[0]?.body_cache).toContain(revisionMarker);
    expect(Number(indexed.rows[0]?.unit_count)).toBeGreaterThan(0);
    expect(indexed.rows[0]?.corpus_revision).toContain("managed:");
    // Vector stays off pending the benchmark decision, so its absence is the
    // declared configuration rather than an index defect: every channel this
    // deployment serves is at the corpus revision, the vector generation is
    // genuinely absent, and the reason is still recorded on the marker.
    const indexRow = indexed.rows[0];
    expect(indexRow?.lexical_revision).toBe(indexRow?.corpus_revision);
    expect(indexRow?.graph_revision).toBe(indexRow?.corpus_revision);
    expect(indexRow?.context_pack_revision).toBe(indexRow?.corpus_revision);
    expect(indexRow?.vector_revision).toBeNull();
    expect(indexRow?.index_warnings).toContain(
      "VECTOR_DISABLED_PENDING_BENCHMARK",
    );
    expect(indexRow?.index_status).toBe("CONSISTENT");

    const sourceRow = await db.pool.query<{ object_key: string }>(
      "select object_key from sources where vault_id=$1 and sha256=$2",
      [vaultId, firstSourceHash],
    );
    sourceObjectKeys.push(...sourceRow.rows.map((row) => row.object_key));
    const artifact = await db.pool.query<{
      document_artifact: Record<string, unknown>;
      object_key: string;
    }>(
      `select a.document_artifact,a.object_key from source_artifacts a
           join sources s on s.id=a.source_id
          where s.vault_id=$1 and s.sha256=$2`,
      [vaultId, firstSourceHash],
    );
    expect(artifact.rows[0]?.document_artifact).toMatchObject({
      source_hash: firstSourceHash,
      media_type: "text/markdown",
    });
    expect(String(artifact.rows[0]?.object_key)).toContain("sha256/");

    const search = await app.inject({
      method: "POST",
      url: "/v1/search",
      headers,
      payload: {
        query: firstMarker,
        spaceId: defaultSpace,
        vaultId,
        vaultIds: [],
        federated: false,
        types: [],
        minimumTrust: "MACHINE_SUPPORTED",
        mode: "SOURCE_BACKED",
        limit: 10,
      },
    });
    expect(search.statusCode).toBe(200);
    const searchBody = search.json() as {
      hits: Array<{
        vaultId: string;
        unitId?: string;
        title: string;
        excerpt: string;
        citations: string[];
      }>;
      scope: { vaultIds: string[] };
    };
    expect(searchBody.scope.vaultIds).toEqual([vaultId]);
    expect(
      searchBody.hits.some(
        (hit) =>
          hit.vaultId === vaultId &&
          Boolean(hit.unitId) &&
          hit.excerpt.includes(firstMarker) &&
          hit.citations.some((citation) => citation.includes("managed/")),
      ),
    ).toBe(true);

    const context = await app.inject({
      method: "POST",
      url: "/v1/context",
      headers,
      payload: {
        query: revisionMarker,
        spaceId: defaultSpace,
        vaultId,
        vaultIds: [],
        federated: false,
        types: [],
        minimumTrust: "MACHINE_SUPPORTED",
        mode: "SOURCE_BACKED",
        limit: 10,
      },
    });
    expect(context.statusCode, context.body).toBe(200);
    const contextBody = context.json() as {
      packetId: string;
      vaultId: string;
      status: string;
      sections: Array<{ content: string; vaultId: string }>;
      citations: string[];
      budget: {
        tokenizer: {
          id: string;
          quality: "EXACT" | "APPROXIMATE";
          approximate: boolean;
          source: string;
        };
      };
    };
    expect(contextBody).toMatchObject({
      vaultId,
      status: "SUPPORTED",
      budget: {
        tokenizer: {
          id: "e2e-char4",
          quality: "APPROXIMATE",
          approximate: true,
          source: "injected",
        },
      },
    });
    expect(
      contextBody.sections.some(
        (section) =>
          section.vaultId === vaultId &&
          section.content.includes(revisionMarker),
      ),
    ).toBe(true);
    expect(contextBody.citations.length).toBeGreaterThan(0);

    const reasonedContext = await app.inject({
      method: "POST",
      url: "/v1/context",
      headers,
      payload: {
        query: revisionMarker,
        intent: "CONCEPTUAL",
        spaceId: defaultSpace,
        vaultId,
        reasoningMode: "PLAN",
        maxTokens: 2_000,
      },
    });
    expect(reasonedContext.statusCode, reasonedContext.body).toBe(200);
    const reasonedContextBody = reasonedContext.json() as {
      retrievalConfiguration: {
        reasoning: {
          requested: string;
          execution: string;
          trace: {
            planId: string;
            status: string;
            steps: Array<{ operator: string; status: string }>;
          };
        };
      };
      sections: Array<{ content: string }>;
    };
    expect(reasonedContextBody.retrievalConfiguration.reasoning).toMatchObject({
      requested: "PLAN",
      execution: "PLAN",
      trace: {
        status: "SUCCESS",
      },
    });
    expect(
      reasonedContextBody.retrievalConfiguration.reasoning.trace.steps.at(-1),
    ).toMatchObject({
      operator: "BUILD_CONTEXT",
      status: "SUCCESS",
    });
    expect(
      reasonedContextBody.sections.some((section) =>
        section.content.includes(revisionMarker),
      ),
    ).toBe(true);

    const persistedReasoning = await db.pool.query<{
      status: string;
      intent: string;
      steps: Array<{ operator: string; status: string }>;
      vault_ids: string[];
      revision_verified: boolean;
    }>(
      `select status,intent,steps,vault_ids,revision_verified
         from reasoning_execution_traces
        where space_id=$1 and plan_id=$2
        order by created_at desc
        limit 1`,
      [
        defaultSpace,
        reasonedContextBody.retrievalConfiguration.reasoning.trace.planId,
      ],
    );
    expect(persistedReasoning.rows[0]).toMatchObject({
      status: "SUCCESS",
      intent: "CONCEPTUAL",
      vault_ids: [vaultId],
      revision_verified: true,
    });
    expect(persistedReasoning.rows[0]?.steps.at(-1)).toMatchObject({
      operator: "BUILD_CONTEXT",
      status: "SUCCESS",
    });

    const catalogContext = await app.inject({
      method: "POST",
      url: "/v1/context",
      headers,
      payload: {
        query: revisionMarker,
        spaceId: defaultSpace,
        vaultId,
        contextLevel: "L0",
        maxTokens: 2_000,
      },
    });
    expect(catalogContext.statusCode, catalogContext.body).toBe(200);
    const catalogBody = catalogContext.json() as {
      requestedContextLevel: string;
      sections: Array<{ contextLevel: string; content: string }>;
    };
    expect(catalogBody.requestedContextLevel).toBe("L0");
    expect(catalogBody.sections.length).toBeGreaterThan(0);
    expect(
      catalogBody.sections.every(
        (section) =>
          section.contextLevel === "L0" &&
          section.content.includes("revision="),
      ),
    ).toBe(true);

    const fullContext = await app.inject({
      method: "POST",
      url: "/v1/context",
      headers,
      payload: {
        query: revisionMarker,
        spaceId: defaultSpace,
        vaultId,
        contextLevel: "L3",
        maxTokens: 8_000,
      },
    });
    expect(fullContext.statusCode, fullContext.body).toBe(200);
    const fullContextBody = fullContext.json() as {
      requestedContextLevel: string;
      sections: Array<{ contextLevel: string; content: string }>;
    };
    expect(fullContextBody.requestedContextLevel).toBe("L3");
    expect(
      fullContextBody.sections.some(
        (section) =>
          section.contextLevel === "L3" &&
          section.content.includes(revisionMarker),
      ),
    ).toBe(true);

    const contextRow = await db.pool.query<{
      vault_id: string;
      corpus_revision: string;
      packet_hash: string;
    }>(
      "select vault_id,corpus_revision,packet_hash from context_packets where id=$1",
      [contextBody.packetId],
    );
    expect(contextRow.rows[0]).toMatchObject({ vault_id: vaultId });
    expect(contextRow.rows[0]?.corpus_revision).toContain("managed:");

    const compactContext = await app.inject({
      method: "POST",
      url: "/v1/context",
      headers,
      payload: {
        query: revisionMarker,
        spaceId: defaultSpace,
        vaultId,
        packetMode: "COMPACT_AGENT_PACKET",
        maxTokens: 1000,
      },
    });
    expect(compactContext.statusCode, compactContext.body).toBe(200);
    const compactBody = compactContext.json() as {
      packetMode: string;
      identity: { packetId: string; status: string };
      content: Array<{ content: string }>;
      packetHash: string;
      budget: { maxTokens: number; serializedTokens: number };
    };
    expect(compactBody).toMatchObject({
      packetMode: "COMPACT_AGENT_PACKET",
      identity: { status: "SUPPORTED" },
      budget: { maxTokens: 1000 },
    });
    expect(compactBody.budget.serializedTokens).toBeLessThanOrEqual(1000);
    expect(
      compactBody.content.some((section) =>
        section.content.includes(revisionMarker),
      ),
    ).toBe(true);
    const persistedCompactSource = await db.pool.query<{
      packet_mode: string;
      packet_hash: string;
    }>(
      `select packet->>'packetMode' packet_mode,packet_hash
         from context_packets where id=$1`,
      [compactBody.identity.packetId],
    );
    expect(persistedCompactSource.rows[0]).toEqual({
      packet_mode: "FULL_CONTEXT_PACKET",
      packet_hash: compactBody.packetHash,
    });

    const invalidContextBudget = await app.inject({
      method: "POST",
      url: "/v1/context",
      headers,
      payload: {
        query: revisionMarker,
        spaceId: defaultSpace,
        vaultId,
        maxTokens: "512",
      },
    });
    expect(invalidContextBudget.statusCode).toBe(400);
    expect(invalidContextBudget.json()).toMatchObject({
      code: "INVALID_CONTEXT_REQUEST",
    });

    const undersizedContext = await app.inject({
      method: "POST",
      url: "/v1/context",
      headers,
      payload: {
        query: "x".repeat(2048),
        spaceId: defaultSpace,
        vaultId,
        maxTokens: 256,
      },
    });
    expect(undersizedContext.statusCode, undersizedContext.body).toBe(422);
    expect(undersizedContext.json()).toMatchObject({
      code: "CONTEXT_PACKET_BUDGET_TOO_SMALL",
      maxTokens: 256,
    });

    const secondMarker = `rejected-marker-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const second = await submitIngest("rejected-product-source", secondMarker);
    secondJobId = second.jobId;
    secondSourceHash = second.sha256;
    await runWorkerDrain();
    secondReviewId = await reviewIdForJob(second.jobId);
    const rejected = await decide(
      secondReviewId,
      "REJECT",
      "E2E rejection keeps unapproved source out of managed knowledge",
    );
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({
      id: secondReviewId,
      status: "REJECTED",
    });
    const rejectedState = await db.pool.query<{
      job_state: string;
      review_status: string;
      source_docs: number;
    }>(
      `select j.state job_state,r.status review_status,
                (select count(*)::int from knowledge_documents d
                  where d.vault_id=j.vault_id and d.frontmatter->>'source_sha256'=$2) source_docs
           from ingest_jobs j join reviews r on r.id=$1
          where j.id=$3`,
      [secondReviewId, secondSourceHash, secondJobId],
    );
    expect(rejectedState.rows[0]).toEqual({
      job_state: "CANCELLED",
      review_status: "REJECTED",
      source_docs: 0,
    });

    const rollback = await app.inject({
      method: "POST",
      url: `/v1/reviews/${firstReviewId}/rollback`,
      headers,
      payload: { reason: "E2E rollback removes the published source" },
    });
    expect(rollback.statusCode).toBe(200);
    expect(rollback.json()).toMatchObject({
      id: firstReviewId,
      status: "ROLLED_BACK",
      indexing: "PENDING",
    });

    const beforeRollbackDrain = await db.pool.query<{
      lifecycle: string;
      active_units: number;
    }>(
      `select d.lifecycle,
              (select count(*)::int from knowledge_units u
                where u.document_id=d.id
                  and u.lifecycle in ('ACTIVE','DISPUTED')) active_units
         from knowledge_documents d
        where d.vault_id=$1 and d.frontmatter->>'source_sha256'=$2`,
      [vaultId, firstSourceHash],
    );
    expect(beforeRollbackDrain.rows[0]).toMatchObject({
      lifecycle: "ACTIVE",
      active_units: expect.any(Number),
    });
    expect(beforeRollbackDrain.rows[0]?.active_units).toBeGreaterThan(0);

    const rollbackEvents = await db.pool.query<{
      event_id: string;
      event_type: string;
      causation_id: string | null;
      payload: { operation?: string; tombstones?: string[] };
    }>(
      `select event_id,event_type,causation_id,payload
         from event_outbox
        where resource_id=$1 and payload->>'operation'='ROLLBACK'
        order by created_at,event_id`,
      [firstReviewId],
    );
    expect(rollbackEvents.rows.map((row) => row.event_type).sort()).toEqual(
      [
        "CorpusRevisionPublished",
        "LexicalIndexUpdateRequested",
        "VectorIndexUpdateRequested",
        "GraphIndexUpdateRequested",
        "ContextPackInvalidationRequested",
        "ImpactedEvalRunRequested",
      ].sort(),
    );
    const rollbackCorpus = rollbackEvents.rows.find(
      (row) => row.event_type === "CorpusRevisionPublished",
    );
    expect(rollbackCorpus?.payload.operation).toBe("ROLLBACK");
    expect(rollbackCorpus?.payload.tombstones?.length).toBeGreaterThan(0);
    expect(rollbackCorpus?.causation_id).toBeNull();
    expect(
      rollbackEvents.rows
        .filter((row) => row.event_type !== "CorpusRevisionPublished")
        .every((row) => row.causation_id === rollbackCorpus?.event_id),
    ).toBe(true);

    await runWorkerDrain();

    const rolledBack = await db.pool.query<{
      review_status: string;
      lifecycle: string;
      index_status: string;
      active_units: number;
      total_units: number;
      inactive_units: number;
    }>(
      `select r.status review_status,d.lifecycle,i.status index_status,
                coalesce(u.active_units,0)::int active_units,
                coalesce(u.total_units,0)::int total_units,
                coalesce(u.inactive_units,0)::int inactive_units
           from reviews r
           join knowledge_documents d on d.vault_id=r.vault_id
             and d.frontmatter->>'source_sha256'=$2
           join vault_index_revisions i on i.vault_id=r.vault_id
           left join lateral (
             select count(*)::int total_units,
                    count(*) filter (
                      where lifecycle in ('ACTIVE','DISPUTED')
                    )::int active_units,
                    count(*) filter (
                      where lifecycle not in ('ACTIVE','DISPUTED')
                    )::int inactive_units
               from knowledge_units
              where document_id=d.id
           ) u on true
          where r.id=$1`,
      [firstReviewId, firstSourceHash],
    );
    expect(rolledBack.rows[0]).toMatchObject({
      review_status: "ROLLED_BACK",
      lifecycle: "DELETED_TOMBSTONE",
      // Rolling back republishes the vault at a new corpus revision; the served
      // channels are reprojected with it, so the marker stays consistent while
      // vector remains off pending the benchmark decision.
      index_status: "CONSISTENT",
      active_units: 0,
    });
    // Snapshot retention is an implementation detail: a tombstoned
    // document may retain historical units or compact them. What must hold is
    // that none remain active; the search assertion below proves the stronger
    // externally observable invariant that rollback content is unretrievable.
    expect(rolledBack.rows[0]?.inactive_units).toBe(
      rolledBack.rows[0]?.total_units,
    );

    const afterRollbackSearch = await app.inject({
      method: "POST",
      url: "/v1/search",
      headers,
      payload: {
        query: firstMarker,
        spaceId: defaultSpace,
        vaultId,
        vaultIds: [],
        federated: false,
        types: [],
        minimumTrust: "MACHINE_SUPPORTED",
        mode: "SOURCE_BACKED",
        limit: 10,
      },
    });
    expect(afterRollbackSearch.statusCode).toBe(200);
    expect(
      (afterRollbackSearch.json() as { hits: unknown[] }).hits,
    ).toHaveLength(0);

    const deliveries = await db.pool.query<{
      event_type: string;
      status: string;
    }>(
      `select e.event_type,d.status from event_deliveries d
           join event_outbox e on e.event_id=d.event_id
          where d.consumer_name=$1 and e.vault_id=$2
            and e.resource_id=any($3::text[])
          order by e.created_at,e.event_id`,
      [eventConsumer, vaultId, [firstJobId, firstReviewId, secondJobId]],
    );
    expect(deliveries.rows.length).toBeGreaterThanOrEqual(9);
    expect(deliveries.rows.every((row) => row.status === "SUCCEEDED")).toBe(
      true,
    );
    expect(
      deliveries.rows.some(
        (row) => row.event_type === "CorpusRevisionPublished",
      ),
    ).toBe(true);

    const rollbackDeliveries = await db.pool.query<{
      event_type: string;
      status: string;
    }>(
      `select e.event_type,d.status from event_deliveries d
         join event_outbox e on e.event_id=d.event_id
        where d.consumer_name=$1 and e.resource_id=$2
          and e.payload->>'operation'='ROLLBACK'
        order by e.created_at,e.event_id`,
      [eventConsumer, firstReviewId],
    );
    expect(rollbackDeliveries.rows.map((row) => row.event_type).sort()).toEqual(
      [
        "CorpusRevisionPublished",
        "LexicalIndexUpdateRequested",
        "VectorIndexUpdateRequested",
        "GraphIndexUpdateRequested",
        "ContextPackInvalidationRequested",
        "ImpactedEvalRunRequested",
      ].sort(),
    );
    expect(
      rollbackDeliveries.rows.every((row) => row.status === "SUCCEEDED"),
    ).toBe(true);
  }, 180_000);
});
