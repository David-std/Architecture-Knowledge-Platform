import { describe, expect, it, vi } from "vitest";
import {
  appendOutboxEvent,
  retryDelayMs,
  type SqlExecutor,
} from "../src/outbox.js";

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
