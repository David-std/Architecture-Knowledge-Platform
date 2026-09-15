import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  acknowledgeEventDelivery,
  appendOutboxEvent,
  claimNextEventDelivery,
  registerEventConsumer,
  retryDelayMs,
  type SqlExecutor,
} from "../src/outbox.js";
import { Postgres } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

describe("outbox retry policy", () => {
  it("keeps jitter bounded and caps exponential growth", () => {
    const policy = {
      baseDelayMs: 1_000,
      maxDelayMs: 5_000,
      jitterRatio: 0.2,
    };
    expect(retryDelayMs(1, policy, () => 0)).toBe(800);
    expect(retryDelayMs(1, policy, () => 1)).toBe(1_200);
    expect(retryDelayMs(20, policy, () => 0.5)).toBe(5_000);
  });

  it("rejects invalid attempts and policies", () => {
    expect(() => retryDelayMs(0)).toThrow("RETRY_ATTEMPT_MUST_BE_POSITIVE");
    expect(() =>
      retryDelayMs(1, { baseDelayMs: 2, maxDelayMs: 1, jitterRatio: 0 }),
    ).toThrow("INVALID_RETRY_POLICY");
    expect(() =>
      retryDelayMs(1, {
        baseDelayMs: 1,
        maxDelayMs: 2,
        jitterRatio: Number.NaN,
      }),
    ).toThrow("INVALID_RETRY_POLICY");
  });
});

describe("appendOutboxEvent", () => {
  it("rejects projection events without an explicit vault scope", async () => {
    await expect(
      appendOutboxEvent({ query: vi.fn() } as unknown as SqlExecutor, {
        eventType: "CorpusRevisionPublished",
        resourceId: "revision-1",
        spaceId: "00000000-0000-0000-0000-000000000003",
        payload: { revision: "managed-1" },
      }),
    ).rejects.toThrow("EVENT_VAULT_SCOPE_REQUIRED");
  });

  it("validates and persists a versioned envelope through the caller transaction", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          event_id: "00000000-0000-0000-0000-000000000010",
          event_type: "ExtractionRequested",
          event_version: 1,
          resource_id: "job-1",
          organization_id: null,
          space_id: "00000000-0000-0000-0000-000000000003",
          vault_id: null,
          correlation_id: "job-1",
          causation_id: null,
          occurred_at: "2026-08-10T00:00:00.000Z",
          payload: { jobId: "job-1" },
          created_at: "2026-08-10T00:00:00.000Z",
        },
      ],
    });
    const executor = { query } as unknown as SqlExecutor;

    const event = await appendOutboxEvent(executor, {
      eventId: "00000000-0000-0000-0000-000000000010",
      eventType: "ExtractionRequested",
      resourceId: "job-1",
      spaceId: "00000000-0000-0000-0000-000000000003",
      correlationId: "job-1",
      payload: { jobId: "job-1" },
      occurredAt: "2026-08-10T00:00:00.000Z",
    });

    expect(event.eventId).toBe("00000000-0000-0000-0000-000000000010");
    expect(event.eventType).toBe("ExtractionRequested");
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "insert into event_outbox",
    );
  });
});

describe("durable outbox trace context", () => {
  it.skipIf(!databaseUrl)(
    "persists W3C trace metadata through a durable delivery claim",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const eventId = randomUUID();
      const consumerName = `trace-context-${randomUUID()}`;
      const telemetry = {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
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

        const persisted = await db.pool.query<{
          telemetry_metadata: unknown;
        }>("select telemetry_metadata from event_outbox where event_id=$1", [
          eventId,
        ]);
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
