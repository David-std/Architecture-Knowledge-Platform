import { describe, expect, it, vi } from "vitest";
import type { Postgres } from "@akp/postgres";
import {
  changesFromEvent,
  createIndexEventHandlers,
} from "../src/event-handlers.js";
import type { EventHandlers } from "../src/event-worker.js";

type IndexEvent = Parameters<
  NonNullable<EventHandlers["CorpusRevisionPublished"]>
>[0];

function event(eventType: IndexEvent["eventType"]): IndexEvent {
  return {
    eventId: "00000000-0000-0000-0000-000000000042",
    eventType,
    eventVersion: 1,
    resourceId: "00000000-0000-0000-0000-000000000043",
    organizationId: null,
    spaceId: "00000000-0000-0000-0000-000000000044",
    vaultId: "00000000-0000-0000-0000-000000000045",
    correlationId: "review-42",
    causationId: null,
    occurredAt: "2026-08-10T00:00:00.000Z",
    createdAt: "2026-08-10T00:00:00.000Z",
    payload: {
      revision: "managed-revision-42",
      changedPaths: ["managed/changed.md"],
      tombstones: ["managed/removed.md"],
      evalPack: "generic",
    },
  };
}

function fakeDb(): { db: Postgres; calls: string[] } {
  const calls: string[] = [];
  const query = vi.fn(async (sql: string) => {
    calls.push(sql);
    if (sql.includes("select corpus_revision from vault_index_revisions")) {
      return { rows: [{ corpus_revision: "composite:r42" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  return {
    db: { pool: { query } } as unknown as Postgres,
    calls,
  };
}

describe("index event consumers", () => {
  it("retains tombstone operation when changedPaths and tombstones overlap", () => {
    const published = event("CorpusRevisionPublished");
    expect(
      changesFromEvent({
        ...published,
        payload: {
          ...published.payload,
          changedPaths: ["managed/removed.md"],
          tombstones: ["managed/removed.md"],
        },
      }),
    ).toEqual([{ path: "removed.md", operation: "DELETE" }]);
  });

  it("fails closed for traversal paths in publication payloads", () => {
    const published = event("CorpusRevisionPublished");
    expect(() =>
      changesFromEvent({
        ...published,
        payload: {
          ...published.payload,
          changedPaths: ["managed/../README.md"],
        },
      }),
    ).toThrow("UNSAFE_MANAGED_PATH");
  });

  it("invalidates stale context packets and enqueues impacted evaluation idempotently", async () => {
    const { db, calls } = fakeDb();
    const handlers = createIndexEventHandlers(db, {} as never);
    const context = handlers.ContextPackInvalidationRequested;
    const evalRequest = handlers.ImpactedEvalRunRequested;
    if (!context || !evalRequest) throw new Error("handlers missing");

    await context(event("ContextPackInvalidationRequested"));
    await evalRequest(event("ImpactedEvalRunRequested"));
    await evalRequest(event("ImpactedEvalRunRequested"));

    expect(calls.some((sql) => /delete from context_packets/i.test(sql))).toBe(
      true,
    );
    expect(
      calls.filter((sql) => /insert into eval_runs/i.test(sql)).length,
    ).toBe(2);
    expect(
      calls.some((sql) =>
        /on conflict\(trigger_event_id\).*do nothing/i.test(sql),
      ),
    ).toBe(true);
  });

  it("schedules INDEX_CHANGE only when every required projection is at corpus parity", async () => {
    const calls: Array<{ sql: string; args?: unknown[] }> = [];
    let parity = false;
    const query = vi.fn(async (sql: string, args?: unknown[]) => {
      calls.push({ sql, args });
      if (sql.includes("select corpus_revision from vault_index_revisions")) {
        return { rows: [{ corpus_revision: "composite:r42" }], rowCount: 1 };
      }
      if (/select lexical_revision,vector_revision,graph_revision/i.test(sql)) {
        return {
          rows: [
            {
              lexical_revision: "composite:r42",
              vector_revision: null,
              graph_revision: parity ? "composite:r42" : "older",
              context_pack_revision: "composite:r42",
            },
          ],
          rowCount: 1,
        };
      }
      if (/insert into assurance_runs/i.test(sql)) {
        return {
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000086",
              space_id: "00000000-0000-0000-0000-000000000044",
              vault_id: "00000000-0000-0000-0000-000000000045",
              trigger: "INDEX_CHANGE",
              detectors: [
                "GRAPH_HEALTH",
                "CODE_GRAPH_FRESHNESS",
                "SYNTHESIS_ACCESS_BOUNDARY",
                "GRAPH_DISAGREEMENT",
              ],
              status: "PENDING",
              idempotency_key:
                "index-change:00000000-0000-0000-0000-000000000045:composite:r42",
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
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });
    const db = { pool: { query } } as unknown as Postgres;
    const handlers = createIndexEventHandlers(db, {} as never);
    const context = handlers.ContextPackInvalidationRequested;
    if (!context) throw new Error("context handler missing");

    const previous = process.env.AKP_VECTOR_ENABLED;
    delete process.env.AKP_VECTOR_ENABLED;
    try {
      await context(event("ContextPackInvalidationRequested"));
      expect(
        calls.filter((call) => /insert into assurance_runs/i.test(call.sql)),
      ).toHaveLength(0);

      parity = true;
      await context(event("ContextPackInvalidationRequested"));
    } finally {
      if (previous === undefined) delete process.env.AKP_VECTOR_ENABLED;
      else process.env.AKP_VECTOR_ENABLED = previous;
    }

    const inserted = calls.filter((call) =>
      /insert into assurance_runs/i.test(call.sql),
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.args).toEqual([
      "00000000-0000-0000-0000-000000000044",
      "00000000-0000-0000-0000-000000000045",
      "INDEX_CHANGE",
      [
        "GRAPH_HEALTH",
        "CODE_GRAPH_FRESHNESS",
        "SYNTHESIS_ACCESS_BOUNDARY",
        "GRAPH_DISAGREEMENT",
      ],
      "index-change:00000000-0000-0000-0000-000000000045:composite:r42",
      null,
      null,
      5,
    ]);
  });

  it("does not claim vector freshness while vector indexing is disabled", async () => {
    const { db, calls } = fakeDb();
    const handlers = createIndexEventHandlers(db, {} as never);
    const vector = handlers.VectorIndexUpdateRequested;
    if (!vector) throw new Error("vector handler missing");
    const previous = process.env.AKP_VECTOR_ENABLED;
    delete process.env.AKP_VECTOR_ENABLED;
    try {
      await vector(event("VectorIndexUpdateRequested"));
    } finally {
      if (previous === undefined) delete process.env.AKP_VECTOR_ENABLED;
      else process.env.AKP_VECTOR_ENABLED = previous;
    }
    expect(calls.some((sql) => /set vector_revision/i.test(sql))).toBe(false);
    expect(calls.some((sql) => /select corpus_revision/i.test(sql))).toBe(true);
  });
});
