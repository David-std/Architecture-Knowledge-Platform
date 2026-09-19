import type { AssuranceRun } from "@akp/domain";
import {
  applyNextSourceConnectorEvent,
  claimNextAssuranceRun,
  claimNextIngestJob,
  summarizeOutbox,
  summarizeSourceConnectorInbox,
  type OutboxDrainSummary,
  type Postgres,
  type SourceConnectorInboxSummary,
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
] as const;

// Keep the default below the API integration subprocess timeout while still
// allowing a cold extractor/object-store path to finish in CI.
export const DEFAULT_WORKER_DRAIN_DEADLINE_MS = 90_000;

export interface IngestDrainSummary {
  /** Claimable pipeline states; REVIEW_REQUIRED is a human gate and is
   * reported separately rather than preventing worker quiescence. */
  work: number;
  /** Work visible after an empty claim; forces an immediate claim retry. */
  immediatelyClaimable: number;
  reviewRequired: number;
  quarantined: number;
  nextWakeAt: string | null;
}

export interface AssuranceDrainSummary {
  work: number;
  immediatelyClaimable: number;
  failed: number;
  nextWakeAt: string | null;
}

export interface WorkerDrainSummary {
  mode: "DRAIN";
  status: "SUCCEEDED" | "FAILED";
  success: boolean;
  reason:
    | "QUIESCENT"
    | "QUARANTINED"
    | "ASSURANCE_FAILED"
    | "CONNECTOR_GAP_BLOCKED"
    | "DEADLINE_EXCEEDED";
  consumerName: string;
  startedAt: string;
  finishedAt: string;
  deadlineAt: string;
  elapsedMs: number;
  eventsProcessed: number;
  ingestJobsProcessed: number;
  assuranceRunsProcessed: number;
  connectorEventsProcessed: number;
  deliveries: OutboxDrainSummary;
  ingest: IngestDrainSummary;
  assurance: AssuranceDrainSummary;
  connectors: SourceConnectorInboxSummary;
}

export interface WorkerDrainOptions {
  db: Postgres;
  consumerName: string;
  workerId: string;
  leaseSeconds?: number;
  deadlineMs?: number;
  runEventOnce: () => Promise<boolean>;
  runIngestJob: (job: Record<string, unknown>) => Promise<void>;
  assuranceWorkerId?: string;
  runAssuranceRun?: (run: AssuranceRun) => Promise<void>;
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

export async function summarizeAssuranceRuns(
  db: Postgres,
): Promise<AssuranceDrainSummary> {
  const result = await db.pool.query(
    `
    select
      count(*) filter (where status in ('PENDING','RUNNING'))::int work,
      count(*) filter (
        where (
          status='PENDING' and next_attempt_at<=now()
        ) or (
          status='RUNNING' and lease_expires_at<=now()
        )
      )::int immediately_claimable,
      count(*) filter (where status='FAILED')::int failed,
      min(
        case
          when status='RUNNING' and lease_expires_at>now()
            then lease_expires_at
          when status='PENDING' and next_attempt_at>now()
            then next_attempt_at
          else null
        end
      ) next_wake_at
    from assurance_runs
    `,
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return {
    work: Number(row?.work ?? 0),
    immediatelyClaimable: Number(row?.immediately_claimable ?? 0),
    failed: Number(row?.failed ?? 0),
    nextWakeAt: row?.next_wake_at
      ? new Date(String(row.next_wake_at)).toISOString()
      : null,
  };
}

export async function summarizeIngestJobs(
  db: Postgres,
): Promise<IngestDrainSummary> {
  const result = await db.pool.query(
    `
    select
      count(*) filter (where state=any($1::text[]))::int work,
      count(*) filter (
        where state=any($1::text[])
          and next_attempt_at<=now()
          and (lease_expires_at is null or lease_expires_at<=now())
      )::int immediately_claimable,
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
    immediatelyClaimable: Number(row?.immediately_claimable ?? 0),
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
  assuranceRunsProcessed: number,
  connectorEventsProcessed: number,
  deliveries: OutboxDrainSummary,
  ingest: IngestDrainSummary,
  assurance: AssuranceDrainSummary,
  connectors: SourceConnectorInboxSummary,
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
    assuranceRunsProcessed,
    connectorEventsProcessed,
    deliveries,
    ingest,
    assurance,
    connectors,
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
  let assuranceRunsProcessed = 0;
  let connectorEventsProcessed = 0;

  for (;;) {
    const eventHandled = await options.runEventOnce();
    if (eventHandled) eventsProcessed += 1;

    const connectorEvent = await applyNextSourceConnectorEvent(options.db);
    if (connectorEvent) {
      connectorEventsProcessed += 1;
      continue;
    }

    if (options.runAssuranceRun) {
      const assurance = await claimNextAssuranceRun(
        options.db,
        options.assuranceWorkerId ?? `${options.workerId}:assurance`,
        options.leaseSeconds ?? 60,
      );
      if (assurance) {
        assuranceRunsProcessed += 1;
        await options.runAssuranceRun(assurance);
        continue;
      }
    }

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
    const assurance = options.runAssuranceRun
      ? await summarizeAssuranceRuns(options.db)
      : {
          work: 0,
          immediatelyClaimable: 0,
          failed: 0,
          nextWakeAt: null,
        };
    const connectors = await summarizeSourceConnectorInbox(options.db);
    if (deliveries.quarantined > 0 || ingest.quarantined > 0) {
      const summary = makeSummary(
        options,
        startedAtMs,
        deadlineAtMs,
        eventsProcessed,
        ingestJobsProcessed,
        assuranceRunsProcessed,
        connectorEventsProcessed,
        deliveries,
        ingest,
        assurance,
        connectors,
        "QUARANTINED",
      );
      throw new WorkerDrainError(summary);
    }

    if (connectors.blockedByGap > 0 && connectors.immediatelyClaimable === 0) {
      throw new WorkerDrainError(
        makeSummary(
          options,
          startedAtMs,
          deadlineAtMs,
          eventsProcessed,
          ingestJobsProcessed,
          assuranceRunsProcessed,
          connectorEventsProcessed,
          deliveries,
          ingest,
          assurance,
          connectors,
          "CONNECTOR_GAP_BLOCKED",
        ),
      );
    }

    if (assurance.failed > 0) {
      throw new WorkerDrainError(
        makeSummary(
          options,
          startedAtMs,
          deadlineAtMs,
          eventsProcessed,
          ingestJobsProcessed,
          assuranceRunsProcessed,
          connectorEventsProcessed,
          deliveries,
          ingest,
          assurance,
          connectors,
          "ASSURANCE_FAILED",
        ),
      );
    }

    if (Date.now() >= deadlineAtMs) {
      throw new WorkerDrainError(
        makeSummary(
          options,
          startedAtMs,
          deadlineAtMs,
          eventsProcessed,
          ingestJobsProcessed,
          assuranceRunsProcessed,
          connectorEventsProcessed,
          deliveries,
          ingest,
          assurance,
          connectors,
          "DEADLINE_EXCEEDED",
        ),
      );
    }

    if (
      ingest.work === 0 &&
      deliveries.nonTerminal === 0 &&
      assurance.work === 0 &&
      connectors.pending === 0
    ) {
      return makeSummary(
        options,
        startedAtMs,
        deadlineAtMs,
        eventsProcessed,
        ingestJobsProcessed,
        assuranceRunsProcessed,
        connectorEventsProcessed,
        deliveries,
        ingest,
        assurance,
        connectors,
        "QUIESCENT",
      );
    }

    // A delivery may become eligible between the claim attempt and the
    // durable summary (for example when a preceding transaction commits).
    // Re-enter the claim loop immediately instead of sleeping until the
    // overall deadline while executable work is already visible.
    if (
      deliveries.immediatelyClaimable > 0 ||
      ingest.immediatelyClaimable > 0 ||
      assurance.immediatelyClaimable > 0 ||
      connectors.immediatelyClaimable > 0
    ) {
      continue;
    }

    await waitUntil(
      earlierTimestamp(
        earlierTimestamp(deliveries.nextWakeAt, ingest.nextWakeAt),
        assurance.nextWakeAt,
      ),
      deadlineAtMs,
    );
  }
}
