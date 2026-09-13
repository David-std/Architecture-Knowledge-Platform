import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  acknowledgeEventDelivery,
  appendOutboxEvent,
  claimNextEventDelivery,
  failEventDelivery,
  Postgres,
  registerEventConsumer,
} from "@akp/postgres";
import { drainToQuiescence, WorkerDrainError } from "../src/drain.js";

const databaseUrl = process.env.DATABASE_URL;

async function removeConsumer(
  db: Postgres,
  consumerName: string,
): Promise<void> {
  await db.pool.query("delete from event_deliveries where consumer_name=$1", [
    consumerName,
  ]);
  await db.pool.query("delete from event_consumers where consumer_name=$1", [
    consumerName,
  ]);
  await db.pool.end();
}

async function seedOneEvent(
  db: Postgres,
  consumerName: string,
  eventId: string,
  options: { maxAttempts?: number; leaseSeconds?: number } = {},
): Promise<void> {
  await appendOutboxEvent(db, {
    eventId,
    eventType: "ExtractionRequested",
    resourceId: randomUUID(),
    payload: { integrationTest: true },
  });
  await registerEventConsumer(db, consumerName, options);
  await db.pool.query(
    "delete from event_deliveries where consumer_name=$1 and event_id<>$2",
    [consumerName, eventId],
  );
}

async function seedCausalPair(
  db: Postgres,
  consumerName: string,
  parentId: string,
  childId: string,
  options: { maxAttempts?: number; leaseSeconds?: number } = {},
): Promise<void> {
  await appendOutboxEvent(db, {
    eventId: childId,
    eventType: "ExtractionCompleted",
    resourceId: randomUUID(),
    causationId: parentId,
    payload: { integrationTest: true },
  });
  await appendOutboxEvent(db, {
    eventId: parentId,
    eventType: "ExtractionRequested",
    resourceId: randomUUID(),
    payload: { integrationTest: true },
  });
  await registerEventConsumer(db, consumerName, options);
  await db.pool.query(
    "delete from event_deliveries where consumer_name=$1 and event_id<>all($2::uuid[])",
    [consumerName, [parentId, childId]],
  );
}

async function seedIngestJob(db: Postgres): Promise<string> {
  const jobId = randomUUID();
  const space = await db.pool.query<{ id: string }>(
    "select id from spaces order by created_at limit 1",
  );
  const spaceId = space.rows[0]?.id;
  if (!spaceId) throw new Error("expected an integration-test space");
  await db.pool.query(
    `
    insert into ingest_jobs(
      id,space_id,source_uri,state,payload,next_attempt_at
    ) values($1,$2,$3,'RECEIVED',$4::jsonb,now())
    `,
    [
      jobId,
      spaceId,
      `worker-drain://${jobId}`,
      JSON.stringify({ integrationTest: true }),
    ],
  );
  return jobId;
}

function noIngestJobs(): (job: Record<string, unknown>) => Promise<void> {
  return async () => {
    throw new Error("UNEXPECTED_INGEST_JOB");
  };
}

describe("worker drain integration", () => {
  it.skipIf(!databaseUrl)(
    "rechecks when a durable delivery becomes claimable after an empty claim",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const consumerName = `drain-claim-race-${randomUUID()}`;
      const eventId = randomUUID();
      try {
        await seedOneEvent(db, consumerName, eventId);
        let attempts = 0;
        const summary = await drainToQuiescence({
          db,
          consumerName,
          workerId: "drain-claim-race-worker",
          deadlineMs: 2_000,
          runEventOnce: async () => {
            attempts += 1;
            if (attempts === 1) return false;
            const claim = await claimNextEventDelivery(
              db,
              consumerName,
              "drain-claim-race-worker",
            );
            if (!claim) return false;
            expect(claim.event.eventId).toBe(eventId);
            await acknowledgeEventDelivery(db, claim);
            return true;
          },
          runIngestJob: noIngestJobs(),
        });
        expect(summary).toMatchObject({
          status: "SUCCEEDED",
          reason: "QUIESCENT",
          eventsProcessed: 1,
          deliveries: { nonTerminal: 0, succeeded: 1 },
        });
        expect(attempts).toBeGreaterThanOrEqual(2);
      } finally {
        await removeConsumer(db, consumerName);
      }
    },
  );

  it.skipIf(!databaseUrl)(
    "rechecks when an immediately claimable ingest job follows an empty claim",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const consumerName = `drain-ingest-claim-race-${randomUUID()}`;
      const jobId = await seedIngestJob(db);
      let claimAttempts = 0;
      let firstClaimSawClaimable = false;
      let processedJobId: string | null = null;
      const lockClient = await db.pool.connect();
      const originalPoolQuery = db.pool.query;
      const originalQuery = db.pool.query.bind(db.pool);
      let lockReleased = false;
      await lockClient.query("begin");
      await lockClient.query(
        "select id from ingest_jobs where id=$1 for update",
        [jobId],
      );
      db.pool.query = (async (text: string, values?: unknown[]) => {
        const result = await originalQuery(text, values);
        if (!lockReleased && text.includes("for update skip locked")) {
          claimAttempts += 1;
          expect(result.rows).toHaveLength(0);
          const visible = await originalQuery(
            `
            select count(*)::int count
              from ingest_jobs
             where id=$1
               and state in (
                 'RECEIVED', 'HASHED', 'STORED', 'NORMALIZING',
                 'ANALYZING', 'PLANNED', 'DRAFTED', 'VALIDATING',
                 'AUTO_APPROVED', 'MERGED', 'INDEXED', 'EVALUATED'
               )
               and cancelled_at is null
               and next_attempt_at<=now()
               and (lease_expires_at is null or lease_expires_at<=now())
            `,
            [jobId],
          );
          firstClaimSawClaimable = Number(visible.rows[0]?.count ?? 0) === 1;
          await lockClient.query("commit");
          lockClient.release();
          lockReleased = true;
        } else if (text.includes("for update skip locked")) {
          claimAttempts += 1;
        }
        return result;
      }) as typeof db.pool.query;
      try {
        const summary = await drainToQuiescence({
          db,
          consumerName,
          workerId: `drain-ingest-claim-race-worker-${randomUUID()}`,
          deadlineMs: 2_000,
          runEventOnce: async () => false,
          runIngestJob: async (job) => {
            processedJobId = String(job.id);
            await db.pool.query(
              `
              update ingest_jobs
                 set state='COMPLETED',lease_owner=null,
                     lease_expires_at=null,updated_at=now()
               where id=$1
              `,
              [job.id],
            );
          },
        });
        expect(summary).toMatchObject({
          status: "SUCCEEDED",
          success: true,
          reason: "QUIESCENT",
          eventsProcessed: 0,
          ingestJobsProcessed: 1,
          ingest: { work: 0, immediatelyClaimable: 0 },
        });
        expect(firstClaimSawClaimable).toBe(true);
        expect(processedJobId).toBe(jobId);
        expect(claimAttempts).toBeGreaterThanOrEqual(2);
      } finally {
        db.pool.query = originalPoolQuery;
        if (!lockReleased) {
          await lockClient.query("rollback").catch(() => undefined);
          lockClient.release();
        }
        await db.pool.query("delete from ingest_jobs where id=$1", [jobId]);
        await db.pool.end();
      }
    },
  );

  it.skipIf(!databaseUrl)(
    "waits for a persisted retry timestamp and emits a quiescent summary",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const consumerName = `drain-retry-${randomUUID()}`;
      const eventId = randomUUID();
      try {
        await seedOneEvent(db, consumerName, eventId, {
          maxAttempts: 2,
          leaseSeconds: 5,
        });
        const firstClaim = await claimNextEventDelivery(
          db,
          consumerName,
          "retry-fixture",
        );
        expect(firstClaim?.event.eventId).toBe(eventId);
        if (!firstClaim) throw new Error("expected retry fixture claim");
        expect(
          await failEventDelivery(
            db,
            firstClaim,
            "transient integration failure",
            { baseDelayMs: 100, maxDelayMs: 100, jitterRatio: 0 },
          ),
        ).toMatchObject({ status: "RETRY", delayMs: 100 });

        const summary = await drainToQuiescence({
          db,
          consumerName,
          workerId: "drain-retry-worker",
          deadlineMs: 2_000,
          runEventOnce: async () => {
            const claim = await claimNextEventDelivery(
              db,
              consumerName,
              "drain-retry-worker",
            );
            if (!claim) return false;
            expect(claim.event.eventId).toBe(eventId);
            await acknowledgeEventDelivery(db, claim);
            return true;
          },
          runIngestJob: noIngestJobs(),
        });
        expect(summary).toMatchObject({
          mode: "DRAIN",
          status: "SUCCEEDED",
          success: true,
          reason: "QUIESCENT",
          eventsProcessed: 1,
          ingestJobsProcessed: 0,
          deliveries: {
            scheduledRetry: 0,
            nonTerminal: 0,
            succeeded: 1,
          },
        });
      } finally {
        await removeConsumer(db, consumerName);
      }
    },
  );

  it.skipIf(!databaseUrl)(
    "waits for an active lease to expire before claiming the delivery",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const consumerName = `drain-lease-${randomUUID()}`;
      const eventId = randomUUID();
      try {
        await seedOneEvent(db, consumerName, eventId, { leaseSeconds: 5 });
        const lease = await claimNextEventDelivery(
          db,
          consumerName,
          "lease-fixture",
        );
        expect(lease?.event.eventId).toBe(eventId);
        if (!lease) throw new Error("expected lease fixture claim");
        await db.pool.query(
          `update event_deliveries
              set lease_expires_at=now()+interval '100 milliseconds'
            where event_id=$1 and consumer_name=$2`,
          [eventId, consumerName],
        );

        const summary = await drainToQuiescence({
          db,
          consumerName,
          workerId: "drain-lease-worker",
          deadlineMs: 2_000,
          runEventOnce: async () => {
            const claim = await claimNextEventDelivery(
              db,
              consumerName,
              "drain-lease-worker",
            );
            if (!claim) return false;
            expect(claim.event.eventId).toBe(eventId);
            await acknowledgeEventDelivery(db, claim);
            return true;
          },
          runIngestJob: noIngestJobs(),
        });
        expect(summary).toMatchObject({
          status: "SUCCEEDED",
          reason: "QUIESCENT",
          eventsProcessed: 1,
          deliveries: { leased: 0, nonTerminal: 0, succeeded: 1 },
        });
      } finally {
        await removeConsumer(db, consumerName);
      }
    },
  );

  it.skipIf(!databaseUrl)(
    "fails closed immediately when a delivery is quarantined",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const consumerName = `drain-quarantine-${randomUUID()}`;
      const parentId = randomUUID();
      const childId = randomUUID();
      try {
        await seedCausalPair(db, consumerName, parentId, childId, {
          maxAttempts: 1,
          leaseSeconds: 5,
        });
        const claim = await claimNextEventDelivery(
          db,
          consumerName,
          "quarantine-fixture",
        );
        expect(claim?.event.eventId).toBe(parentId);
        if (!claim) throw new Error("expected quarantine fixture claim");
        await expect(
          failEventDelivery(db, claim, "permanent integration failure", {
            baseDelayMs: 1,
            maxDelayMs: 1,
            jitterRatio: 0,
          }),
        ).resolves.toMatchObject({ status: "QUARANTINED" });
        expect(
          await claimNextEventDelivery(
            db,
            consumerName,
            "quarantine-child-worker",
          ),
        ).toBeNull();

        await expect(
          drainToQuiescence({
            db,
            consumerName,
            workerId: "drain-quarantine-worker",
            deadlineMs: 2_000,
            runEventOnce: async () => false,
            runIngestJob: noIngestJobs(),
          }),
        ).rejects.toMatchObject({
          name: "WorkerDrainError",
          summary: {
            status: "FAILED",
            success: false,
            reason: "QUARANTINED",
            eventsProcessed: 0,
            deliveries: {
              quarantined: 1,
              causallyBlocked: 1,
              nonTerminal: 1,
            },
          },
        });
      } finally {
        await removeConsumer(db, consumerName);
      }
    },
  );

  it.skipIf(!databaseUrl)(
    "fails at the configured deadline when durable work has no wakeup yet",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const consumerName = `drain-deadline-${randomUUID()}`;
      const eventId = randomUUID();
      try {
        await seedOneEvent(db, consumerName, eventId);
        await db.pool.query(
          `update event_deliveries
              set next_attempt_at=now()+interval '1 hour'
            where event_id=$1 and consumer_name=$2`,
          [eventId, consumerName],
        );
        let failure: unknown;
        try {
          await drainToQuiescence({
            db,
            consumerName,
            workerId: "drain-deadline-worker",
            deadlineMs: 100,
            runEventOnce: async () => false,
            runIngestJob: noIngestJobs(),
          });
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(WorkerDrainError);
        if (!(failure instanceof WorkerDrainError)) {
          throw new Error("expected WorkerDrainError");
        }
        expect(failure.summary).toMatchObject({
          status: "FAILED",
          success: false,
          reason: "DEADLINE_EXCEEDED",
          deliveries: { scheduledRetry: 1, nonTerminal: 1 },
        });
      } finally {
        await removeConsumer(db, consumerName);
      }
    },
  );
});
