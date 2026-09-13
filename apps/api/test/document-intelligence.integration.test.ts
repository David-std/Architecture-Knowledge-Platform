import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Postgres, grantVaultMembership, registerVault } from "@akp/postgres";

const execFileAsync = promisify(execFile);
const defaultSpace = "00000000-0000-0000-0000-000000000003";
const admin = "00000000-0000-0000-0000-000000000002";
const vaultKey = `p5-ocr-${randomUUID().slice(0, 12)}`;
const eventConsumer = `p5-ocr-${randomUUID()}`;
const token = `p5-ocr-${randomUUID()}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const headers = { authorization: `Bearer ${token}` };

let app: FastifyInstance;
let db: Postgres;
let fixtureRoot: string;
let sourceRoot: string;
let managedRepository: string;
let vaultId: string;

const previousEnvironment = {
  nodeEnv: process.env.NODE_ENV,
  managedRepository: process.env.AKP_MANAGED_REPO,
  ingestRoots: process.env.AKP_INGEST_ROOTS,
  eventConsumer: process.env.AKP_EVENT_CONSUMER,
};

function pdfWithVisibleText(text: string): Buffer {
  const escaped = text
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
  const stream = `BT\n/F1 48 Tf\n72 500 Td\n(${escaped}) Tj\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(output, "ascii"));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(output, "ascii");
  output += `xref\n0 ${objects.length + 1}\n`;
  output += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, "ascii");
}

async function seedEventConsumerForJob(jobId: string): Promise<void> {
  await db.pool.query(
    `insert into event_consumers(consumer_name,enabled,max_attempts,lease_seconds)
     values($1,true,8,60)
     on conflict(consumer_name) do update set enabled=true,max_attempts=8,lease_seconds=60`,
    [eventConsumer],
  );
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

async function runWorkerDrain(): Promise<void> {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const worker = path.join(root, "apps", "worker", "src", "worker.ts");
  await execFileAsync(process.execPath, [tsx, worker], {
    cwd: root,
    windowsHide: true,
    timeout: 180_000,
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
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests.");
  }
  process.env.NODE_ENV = "test";
  fixtureRoot = await mkdtemp(path.join(tmpdir(), "akp-p5-ocr-"));
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
      name: "P5 OCR E2E",
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
      "P5 OCR integration",
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
  app = module.buildServer();
});

afterAll(async () => {
  if (app) await app.close();
  if (db) await db.close();
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

describe("P5 document intelligence E2E", () => {
  it("ingests a scanned-policy PDF through real local OCR with grounded provenance", async () => {
    const marker = "AKP OCR E2E 481516";
    const sourcePath = path.join(sourceRoot, `scanned-${randomUUID()}.pdf`);
    const pdf = pdfWithVisibleText(marker);
    await writeFile(sourcePath, pdf);
    const sha256 = createHash("sha256").update(pdf).digest("hex");

    const submitted = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers,
      payload: {
        spaceId: defaultSpace,
        vaultId,
        sourceUri: sourcePath,
        expectedSha256: sha256,
        title: "P5 OCR E2E",
        mediaType: "application/pdf",
        documentIntelligence: {
          complexity: "scanned",
          ocrRequired: true,
          tables: false,
          formula: false,
          costPolicy: "NO_PAID",
          privacyPolicy: "LOCAL_ONLY",
        },
        policy: "REVIEW_REQUIRED",
      },
    });
    expect(submitted.statusCode, submitted.body).toBe(202);
    const jobId = (submitted.json() as { jobId: string }).jobId;
    await seedEventConsumerForJob(jobId);
    await runWorkerDrain();

    const result = await db.pool.query<{
      state: string;
      stage_outputs: Record<string, unknown>;
      extractor: string;
      quality: string;
      document_artifact: Record<string, unknown>;
      metadata: Record<string, unknown>;
      evidence_id: string;
      locator: Record<string, unknown>;
      excerpt: string;
      content_hash: string;
      review_status: string;
    }>(
      `select j.state,j.stage_outputs,a.extractor,a.quality,
              a.document_artifact,a.metadata,
              e.id evidence_id,e.locator,e.excerpt,e.content_hash,
              r.status review_status
         from ingest_jobs j
         join source_artifacts a
           on a.id=(j.stage_outputs->'extracted'->>'source_artifact_id')::uuid
         join evidence e
           on e.id=(j.stage_outputs->'extracted'->>'evidence_id')::uuid
         join reviews r on r.id=(j.stage_outputs->>'reviewId')::uuid
        where j.id=$1`,
      [jobId],
    );
    const row = result.rows[0];
    expect(row, JSON.stringify(result.rows)).toBeDefined();
    expect(row.state).toBe("REVIEW_REQUIRED");
    expect(row.review_status).toBe("PENDING");
    expect(row.extractor).toBe("tesseract-ocr");
    expect(row.quality).toBe("OCR_EXECUTED");

    const artifact = row.document_artifact as {
      source_hash?: string;
      extractor?: string;
      configuration?: Record<string, unknown>;
      paragraphs?: Array<{
        text?: string;
        locator?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
      }>;
    };
    expect(artifact.source_hash).toBe(sha256);
    expect(artifact.extractor).toBe("tesseract-ocr");
    expect(artifact.configuration?.ocr_executed).toBe(true);
    expect(artifact.paragraphs?.length).toBeGreaterThan(0);
    expect(
      artifact.paragraphs?.some(
        (paragraph) =>
          paragraph.locator?.page === 1 &&
          paragraph.locator?.region !== undefined,
      ),
    ).toBe(true);
    expect(
      artifact.paragraphs?.some((paragraph) =>
        String(paragraph.text ?? "").includes("481516"),
      ),
    ).toBe(true);

    const routing = row.metadata.routing as Record<string, unknown>;
    expect(routing.selected_adapter).toBe("tesseract-ocr");
    expect(routing.fallback).toBe(false);
    expect(routing.ocr_required).toBe(true);
    expect(routing.cost_policy).toBe("NO_PAID");
    expect(routing.privacy_policy).toBe("LOCAL_ONLY");

    expect(row.locator.kind).toBe("paragraph");
    expect(row.locator.page).toBe(1);
    expect(row.locator.region).toBeDefined();
    expect(row.excerpt).toContain("481516");
    expect(row.content_hash).toBe(
      createHash("sha256").update(row.excerpt).digest("hex"),
    );

    const extracted = row.stage_outputs.extracted as Record<string, unknown>;
    expect(extracted.evidence_id).toBe(row.evidence_id);
    expect(extracted.evidence_precision).toBe("STRUCTURAL");
    expect(extracted.structured_content_hash).toMatch(/^[a-f0-9]{64}$/);
  }, 180_000);
});
