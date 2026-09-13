import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  acknowledgeEventDelivery,
  appendOutboxEvent,
  claimNextEventDelivery,
  registerEventConsumer,
} from "../src/outbox.js";
import { Postgres } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

describe("durable outbox trace context", () => {
  it.skipIf(!databaseUrl)(
    "persists W3C trace metadata through a durable delivery claim",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const eventId = randomUUID();
      const consumerName = `trace-context-${randomUUID()}`;
      const telemetry = {
        traceparent:
          "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        tracestate: "vendor=value",
      };

      try {
        const appended = await appendOutboxEvent(db, {
          eventId,
          eventType: "ExtractionRequested",
          resourceId: randomUUID(),
          correlationId: eventId,
          payload: { integrationTest: "trace-context" },
          telemetry,
        });
        expect(appended.telemetry).toEqual(telemetry);

        const persisted = await db.pool.query<{ telemetry_metadata: unknown }>(
          "select telemetry_metadata from event_outbox where event_id=$1",
          [eventId],
        );
        expect(persisted.rows[0]?.telemetry_metadata).toEqual(telemetry);

        await registerEventConsumer(db, consumerName);
        await db.pool.query(
          "delete from event_deliveries where consumer_name=$1 and event_id<>$2",
          [consumerName, eventId],
        );

        const claim = await claimNextEventDelivery(
          db,
          consumerName,
          "trace-context-worker",
        );
        expect(claim?.event.eventId).toBe(eventId);
        expect(claim?.event.telemetry).toEqual(telemetry);
        if (!claim) throw new Error("expected trace-context delivery claim");
        await acknowledgeEventDelivery(db, claim);
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
