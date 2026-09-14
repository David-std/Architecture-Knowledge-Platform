import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  acknowledgeEventDelivery,
  appendOutboxEvent,
  claimNextEventDelivery,
  failEventDelivery,
  Postgres,
  registerEventConsumer,
} from "../packages/postgres/src/index.js";

type Stats = {
  samples: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const outputPath = path.resolve(
  process.env.AKP_EVENT_CONCURRENCY_REPORT ??
    "reports/ci/event-concurrency-benchmark.json",
);
const eventPairs = positiveInteger(process.env.AKP_EVENT_CONCURRENCY_PAIRS, 24);
const workerCount = positiveInteger(
  process.env.AKP_EVENT_CONCURRENCY_WORKERS,
  6,
);
const retryEvery = positiveInteger(
  process.env.AKP_EVENT_CONCURRENCY_RETRY_EVERY,
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
      samples.reduce((total, value) => total + value, 0) / samples.length,
    ),
  };
}

async function cleanup(
  db: Postgres,
  consumerName: string,
  eventIds: string[],
): Promise<void> {
  await db.pool.query(
    "delete from event_delivery_attempts where consumer_name=$1",
    [consumerName],
  );
  await db.pool.query("delete from event_quarantine where consumer_name=$1", [
    consumerName,
  ]);
  await db.pool.query("delete from event_deliveries where consumer_name=$1", [
    consumerName,
  ]);
  await db.pool.query("delete from event_consumers where consumer_name=$1", [
    consumerName,
  ]);
  if (eventIds.length > 0) {
    await db.pool.query("delete from event_outbox where event_id=any($1::uuid[])", [
      eventIds,
    ]);
  }
}

async function main(): Promise<void> {
  const db = new Postgres(databaseUrl);
  const consumerName = `benchmark-event-${randomUUID()}`;
  const eventIds: string[] = [];
  const parentByChild = new Map<string, string>();
  const retryTargets = new Set<string>();
  const latencies: number[] = [];
  const claimCounts = new Map<string, number>();
  const successCounts = new Map<string, number>();
  const foreignClaims: string[] = [];
  const causalityViolations: string[] = [];
  let retries = 0;
  let failure: string | undefined;
  let report: Record<string, unknown> | undefined;

  try {
    const preexisting = await db.pool.query<{ count: string }>(
      "select count(*)::text as count from event_outbox",
    );
    if (Number(preexisting.rows[0]?.count ?? 0) !== 0) {
      throw new Error(
        "EVENT_CONCURRENCY_BENCHMARK_REQUIRES_EMPTY_DISPOSABLE_OUTBOX",
      );
    }

    for (let index = 0; index < eventPairs; index += 1) {
      const rootId = randomUUID();
      const childId = randomUUID();
      eventIds.push(rootId, childId);
      if (index % retryEvery === 0) retryTargets.add(rootId);
      await appendOutboxEvent(db, {
        eventId: rootId,
        eventType: "SourceRegistered",
        resourceId: `benchmark-root-${index + 1}`,
        correlationId: `benchmark-pair-${index + 1}`,
        payload: { benchmark: true, pair: index + 1, role: "root" },
      });
      await appendOutboxEvent(db, {
        eventId: childId,
        eventType: "ExtractionRequested",
        resourceId: `benchmark-child-${index + 1}`,
        correlationId: `benchmark-pair-${index + 1}`,
        causationId: rootId,
        payload: { benchmark: true, pair: index + 1, role: "child" },
      });
      parentByChild.set(childId, rootId);
    }

    await registerEventConsumer(db, consumerName, {
      maxAttempts: 3,
      leaseSeconds: 30,
    });

    const seeded = await db.pool.query<{ count: string }>(
      "select count(*)::text as count from event_deliveries where consumer_name=$1",
      [consumerName],
    );
    if (Number(seeded.rows[0]?.count ?? 0) !== eventIds.length) {
      throw new Error("EVENT_CONCURRENCY_DELIVERY_FANOUT_MISMATCH");
    }

    const expected = new Set(eventIds);
    const started = performance.now();
    await Promise.all(
      Array.from({ length: workerCount }, async (_, workerIndex) => {
        const workerId = `event-benchmark-worker-${workerIndex + 1}`;
        while (true) {
          const claimStarted = performance.now();
          const claim = await claimNextEventDelivery(db, consumerName, workerId);
          latencies.push(performance.now() - claimStarted);
          if (!claim) return;

          const eventId = claim.event.eventId;
          if (!expected.has(eventId)) {
            foreignClaims.push(eventId);
            throw new Error(`Event worker claimed non-benchmark event ${eventId}`);
          }
          claimCounts.set(eventId, (claimCounts.get(eventId) ?? 0) + 1);

          const parentId = parentByChild.get(eventId);
          if (parentId) {
            const parent = await db.pool.query<{ status: string }>(
              `select status
                 from event_deliveries
                where event_id=$1 and consumer_name=$2`,
              [parentId, consumerName],
            );
            if (parent.rows[0]?.status !== "SUCCEEDED") {
              causalityViolations.push(
                `${eventId}:parent-${parentId}:${parent.rows[0]?.status ?? "MISSING"}`,
              );
            }
          }

          if (retryTargets.has(eventId) && claim.attempts === 1) {
            const result = await failEventDelivery(
              db,
              claim,
              new Error("BENCHMARK_CONTROLLED_RETRY"),
              { baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
            );
            if (result.status !== "RETRY") {
              throw new Error(`Controlled retry quarantined ${eventId}`);
            }
            retries += 1;
            continue;
          }

          await acknowledgeEventDelivery(db, claim);
          successCounts.set(eventId, (successCounts.get(eventId) ?? 0) + 1);
        }
      }),
    );
    const elapsedSeconds = Math.max(0.001, (performance.now() - started) / 1000);

    const deliveryState = await db.pool.query<{
      status: string;
      count: string;
    }>(
      `select status,count(*)::text as count
         from event_deliveries
        where consumer_name=$1
        group by status
        order by status`,
      [consumerName],
    );
    const stateCounts = Object.fromEntries(
      deliveryState.rows.map((row) => [row.status, Number(row.count)]),
    );
    const duplicateSuccesses = [...successCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([eventId, count]) => `${eventId}:${count}`);
    const successfulAttemptDuplicates = await db.pool.query<{
      event_id: string;
      count: string;
    }>(
      `select event_id::text,count(*)::text as count
         from event_delivery_attempts
        where consumer_name=$1 and outcome='SUCCEEDED'
        group by event_id
       having count(*) > 1`,
      [consumerName],
    );
    const retryAttempts = await db.pool.query<{ count: string }>(
      `select count(*)::text as count
         from event_delivery_attempts
        where consumer_name=$1 and outcome='RETRY'`,
      [consumerName],
    );
    const totalClaims = [...claimCounts.values()].reduce(
      (total, count) => total + count,
      0,
    );
    const acceptance = {
      allEventsSucceeded: stateCounts.SUCCEEDED === eventIds.length,
      exactSuccessfulEffects: successCounts.size === eventIds.length,
      controlledRetriesObserved:
        retries === retryTargets.size &&
        Number(retryAttempts.rows[0]?.count ?? 0) === retryTargets.size,
      causalOrderPreserved: causalityViolations.length === 0,
      noDuplicateSuccessfulEffects:
        duplicateSuccesses.length === 0 &&
        successfulAttemptDuplicates.rows.length === 0,
      noForeignClaims: foreignClaims.length === 0,
    };
    const status = Object.values(acceptance).every(Boolean) ? "PASSED" : "FAILED";

    report = {
      schemaVersion: "akp.event-concurrency-benchmark.v1",
      generatedAt: new Date().toISOString(),
      status,
      evidenceLevel: "LOCAL_POSTGRES_OUTBOX_CONCURRENCY",
      coverageStatus: "PARTIAL",
      workload: {
        eventPairs,
        totalEvents: eventIds.length,
        workers: workerCount,
        controlledRetryTargets: retryTargets.size,
      },
      acceptance,
      deliveryState: stateCounts,
      claims: {
        total: totalClaims,
        uniqueEvents: claimCounts.size,
        retriedClaims: retries,
        retryRatePerEvent: rounded(retries / eventIds.length),
        retryRatePerClaim: rounded(retries / Math.max(1, totalClaims)),
        throughputSucceededPerSecond: rounded(eventIds.length / elapsedSeconds),
        latency: summarize(latencies),
      },
      leaseContention: {
        workers: workerCount,
        duplicateSuccessfulEffects: duplicateSuccesses,
        duplicateSucceededAttemptRows: successfulAttemptDuplicates.rows,
        foreignClaims,
      },
      causality: {
        parentChildPairs: parentByChild.size,
        violations: causalityViolations,
      },
      measured: [
        "Concurrent durable event-delivery claims across multiple worker identities",
        "SKIP LOCKED lease contention and fencing through the production outbox claim/ack functions",
        "Parent-before-child causal eligibility under concurrent delivery",
        "Controlled zero-delay RETRY transitions through the production failure path",
        "Retry rate, claim p50/p95 latency, successful-delivery throughput and duplicate-success detection",
      ],
      notMeasured: [
        "Domain handler execution or external side effects after a delivery is claimed",
        "Network transport between separate worker processes",
        "Retry delays under wall-clock backoff intervals",
        "Failure injection during PostgreSQL restart; covered by the resilience matrix",
      ],
      limitations: [
        "Workers are concurrent async loops in one Node process against real PostgreSQL; this is bounded contention evidence, not a distributed throughput claim.",
        "The benchmark treats a durable SUCCEEDED acknowledgement as the observable effect boundary and does not claim idempotency of arbitrary external handlers.",
      ],
    };
    if (status !== "PASSED") process.exitCode = 1;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    report = {
      schemaVersion: "akp.event-concurrency-benchmark.v1",
      generatedAt: new Date().toISOString(),
      status: "FAILED",
      evidenceLevel: "LOCAL_POSTGRES_OUTBOX_CONCURRENCY",
      coverageStatus: "PARTIAL",
      failure,
    };
    process.exitCode = 1;
  } finally {
    try {
      await cleanup(db, consumerName, eventIds);
    } finally {
      await db.close();
    }
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
