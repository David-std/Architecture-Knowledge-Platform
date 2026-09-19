import { describe, expect, it, vi } from "vitest";
import type { OutboxEventRecord, Postgres } from "@akp/postgres";
import { createContinuousAssuranceEventHandlers } from "../src/assurance-events.js";

function sourceEvent(
  eventType: OutboxEventRecord["eventType"],
): OutboxEventRecord {
  return {
    eventId: "00000000-0000-0000-0000-000000000081",
    eventType,
    eventVersion: 1,
    resourceId: "00000000-0000-0000-0000-000000000082",
    organizationId: null,
    spaceId: "00000000-0000-0000-0000-000000000083",
    vaultId: "00000000-0000-0000-0000-000000000084",
    correlationId: null,
    causationId: null,
    occurredAt: "2026-09-19T18:00:00.000Z",
    createdAt: "2026-09-19T18:00:00.000Z",
    payload: {},
  };
}

describe("continuous assurance source event triggers", () => {
  it.each([
    "SourceRegistered",
    "ExtractionCompleted",
    "SourceWithdrawn",
    "EvidenceInvalidated",
  ] as const)("schedules %s as an idempotent SOURCE_CHANGE run", async (eventType) => {
    const calls: Array<{ sql: string; args?: unknown[] }> = [];
    const query = vi.fn(async (sql: string, args?: unknown[]) => {
      calls.push({ sql, args });
      if (/insert into assurance_runs/i.test(sql)) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000085",
              space_id: "00000000-0000-0000-0000-000000000083",
              vault_id: "00000000-0000-0000-0000-000000000084",
              trigger: "SOURCE_CHANGE",
              detectors: [
                "GROUNDING",
                "FRESHNESS",
                "CONTRADICTION",
                "DUPLICATE_IDENTITY",
                "TEMPORAL_CONSISTENCY",
                "LINK_ORPHAN",
              ],
              status: "PENDING",
              idempotency_key:
                "source-change:00000000-0000-0000-0000-000000000081",
              cursor: { detectorIndex: 0 },
              attempts: 0,
              max_attempts: 5,
              lease_owner: null,
              lease_token: 0,
              lease_expires_at: null,
              cancel_requested_at: null,
              next_attempt_at: "2026-09-19T18:00:00.000Z",
              created_at: "2026-09-19T18:00:00.000Z",
              updated_at: "2026-09-19T18:00:00.000Z",
            },
          ],
        };
      }
      return { rowCount: 0, rows: [] };
    });
    const db = { pool: { query } } as unknown as Postgres;
    const handlers = createContinuousAssuranceEventHandlers(db);
    const handler = handlers[eventType];
    if (!handler) throw new Error(`missing handler for ${eventType}`);

    await handler(sourceEvent(eventType));

    const inserted = calls.find((call) =>
      /insert into assurance_runs/i.test(call.sql),
    );
    expect(inserted?.args).toEqual([
      "00000000-0000-0000-0000-000000000083",
      "00000000-0000-0000-0000-000000000084",
      "SOURCE_CHANGE",
      [
        "GROUNDING",
        "FRESHNESS",
        "CONTRADICTION",
        "DUPLICATE_IDENTITY",
        "TEMPORAL_CONSISTENCY",
        "LINK_ORPHAN",
      ],
      "source-change:00000000-0000-0000-0000-000000000081",
      null,
      null,
      5,
    ]);
  });

  it("fails closed when a source event has no vault scope", async () => {
    const db = {
      pool: { query: vi.fn() },
    } as unknown as Postgres;
    const handler =
      createContinuousAssuranceEventHandlers(db).SourceRegistered;
    if (!handler) throw new Error("SourceRegistered handler missing");

    await expect(
      handler({
        ...sourceEvent("SourceRegistered"),
        vaultId: null,
      }),
    ).rejects.toThrow("ASSURANCE_SOURCE_CHANGE_SCOPE_REQUIRED");
    expect(db.pool.query).not.toHaveBeenCalled();
  });
});
