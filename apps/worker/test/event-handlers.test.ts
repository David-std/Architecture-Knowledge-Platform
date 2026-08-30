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
    ).toEqual([{ path: "removed.md", operation: "UPDATE" }]);
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
