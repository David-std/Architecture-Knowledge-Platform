import { hostname } from "node:os";
import { Postgres, claimNextIngestJob } from "@akp/postgres";
import { transitionIngest, type IngestState } from "@akp/domain";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const extractorUrl = process.env.AKP_EXTRACTOR_URL ?? "http://127.0.0.1:8090";
const workerId = `${hostname()}:${process.pid}`;
const db = new Postgres(databaseUrl);

async function updateState(
  jobId: string,
  current: IngestState,
  next: IngestState,
  result?: unknown,
): Promise<void> {
  transitionIngest(current, next);
  await db.pool.query(
    `
    update ingest_jobs
       set state = $2,
           result = coalesce($3::jsonb, result),
           lease_owner = null,
           lease_expires_at = null,
           updated_at = now()
     where id = $1
    `,
    [jobId, next, result ? JSON.stringify(result) : null],
  );
}

async function processJob(job: Record<string, unknown>): Promise<void> {
  const id = String(job.id);
  const state = String(job.state) as IngestState;
  const payload = job.payload as Record<string, unknown>;

  if (state === "RECEIVED") {
    // Production implementation hashes and stores bytes before moving to HASHED.
    await updateState(id, state, "HASHED");
    return;
  }
  if (state === "HASHED") {
    await updateState(id, state, "STORED");
    return;
  }
  if (state === "STORED") {
    await updateState(id, state, "NORMALIZING");
    return;
  }
  if (state === "NORMALIZING") {
    const response = await fetch(`${extractorUrl}/v1/extract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source_uri: payload.sourceUri,
        media_type: payload.mediaType ?? null,
      }),
    });
    if (!response.ok) throw new Error(`Extractor failed: ${response.status}`);
    const extracted = await response.json();
    await updateState(id, state, "ANALYZING", { extracted });
    return;
  }

  // Remaining stages require compiler, Git draft and review adapters.
  // Fail closed rather than pretending publication happened.
  await db.pool.query(
    `
    update ingest_jobs
       set lease_owner = null,
           lease_expires_at = null,
           updated_at = now()
     where id = $1
    `,
    [id],
  );
}

async function loop(): Promise<void> {
  for (;;) {
    const job = await claimNextIngestJob(db, workerId, 60);
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    try {
      await processJob(job);
    } catch (error) {
      await db.pool.query(
        `
        update ingest_jobs
           set state = 'FAILED',
               error = $2::jsonb,
               lease_owner = null,
               lease_expires_at = null,
               updated_at = now()
         where id = $1
        `,
        [job.id, JSON.stringify({ message: String(error) })],
      );
    }
  }
}

process.on("SIGTERM", async () => {
  await db.close();
  process.exit(0);
});

await loop();
