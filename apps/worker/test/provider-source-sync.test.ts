import { describe, expect, it, vi } from "vitest";
import type { SourceConnectorPort } from "@akp/domain";
import type { Postgres } from "@akp/postgres";
import type { ProviderHealthState } from "../src/external-work-connectors.js";
import { syncProviderSourceConnector } from "../src/provider-source-sync.js";

function fakeDatabase(activeObjects: Array<Record<string, unknown>> = []) {
  const checkpointUpdates: unknown[][] = [];
  const objectCheckUpdates: unknown[][] = [];
  const poolQuery = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("from source_connector_registrations r")) {
      return {
        rows: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            space_id: "22222222-2222-4222-8222-222222222222",
            vault_id: "33333333-3333-4333-8333-333333333333",
            source_system: "linear",
            credential_ref: "LINEAR_TEST_TOKEN",
            provider_config: {},
            provider_checkpoint_kind: "OPAQUE_CURSOR",
            provider_checkpoint_value: "2026-09-27T00:00:00.000Z",
          },
        ],
      };
    }
    if (sql.includes("select greatest(")) {
      return { rows: [{ sequence: 7 }] };
    }
    if (
      sql.includes("from source_connector_events") &&
      sql.includes("event_id=$2")
    ) {
      return { rows: [] };
    }
    if (
      sql.includes("from source_connector_events") &&
      sql.includes("status<>'APPLIED'")
    ) {
      return { rows: [{ count: 0 }] };
    }
    if (sql.includes("from source_connector_objects o")) {
      return { rows: activeObjects };
    }
    if (
      sql.includes("update source_connector_objects") &&
      sql.includes("provider_last_checked_at")
    ) {
      objectCheckUpdates.push(values ?? []);
      return { rows: [] };
    }
    if (
      sql.includes("update source_connector_checkpoints") &&
      sql.includes("provider_checkpoint_kind")
    ) {
      checkpointUpdates.push(values ?? []);
      return { rows: [] };
    }
    if (sql.includes("update source_connector_checkpoints")) {
      return { rows: [] };
    }
    throw new Error(`UNEXPECTED_POOL_QUERY:${sql}`);
  });
  const lockClient = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ locked: true }] };
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      throw new Error(`UNEXPECTED_LOCK_QUERY:${sql}`);
    }),
    release: vi.fn(),
  };
  const db = {
    pool: {
      query: poolQuery,
      connect: vi.fn(async () => lockClient),
    },
  } as unknown as Postgres;
  return {
    db,
    poolQuery,
    checkpointUpdates,
    objectCheckUpdates,
    lockClient,
  };
}

describe("provider source sync", () => {
  it("advances a provider checkpoint only after discovered events are durably applied", async () => {
    const { db, checkpointUpdates, lockClient } = fakeDatabase();
    const appendEvent = vi.fn(async () => ({
      id: "event-row",
      status: "PENDING",
      duplicate: false,
      sequence: 8,
    }));
    const applied = {
      eventId: "linear:event",
      connectorId: "11111111-1111-4111-8111-111111111111",
      spaceId: "22222222-2222-4222-8222-222222222222",
      vaultId: "33333333-3333-4333-8333-333333333333",
      sequence: 8,
      operation: "UPSERT" as const,
      objectId: "lin-1",
    };
    const applyNextEvent = vi
      .fn()
      .mockResolvedValueOnce(applied)
      .mockResolvedValueOnce(null);

    const port = {
      describe: () => ({
        schemaVersion: 1 as const,
        connectorId: "linear-test",
        sourceSystem: "linear",
        objectTypes: ["ISSUE"],
        incremental: { cursor: true, webhook: false },
        permissionFidelity: "SOURCE_ACL_MAPPED" as const,
        replication: "REFERENCE" as const,
        dataResidency: "EXTERNAL" as const,
        attachments: { supported: false },
        rateLimit: { kind: "NONE" as const },
        checkpointModel: "OPAQUE_CURSOR" as const,
        deletionPropagation: "NONE" as const,
        sourceVersioning: true,
        contentTrust: "UNTRUSTED_EXTERNAL" as const,
      }),
      checkpoint: vi.fn(async () => ({
        kind: "OPAQUE_CURSOR" as const,
        value: "2026-09-28T00:00:00.000Z",
      })),
      pull: async function* () {
        yield {
          objectId: "lin-1",
          objectType: "ISSUE",
          sourceSystem: "linear",
          sourceVersion: "2026-09-27T12:00:00.000Z",
          operation: "UPSERT" as const,
          title: "Provider issue",
          contentTrust: "UNTRUSTED_EXTERNAL" as const,
          permissions: {
            fidelity: "SOURCE_ACL_MAPPED" as const,
            uncertain: true,
            aclFingerprint: "acl-1",
          },
          attachments: [],
          metadata: {
            provider: "linear",
            providerVerified: true,
            updatedAt: "2026-09-27T12:00:00.000Z",
          },
        };
      },
      fetchById: vi.fn(async () => null),
      verifyWebhook: vi.fn(async () => ({
        accepted: false,
        reason: "NOT_USED",
      })),
      health: vi.fn(
        async (): Promise<{
          state: ProviderHealthState;
        }> => ({ state: "AVAILABLE" }),
      ),
    } as unknown as SourceConnectorPort & {
      health(): Promise<{ state: ProviderHealthState; reason?: string }>;
    };

    const result = await syncProviderSourceConnector(
      db,
      "11111111-1111-4111-8111-111111111111",
      { LINEAR_TEST_TOKEN: "test-secret" },
      {
        providerPort: () => port,
        appendEvent,
        applyNextEvent,
      },
    );

    expect(result).toMatchObject({
      provider: "linear",
      discovered: 1,
      appended: 1,
      applied: 1,
      checkpointAdvanced: true,
      health: "AVAILABLE",
      errorCode: null,
    });
    expect(appendEvent).toHaveBeenCalledOnce();
    expect(appendEvent.mock.calls[0]?.[1]).toMatchObject({
      connectorId: "11111111-1111-4111-8111-111111111111",
      sequence: 8,
      objectId: "lin-1",
      metadata: {
        provider: "linear",
        providerVerified: true,
        _akpProviderObservation: {
          providerVerified: true,
          observedVia: "AUTHENTICATED_PROVIDER_ADAPTER",
          sourceVersion: "2026-09-27T12:00:00.000Z",
        },
      },
    });
    expect(checkpointUpdates).toEqual([
      [
        "11111111-1111-4111-8111-111111111111",
        "OPAQUE_CURSOR",
        "2026-09-28T00:00:00.000Z",
        "AVAILABLE",
        null,
      ],
    ]);
    expect(applyNextEvent).toHaveBeenCalledTimes(2);
    expect(lockClient.release).toHaveBeenCalledOnce();
  });

  it("degrades and preserves the projection when provider absence is ambiguous", async () => {
    const { db, checkpointUpdates, objectCheckUpdates } = fakeDatabase([
      {
        object_id: "lin-missing",
        object_type: "ISSUE",
        source_version: "2026-09-26T12:00:00.000Z",
        title: "Previously visible provider issue",
        permission_fidelity: "SOURCE_ACL_MAPPED",
        permission_uncertain: true,
        acl_fingerprint: "acl-missing",
        metadata: { provider: "linear", identifier: "ENG-9" },
      },
    ]);
    const appendEvent = vi.fn();
    const applyNextEvent = vi.fn().mockResolvedValue(null);

    const port = {
      describe: () => ({
        schemaVersion: 1 as const,
        connectorId: "linear-test",
        sourceSystem: "linear",
        objectTypes: ["ISSUE"],
        incremental: { cursor: true, webhook: false },
        permissionFidelity: "SOURCE_ACL_MAPPED" as const,
        replication: "REFERENCE" as const,
        dataResidency: "EXTERNAL" as const,
        attachments: { supported: false },
        rateLimit: { kind: "NONE" as const },
        checkpointModel: "OPAQUE_CURSOR" as const,
        deletionPropagation: "NONE" as const,
        sourceVersioning: true,
        contentTrust: "UNTRUSTED_EXTERNAL" as const,
      }),
      checkpoint: vi.fn(async () => ({
        kind: "OPAQUE_CURSOR" as const,
        value: "2026-09-28T00:00:00.000Z",
      })),
      pull: async function* () {
        return;
      },
      fetchById: vi.fn(async () => null),
      verifyWebhook: vi.fn(async () => ({
        accepted: false,
        reason: "NOT_USED",
      })),
      health: vi.fn(
        async (): Promise<{
          state: ProviderHealthState;
        }> => ({ state: "AVAILABLE" }),
      ),
    } as unknown as SourceConnectorPort & {
      health(): Promise<{ state: ProviderHealthState; reason?: string }>;
    };

    const result = await syncProviderSourceConnector(
      db,
      "11111111-1111-4111-8111-111111111111",
      { LINEAR_TEST_TOKEN: "test-secret" },
      {
        providerPort: () => port,
        appendEvent,
        applyNextEvent,
      },
    );

    expect(result).toMatchObject({
      provider: "linear",
      discovered: 0,
      appended: 0,
      applied: 0,
      checkpointAdvanced: false,
      health: "DEGRADED",
      errorCode: "PROVIDER_OBJECT_ABSENCE_AMBIGUOUS",
    });
    expect(port.fetchById).toHaveBeenCalledWith({
      scope: {
        spaceId: "22222222-2222-4222-8222-222222222222",
        vaultId: "33333333-3333-4333-8333-333333333333",
      },
      objectId: "lin-missing",
      checkpoint: {
        kind: "OPAQUE_CURSOR",
        value: "2026-09-28T00:00:00.000Z",
      },
    });
    expect(appendEvent).not.toHaveBeenCalled();
    expect(objectCheckUpdates).toEqual([]);
    expect(checkpointUpdates).toEqual([]);
  });});
