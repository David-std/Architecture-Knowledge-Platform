import {
  claimNextIngestJob,
  summarizeOutbox,
  type OutboxDrainSummary,
  type Postgres,
} from "@akp/postgres";

/** States that still represent work for the ingest worker. */
const INGEST_WORK_STATES = [
  "RECEIVED",
  "HASHED",
  "STORED",
  "NORMALIZING",
  "ANALYZING",
  "PLANNED",
  "DRAFTED",
  "VALIDATING",
  "AUTO_APPROVED",
  "MERGED",
  "INDEXED",
  "EVALUATED",
] as const;

// Keep the default below the API integration subprocess timeout while still
// allowing a cold extractor/object-store path to finish in CI.
export const DEFAULT_WORKER_DRAIN_DEADLINE_MS = 90_000;

export interface IngestDrainSummary {
  /** Claimable pipeline states; REVIEW_REQUIRED is a human gate and is
   * reported separately rather than preventing worker quiescence. */
  work: number;
  reviewRequired: number;
  quarantined: number;
  nextWakeAt: string | null;
}

export interface WorkerDrainSummary {
  mode: "DRAIN";
  status: "SUCCEEDED" | "FAILED";
  success: boolean;
  reason: "QUIESCENT" | "QUARANTINED" | "DEADLINE_EXCEEDED";
  consumerName: string;
  startedAt: string;
  finishedAt: string;
  deadlineAt: string;
  elapsedMs: number;
  eventsProcessed: number;
  ingestJobsProcessed: number;
  deliveries: OutboxDrainSummary;
  ingest: IngestDrainSummary;
}

export interface WorkerDrainOptions {
  db: Postgres;
  consumerName: string;
  workerId: string;
  leaseSeconds?: number;
  deadlineMs?: number;
  runEventOnce: () => Promise<boolean>;
  runIngestJob: (job: Record<string, unknown>) => Promise<void>;
}

export class WorkerDrainError extends Error {
  readonly summary: WorkerDrainSummary;

  constructor(summary: WorkerDrainSummary) {
    super(`Worker drain failed: ${summary.reason}`);
    this.name = "WorkerDrainError";
    this.summary = summary;
  }
}

function parsePositiveMs(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate) || candidate <= 0) {
    throw new Error("INVALID_WORKER_DRAIN_DEADLINE");
  }
  return Math.floor(candidate);
}

function earlierTimestamp(
  left: string | null,
  right: string | null,
): string | null {
  if (!left) return right;
  if (!right) return left;
  return new Date(left).getTime() <= new Date(right).getTime() ? left : right;
}

export async function summarizeIngestJobs(
  db: Postgres,
): Promise<IngestDrainSummary> {
  const result = await db.pool.query(
    `
    select
      count(*) filter (where state=any($1::text[]))::int work,
      count(*) filter (where state='REVIEW_REQUIRED')::int review_required,
      count(*) filter (where state='QUARANTINED')::int quarantined,
      min(
        case
          when state=any($1::text[]) and lease_expires_at > now()
            then lease_expires_at
          when state=any($1::text[]) and next_attempt_at > now()
            then next_attempt_at
          else null
        end
      ) next_wake_at
    from ingest_jobs
   where cancelled_at is null
    `,
    [INGEST_WORK_STATES],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return {
    work: Number(row?.work ?? 0),
    reviewRequired: Number(row?.review_required ?? 0),
    quarantined: Number(row?.quarantined ?? 0),
    nextWakeAt: row?.next_wake_at
      ? new Date(String(row.next_wake_at)).toISOString()
      : null,
  };
}

function makeSummary(
  options: WorkerDrainOptions,
  startedAtMs: number,
  deadlineAtMs: number,
  eventsProcessed: number,
  ingestJobsProcessed: number,
  deliveries: OutboxDrainSummary,
  ingest: IngestDrainSummary,
  reason: WorkerDrainSummary["reason"],
): WorkerDrainSummary {
  const finishedAtMs = Date.now();
  return {
    mode: "DRAIN",
    status: reason === "QUIESCENT" ? "SUCCEEDED" : "FAILED",
    success: reason === "QUIESCENT",
    reason,
    consumerName: options.consumerName,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    deadlineAt: new Date(deadlineAtMs).toISOString(),
    elapsedMs: Math.max(0, finishedAtMs - startedAtMs),
    eventsProcessed,
    ingestJobsProcessed,
    deliveries,
    ingest,
  };
}

/**
 * Wait until a timestamp owned by PostgreSQL (retry or lease expiry) or the
 * configured drain deadline. This deliberately has no polling interval:
 * every wake-up is derived from durable state or the caller's deadline.
 */
async function waitUntil(
  wakeAt: string | null,
  deadlineAtMs: number,
): Promise<void> {
  const durableWakeAtMs = wakeAt ? new Date(wakeAt).getTime() : deadlineAtMs;
  const targetMs = Math.min(
    deadlineAtMs,
    Number.isFinite(durableWakeAtMs) ? durableWakeAtMs : deadlineAtMs,
  );
  const delayMs = targetMs - Date.now();
  if (delayMs <= 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * Run a worker until both ingest work and non-terminal deliveries are gone.
 * Retries and active leases are waited on using their persisted timestamps;
 * quarantine and an exhausted deadline fail closed with the last summary.
 */
export async function drainToQuiescence(
  options: WorkerDrainOptions,
): Promise<WorkerDrainSummary> {
  const deadlineMs = parsePositiveMs(
    options.deadlineMs,
    DEFAULT_WORKER_DRAIN_DEADLINE_MS,
  );
  const startedAtMs = Date.now();
  const deadlineAtMs = startedAtMs + deadlineMs;
  let eventsProcessed = 0;
  let ingestJobsProcessed = 0;

  for (;;) {
    const eventHandled = await options.runEventOnce();
    if (eventHandled) eventsProcessed += 1;

    const job = await claimNextIngestJob(
      options.db,
      options.workerId,
      options.leaseSeconds ?? 60,
    );
    if (job) {
      ingestJobsProcessed += 1;
      await options.runIngestJob(job);
      continue;
    }

    const deliveries = await summarizeOutbox(options.db, options.consumerName);
    const ingest = await summarizeIngestJobs(options.db);
    if (deliveries.quarantined > 0 || ingest.quarantined > 0) {
      const summary = makeSummary(
        options,
        startedAtMs,
        deadlineAtMs,
        eventsProcessed,
        ingestJobsProcessed,
        deliveries,
        ingest,
        "QUARANTINED",
      );
      throw new WorkerDrainError(summary);
    }

    if (Date.now() >= deadlineAtMs) {
      throw new WorkerDrainError(
        makeSummary(
          options,
          startedAtMs,
          deadlineAtMs,
          eventsProcessed,
          ingestJobsProcessed,
          deliveries,
          ingest,
          "DEADLINE_EXCEEDED",
        ),
      );
    }

    if (ingest.work === 0 && deliveries.nonTerminal === 0) {
      return makeSummary(
        options,
        startedAtMs,
        deadlineAtMs,
        eventsProcessed,
        ingestJobsProcessed,
        deliveries,
        ingest,
        "QUIESCENT",
      );
    }

    // A delivery may become eligible between the claim attempt and the
    // durable summary (for example when a preceding transaction commits).
    // Re-enter the claim loop immediately instead of sleeping until the
    // overall deadline while executable work is already visible.
    if (deliveries.immediatelyClaimable > 0) continue;

    await waitUntil(
      earlierTimestamp(deliveries.nextWakeAt, ingest.nextWakeAt),
      deadlineAtMs,
    );
  }
}
