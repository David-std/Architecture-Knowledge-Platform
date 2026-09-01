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
