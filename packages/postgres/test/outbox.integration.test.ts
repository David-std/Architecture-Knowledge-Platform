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
        // The migration's seed trigger fans out to this consumer. Registering
        // before append also exercises the backfill path used by restarts.
        await registerEventConsumer(db, consumerName, {
          maxAttempts: 1,
          leaseSeconds: 20,
        });
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

        let workerA = await claimNextEventDelivery(
          db,
          consumerName,
          "worker-a",
        );
        // A durable consumer backfills all historical events at registration.
        // Drain older rows so this test remains repeatable against a shared
        // development database while still exercising the backfill contract.
        for (
          let attempt = 0;
          workerA && workerA.event.eventId !== eventId;
          attempt += 1
        ) {
          if (attempt >= 500) throw new Error("target event was not claimable");
          await acknowledgeEventDelivery(db, workerA);
          workerA = await claimNextEventDelivery(db, consumerName, "worker-a");
        }
        expect(workerA?.event.eventId).toBe(eventId);
        if (!workerA) throw new Error("expected worker-a claim");
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
