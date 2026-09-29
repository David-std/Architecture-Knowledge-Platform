import { describe, expect, it, vi } from "vitest";
import type { Postgres } from "../src/index.js";
import {
  quarantineResourceKey,
  reconcileEventQuarantine,
  reconcileFailedIngest,
} from "../src/operational-reconciliation.js";

function databaseWithQuery(
  handler: (sql: string, values?: unknown[]) => { rows: unknown[] },
): Postgres {
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) =>
      handler(sql, values),
    ),
    release: vi.fn(),
  };
  return {
    pool: {
      connect: vi.fn(async () => client),
    },
  } as unknown as Postgres;
}

describe("operational reconciliation", () => {
  it("records a scoped append-only quarantine disposition without mutating source history", async () => {
    const queries: string[] = [];
    const eventId = "11111111-1111-4111-8111-111111111111";
    const vaultId = "22222222-2222-4222-8222-222222222222";
    const spaceId = "33333333-3333-4333-8333-333333333333";
    const db = databaseWithQuery((sql) => {
      queries.push(sql);
      if (sql.includes("from event_quarantine q")) {
        return {
          rows: [
            {
              quarantine_id: 41,
              space_id: spaceId,
              vault_id: vaultId,
              delivery_status: "QUARANTINED",
            },
          ],
        };
      }
      if (sql.includes("insert into operational_reconciliations")) {
        return {
          rows: [
            {
              id: "44444444-4444-4444-8444-444444444444",
              resource_type: "EVENT_QUARANTINE",
              resource_key: `${eventId}:projection-worker:quarantine:41`,
              space_id: spaceId,
              vault_id: vaultId,
              environment: "local",
              disposition: "SUPERSEDED_BY_VERIFIED_PROJECTION",
              actor: "operator:test",
              rationale:
                "A later verified projection supersedes this delivery.",
              evidence: { projectionRevision: "rev-verified" },
              created_at: "2026-09-28T20:00:00.000Z",
            },
          ],
        };
      }
      return { rows: [] };
    });

    await expect(
      reconcileEventQuarantine(db, {
        eventId,
        consumerName: "projection-worker",
        environment: "local",
        disposition: "SUPERSEDED_BY_VERIFIED_PROJECTION",
        actor: "operator:test",
        rationale: "A later verified projection supersedes this delivery.",
        evidence: { projectionRevision: "rev-verified" },
      }),
    ).resolves.toMatchObject({
      resourceType: "EVENT_QUARANTINE",
      resourceKey: `${eventId}:projection-worker:quarantine:41`,
      vaultId,
      disposition: "SUPERSEDED_BY_VERIFIED_PROJECTION",
    });

    expect(queries.some((sql) => /update\s+event_quarantine/iu.test(sql))).toBe(
      false,
    );
    expect(
      queries.some((sql) => /delete\s+from\s+event_quarantine/iu.test(sql)),
    ).toBe(false);
  });

  it("requires a failed ingest before recording a terminal disposition", async () => {
    const db = databaseWithQuery((sql) => {
      if (sql.includes("from ingest_jobs")) {
        return {
          rows: [
            {
              space_id: "33333333-3333-4333-8333-333333333333",
              vault_id: null,
              state: "COMPLETED",
            },
          ],
        };
      }
      return { rows: [] };
    });

    await expect(
      reconcileFailedIngest(db, {
        jobId: "55555555-5555-4555-8555-555555555555",
        disposition: "TERMINAL_FIXTURE_DISPOSITION",
        actor: "operator:test",
        rationale: "Fixture source no longer exists.",
        evidence: { failureCode: "SOURCE_PATH_NOT_ALLOWED" },
      }),
    ).rejects.toThrow("INGEST_JOB_NOT_FAILED");
  });

  it("does not claim a quarantined delivery was recovered before replay succeeded", async () => {
    const eventId = "66666666-6666-4666-8666-666666666666";
    const db = databaseWithQuery((sql) => {
      if (sql.includes("from event_quarantine q")) {
        return {
          rows: [
            {
              quarantine_id: 77,
              space_id: null,
              vault_id: null,
              delivery_status: "QUARANTINED",
            },
          ],
        };
      }
      return { rows: [] };
    });

    await expect(
      reconcileEventQuarantine(db, {
        eventId,
        consumerName: "projection-worker",
        disposition: "RECOVERED_REPLAYED",
        actor: "operator:test",
        rationale: "Replay was requested.",
        evidence: { replayRequestId: "replay-1" },
      }),
    ).rejects.toThrow("EVENT_QUARANTINE_REPLAY_NOT_SUCCEEDED");
  });

  it("requires concrete evidence before recording a terminal disposition", async () => {
    const db = databaseWithQuery(() => ({ rows: [] }));
    await expect(
      reconcileFailedIngest(db, {
        jobId: "77777777-7777-4777-8777-777777777777",
        disposition: "IRRECOVERABLE_RECONCILED",
        actor: "operator:test",
        rationale: "The source is no longer recoverable.",
        evidence: {},
      }),
    ).rejects.toThrow("OPERATIONAL_RECONCILIATION_EVIDENCE_REQUIRED");
  });

  it("binds a disposition to one quarantine occurrence so a later re-quarantine stays unresolved", () => {
    const eventId = "11111111-1111-4111-8111-111111111111";
    expect(
      quarantineResourceKey(eventId, "projection-worker", 41),
    ).toBe(
      "11111111-1111-4111-8111-111111111111:projection-worker:quarantine:41",
    );
    expect(
      quarantineResourceKey(eventId, "projection-worker", 42),
    ).toBe(
      "11111111-1111-4111-8111-111111111111:projection-worker:quarantine:42",
    );
    expect(
      quarantineResourceKey(eventId, "projection-worker", 41),
    ).not.toBe(quarantineResourceKey(eventId, "projection-worker", 42));
    expect(() =>
      quarantineResourceKey("", "projection-worker", 41),
    ).toThrow("OPERATIONAL_RECONCILIATION_RESOURCE_REQUIRED");
    expect(() =>
      quarantineResourceKey(eventId, "projection-worker", 0),
    ).toThrow("OPERATIONAL_RECONCILIATION_RESOURCE_REQUIRED");
  });
});
