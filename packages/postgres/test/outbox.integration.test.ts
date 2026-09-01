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
  summarizeOutbox,
} from "../src/outbox.js";
import { Postgres } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

describe("durable outbox integration", () => {
  it.skipIf(!databaseUrl)(
    "delivers an internal causal predecessor before its dependent event",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const consumerName = `causal-test-${randomUUID()}`;
      const parentId = randomUUID();
      const childId = randomUUID();
      try {
        // Persist the child first to prove claim ordering does not depend on
        // timestamps or random event identifiers when the parent exists.
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
        await registerEventConsumer(db, consumerName);
        await db.pool.query(
          "delete from event_deliveries where consumer_name=$1 and event_id<>all($2::uuid[])",
          [consumerName, [parentId, childId]],
        );

        const parent = await claimNextEventDelivery(
          db,
          consumerName,
          "causal-worker",
        );
        expect(parent?.event.eventId).toBe(parentId);
        if (!parent) throw new Error("expected causal parent claim");
        await acknowledgeEventDelivery(db, parent);

        const child = await claimNextEventDelivery(
          db,
          consumerName,
          "causal-worker",
        );
        expect(child?.event.eventId).toBe(childId);
        if (!child) throw new Error("expected dependent child claim");
        await acknowledgeEventDelivery(db, child);
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

  it.skipIf(!databaseUrl)(
    "reports durable drain buckets and leaves unrelated roots claimable",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const consumerName = `summary-test-${randomUUID()}`;
      const parentId = randomUUID();
      const childId = randomUUID();
      const unrelatedRootId = randomUUID();
      const retryId = randomUUID();
      const leasedId = randomUUID();
      const quarantinedId = randomUUID();
      const succeededId = randomUUID();
      const targetIds = [
        parentId,
        childId,
        unrelatedRootId,
        retryId,
        leasedId,
        quarantinedId,
        succeededId,
      ];
      try {
        await appendOutboxEvent(db, {
          eventId: parentId,
          eventType: "ExtractionRequested",
          resourceId: randomUUID(),
          payload: { integrationTest: true },
        });
        await appendOutboxEvent(db, {
          eventId: childId,
          eventType: "ExtractionCompleted",
          resourceId: randomUUID(),
          causationId: parentId,
          payload: { integrationTest: true },
        });
        for (const eventId of [
          unrelatedRootId,
          retryId,
          leasedId,
          quarantinedId,
          succeededId,
        ]) {
          await appendOutboxEvent(db, {
            eventId,
            eventType: "ExtractionRequested",
            resourceId: randomUUID(),
            payload: { integrationTest: true },
          });
        }
        await registerEventConsumer(db, consumerName, {
          maxAttempts: 8,
          leaseSeconds: 20,
        });
        await db.pool.query(
          "delete from event_deliveries where consumer_name=$1 and event_id<>all($2::uuid[])",
          [consumerName, targetIds],
        );

        // Seed each durable state directly so this assertion is independent
        // of UUID ordering and does not sleep. The transition APIs are covered
        // by the lease/quarantine integration test above.
        await db.pool.query(
          `update event_deliveries
              set status='PENDING',attempts=0,next_attempt_at=now(),
                  lease_owner=null,lease_token=null,lease_expires_at=null,
                  heartbeat_at=null,completed_at=null,last_error=null
            where consumer_name=$1 and event_id=any($2::uuid[])`,
          [consumerName, [parentId, childId, unrelatedRootId]],
        );
        await db.pool.query(
          `update event_deliveries
              set status='RETRY',attempts=1,
                  next_attempt_at=now()+interval '1 hour',
                  lease_owner=null,lease_token=null,lease_expires_at=null,
                  heartbeat_at=null,completed_at=null
            where consumer_name=$1 and event_id=$2`,
          [consumerName, retryId],
        );
        // A child in RETRY remains causally blocked until its known parent is
        // acknowledged, even when its own retry timestamp has elapsed.
        await db.pool.query(
          `update event_deliveries
              set status='RETRY',attempts=1,
                  next_attempt_at=now()-interval '1 second'
            where consumer_name=$1 and event_id=$2`,
          [consumerName, childId],
        );
        await db.pool.query(
          `update event_deliveries
              set status='CLAIMED',attempts=1,lease_owner='summary-lease',
                  lease_token=gen_random_uuid(),fencing_version=1,
                  lease_expires_at=now()+interval '1 hour',heartbeat_at=now(),
                  completed_at=null
            where consumer_name=$1 and event_id=$2`,
          [consumerName, leasedId],
        );
        await db.pool.query(
          `update event_deliveries
              set status='QUARANTINED',attempts=1,
                  lease_owner=null,lease_token=null,lease_expires_at=null,
                  heartbeat_at=now(),completed_at=null
            where consumer_name=$1 and event_id=$2`,
          [consumerName, quarantinedId],
        );
        await db.pool.query(
          `update event_deliveries
              set status='SUCCEEDED',attempts=1,
                  lease_owner=null,lease_token=null,lease_expires_at=null,
                  heartbeat_at=now(),completed_at=now()
            where consumer_name=$1 and event_id=$2`,
          [consumerName, succeededId],
        );

        const summary = await summarizeOutbox(db, consumerName);
        expect(summary).toMatchObject({
          consumerName,
          total: 7,
          immediatelyClaimable: 2,
          causallyBlocked: 1,
          scheduledRetry: 1,
          leased: 1,
          quarantined: 1,
          succeeded: 1,
          nonTerminal: 5,
        });
        expect(summary.nextWakeAt).toBeTruthy();
        expect(new Date(summary.nextWakeAt ?? 0).getTime()).toBeGreaterThan(
          Date.now(),
        );

        const firstRoot = await claimNextEventDelivery(
          db,
          consumerName,
          "summary-worker-0",
        );
        expect(firstRoot).not.toBeNull();
        if (!firstRoot) throw new Error("expected a claimable root");
        expect([parentId, unrelatedRootId]).toContain(firstRoot.event.eventId);

        let claimedParent =
          firstRoot.event.eventId === parentId ? firstRoot : null;
        if (!claimedParent) await acknowledgeEventDelivery(db, firstRoot);

        // Keep a claimed parent unacknowledged while selecting again. The
        // child must remain blocked and the unrelated root must remain free.
        const secondRoot = await claimNextEventDelivery(
          db,
          consumerName,
          "summary-worker-1",
        );
        expect(secondRoot).not.toBeNull();
        if (!secondRoot) throw new Error("expected the other claimable root");
        if (claimedParent) {
          expect(secondRoot.event.eventId).toBe(unrelatedRootId);
          await acknowledgeEventDelivery(db, secondRoot);
        } else {
          expect(secondRoot.event.eventId).toBe(parentId);
          claimedParent = secondRoot;
        }
        await acknowledgeEventDelivery(db, claimedParent);
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

  it.skipIf(!databaseUrl)(
    "blocks a child while its parent is in scheduled RETRY",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const consumerName = `causal-retry-${randomUUID()}`;
      const parentId = randomUUID();
      const childId = randomUUID();
      try {
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
        await registerEventConsumer(db, consumerName, {
          maxAttempts: 2,
          leaseSeconds: 20,
        });
        await db.pool.query(
          "delete from event_deliveries where consumer_name=$1 and event_id<>all($2::uuid[])",
          [consumerName, [parentId, childId]],
        );
        const parent = await claimNextEventDelivery(
          db,
          consumerName,
          "causal-retry-worker",
        );
        expect(parent?.event.eventId).toBe(parentId);
        if (!parent) throw new Error("expected parent retry claim");
        await expect(
          failEventDelivery(db, parent, "transient parent failure", {
            baseDelayMs: 1,
            maxDelayMs: 1,
            jitterRatio: 0,
          }),
        ).resolves.toMatchObject({ status: "RETRY" });
        await db.pool.query(
          `update event_deliveries
              set next_attempt_at=now()+interval '1 hour'
            where event_id=$1 and consumer_name=$2`,
          [parentId, consumerName],
        );

        // The child is due, but its parent is not terminally successful. The
        // claim query must leave both rows untouched until the retry is due.
        expect(
          await claimNextEventDelivery(
            db,
            consumerName,
            "causal-retry-child-worker",
          ),
        ).toBeNull();
        await expect(summarizeOutbox(db, consumerName)).resolves.toMatchObject({
          total: 2,
          immediatelyClaimable: 0,
          causallyBlocked: 1,
          scheduledRetry: 1,
          nonTerminal: 2,
        });
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

  it.skipIf(!databaseUrl)(
    "does not release a child when its parent is quarantined",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const consumerName = `causal-quarantine-${randomUUID()}`;
      const parentId = randomUUID();
      const childId = randomUUID();
      try {
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
        await registerEventConsumer(db, consumerName, {
          maxAttempts: 1,
          leaseSeconds: 20,
        });
        await db.pool.query(
          "delete from event_deliveries where consumer_name=$1 and event_id<>all($2::uuid[])",
          [consumerName, [parentId, childId]],
        );
        const parent = await claimNextEventDelivery(
          db,
          consumerName,
          "causal-quarantine-worker",
        );
        expect(parent?.event.eventId).toBe(parentId);
        if (!parent) throw new Error("expected parent quarantine claim");
        await expect(
          failEventDelivery(db, parent, "permanent parent failure", {
            baseDelayMs: 1,
            maxDelayMs: 1,
            jitterRatio: 0,
          }),
        ).resolves.toMatchObject({ status: "QUARANTINED" });

        expect(
          await claimNextEventDelivery(
            db,
            consumerName,
            "causal-quarantine-child-worker",
          ),
        ).toBeNull();
        await expect(summarizeOutbox(db, consumerName)).resolves.toMatchObject({
          total: 2,
          immediatelyClaimable: 0,
          causallyBlocked: 1,
          quarantined: 1,
          nonTerminal: 1,
        });
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

  it.skipIf(!databaseUrl)(
    "reclaims an expired parent lease before considering its child",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const consumerName = `causal-lease-${randomUUID()}`;
      const parentId = randomUUID();
      const childId = randomUUID();
      try {
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
        await registerEventConsumer(db, consumerName, { leaseSeconds: 20 });
        await db.pool.query(
          "delete from event_deliveries where consumer_name=$1 and event_id<>all($2::uuid[])",
          [consumerName, [parentId, childId]],
        );
        const firstClaim = await claimNextEventDelivery(
          db,
          consumerName,
          "causal-lease-worker-a",
        );
        expect(firstClaim?.event.eventId).toBe(parentId);
        if (!firstClaim) throw new Error("expected parent lease claim");
        await db.pool.query(
          `update event_deliveries
              set lease_expires_at=now()-interval '1 second'
            where event_id=$1 and consumer_name=$2`,
          [parentId, consumerName],
        );
        const reclaimed = await claimNextEventDelivery(
          db,
          consumerName,
          "causal-lease-worker-b",
        );
        expect(reclaimed?.event.eventId).toBe(parentId);
        if (!reclaimed) throw new Error("expected expired parent reclaim");
        expect(reclaimed.fencingVersion).toBeGreaterThan(
          firstClaim.fencingVersion,
        );
        await acknowledgeEventDelivery(db, reclaimed);

        const child = await claimNextEventDelivery(
          db,
          consumerName,
          "causal-lease-child-worker",
        );
        expect(child?.event.eventId).toBe(childId);
        if (!child) throw new Error("expected child after parent success");
        await acknowledgeEventDelivery(db, child);
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
