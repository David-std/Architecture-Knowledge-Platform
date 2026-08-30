import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  acknowledgeEventDelivery,
  appendOutboxEvent,
  claimNextEventDelivery,
  failEventDelivery,
  heartbeatEventDelivery,
  listQuarantinedEvents,
  reconcileOutbox,
  registerEventConsumer,
  requeueEventDelivery,
} from "../src/outbox.js";
import { Postgres } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

describe("durable outbox integration", () => {
  it.skipIf(!databaseUrl)(
    "recovers a leased event after restart, fences the old worker, and requeues poison work",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const consumerName = `test-${randomUUID()}`;
      const eventId = randomUUID();
      try {
        const first = await appendOutboxEvent(db, {
          eventId,
          eventType: "ExtractionRequested",
          resourceId: randomUUID(),
          correlationId: eventId,
          payload: { integrationTest: true },
        });
        const duplicate = await appendOutboxEvent(db, {
          eventId,
          eventType: first.eventType,
          resourceId: first.resourceId,
          correlationId: eventId,
          payload: { integrationTest: true },
        });
        expect(duplicate.eventId).toBe(first.eventId);

        // Register after append so the target is created by the restart/backfill
        // path. A shared development database may contain unrelated historical
        // events, so remove only this disposable consumer's non-target
        // deliveries instead of spending the test timeout draining them.
        await registerEventConsumer(db, consumerName, {
          maxAttempts: 1,
          leaseSeconds: 20,
        });
        await db.pool.query(
          "delete from event_deliveries where consumer_name=$1 and event_id<>$2",
          [consumerName, eventId],
        );

        const workerA = await claimNextEventDelivery(
          db,
          consumerName,
          "worker-a",
        );
        expect(workerA?.event.eventId).toBe(eventId);
        if (!workerA) throw new Error("expected worker-a claim");
        const claimedAttempt = await db.pool.query(
          `select outcome,worker_id,fencing_version
             from event_delivery_attempts
            where event_id=$1 and consumer_name=$2
            order by id desc limit 1`,
          [eventId, consumerName],
        );
        expect(claimedAttempt.rows[0]).toMatchObject({
          outcome: "CLAIMED",
          worker_id: "worker-a",
        });
        expect(await heartbeatEventDelivery(db, workerA)).toBe(true);

        // A crashed worker's lease can be reclaimed.  Make the lease expired
        // through SQL rather than sleeping so this remains deterministic.
        await db.pool.query(
          `update event_deliveries
              set lease_expires_at=now()-interval '1 second'
            where event_id=$1 and consumer_name=$2`,
          [eventId, consumerName],
        );
        const workerB = await claimNextEventDelivery(
          db,
          consumerName,
          "worker-b",
        );
        expect(workerB?.fencingVersion).toBeGreaterThan(workerA.fencingVersion);
        if (!workerB) throw new Error("expected worker-b reclaim");
        await expect(acknowledgeEventDelivery(db, workerA)).rejects.toThrow(
          "EVENT_LEASE_LOST",
        );

        const failed = await failEventDelivery(
          db,
          {
            ...workerB,
          },
          "poison payload",
          { baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
        );
        expect(failed.status).toBe("QUARANTINED");
        const quarantinedAttempt = await db.pool.query(
          `select outcome,worker_id,fencing_version
             from event_delivery_attempts
            where event_id=$1 and consumer_name=$2
            order by id desc limit 1`,
          [eventId, consumerName],
        );
        expect(quarantinedAttempt.rows[0]).toMatchObject({
          outcome: "QUARANTINED",
          worker_id: "worker-b",
        });
        expect((await reconcileOutbox(db, consumerName)).quarantined).toBe(1);
        expect((await listQuarantinedEvents(db, consumerName)).length).toBe(1);
        expect(
          await requeueEventDelivery(
            db,
            eventId,
            consumerName,
            "integration-test",
          ),
        ).toBe(true);

        const workerC = await claimNextEventDelivery(
          db,
          consumerName,
          "worker-c",
        );
        expect(workerC?.deliveryGeneration).toBeGreaterThan(
          workerB.deliveryGeneration,
        );
        if (!workerC) throw new Error("expected worker-c claim after requeue");
        await acknowledgeEventDelivery(db, workerC);
        const succeededAttempt = await db.pool.query(
          `select outcome,worker_id
             from event_delivery_attempts
            where event_id=$1 and consumer_name=$2
            order by id desc limit 1`,
          [eventId, consumerName],
        );
        expect(succeededAttempt.rows[0]).toMatchObject({
          outcome: "SUCCEEDED",
          worker_id: "worker-c",
        });
        const finalReport = await reconcileOutbox(db, consumerName);
        expect(finalReport.unconsumed).toBe(0);
        expect(finalReport.staleClaims).toBe(0);
      } finally {
        await db.pool.query(
          "delete from event_deliveries where consumer_name=$1",
          [consumerName],
        );
        await db.pool.query(
          "delete from event_consumers where consumer_name=$1",
          [consumerName],
        );
        await db.pool.end();
      }
    },
  );
});
