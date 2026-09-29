import { createHash } from "node:crypto";
import type {
  SourceConnectorCheckpoint,
  SourceConnectorPort,
} from "@akp/domain";
import {
  appendSourceConnectorEvent,
  applyNextSourceConnectorEvent,
  type Postgres,
} from "@akp/postgres";
import {
  JiraCloudSourceConnector,
  LinearSourceConnector,
  type ProviderHealthState,
} from "./external-work-connectors.js";

type ProviderConnectorRow = {
  id: string;
  space_id: string;
  vault_id: string;
  source_system: string;
  credential_ref: string;
  provider_config: Record<string, unknown>;
  provider_checkpoint_kind: SourceConnectorCheckpoint["kind"] | null;
  provider_checkpoint_value: string | null;
};

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeErrorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 120);
  return normalized || "PROVIDER_SYNC_FAILED";
}

function authorizationHeader(
  secret: string,
  scheme: unknown,
  provider: string,
): string {
  const selected =
    stringValue(scheme)?.toUpperCase() ??
    (provider === "jira" ? "BASIC" : "RAW");
  if (selected === "RAW") return secret;
  if (selected === "BEARER") return `Bearer ${secret}`;
  if (selected === "BASIC") {
    return `Basic ${Buffer.from(secret, "utf8").toString("base64")}`;
  }
  throw new Error("PROVIDER_AUTHORIZATION_SCHEME_INVALID");
}

function providerPort(
  row: ProviderConnectorRow,
  environment: NodeJS.ProcessEnv,
): SourceConnectorPort & {
  health(): Promise<{ state: ProviderHealthState; reason?: string }>;
} {
  const secret = environment[row.credential_ref]?.trim();
  if (!secret) throw new Error("PROVIDER_CREDENTIAL_UNAVAILABLE");
  const config = objectRecord(row.provider_config);
  const authorization = authorizationHeader(
    secret,
    config.authorizationScheme,
    row.source_system,
  );
  const webhookEnabled = Boolean(stringValue(config.webhookSecretRef));
  if (row.source_system === "jira") {
    const baseUrl = stringValue(config.baseUrl);
    const jql = stringValue(config.jql);
    if (!baseUrl) throw new Error("JIRA_BASE_URL_REQUIRED");
    return new JiraCloudSourceConnector({
      baseUrl,
      authorizationHeader: authorization,
      webhookEnabled,
      ...(jql ? { jql } : {}),
    });
  }
  if (row.source_system === "linear") {
    const endpoint = stringValue(config.endpoint);
    return new LinearSourceConnector({
      authorizationHeader: authorization,
      webhookEnabled,
      ...(endpoint ? { endpoint } : {}),
    });
  }
  throw new Error("PROVIDER_CONNECTOR_UNSUPPORTED");
}

function eventIdentity(
  provider: string,
  objectId: string,
  sourceVersion: string,
  operation: string,
): string {
  const digest = createHash("sha256")
    .update([provider, objectId, sourceVersion, operation].join("\n"))
    .digest("hex");
  return `${provider}:${digest}`;
}

function payloadHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function observedAt(
  metadata: Record<string, unknown>,
  fallback: string,
): string {
  const candidate = stringValue(metadata.updatedAt);
  if (candidate && !Number.isNaN(new Date(candidate).getTime())) {
    return new Date(candidate).toISOString();
  }
  if (!Number.isNaN(new Date(fallback).getTime())) {
    return new Date(fallback).toISOString();
  }
  return new Date().toISOString();
}

async function updateLinkedProviderHealth(
  db: Postgres,
  connectorId: string,
  state: ProviderHealthState,
  errorCode: string | null,
): Promise<void> {
  await db.pool.query(
    `update external_object_refs r
        set metadata=r.metadata || jsonb_build_object(
              '_akpProvenance',
              coalesce(r.metadata->'_akpProvenance','{}'::jsonb) ||
              jsonb_build_object(
                'providerHealth',$2::text,
                'providerLastErrorCode',$3::text,
                'providerVerified',true,
                'observationSource','AUTHENTICATED_PROVIDER_ADAPTER'
              )
            ),
            updated_at=now()
       from external_object_provider_links l
      where l.external_ref_id=r.id
        and l.connector_id=$1`,
    [connectorId, state, errorCode],
  );
}

async function updateProviderHealth(
  db: Postgres,
  connectorId: string,
  state: ProviderHealthState,
  errorCode: string | null,
): Promise<void> {
  await db.pool.query(
    `update source_connector_checkpoints
        set provider_health=$2,
            provider_last_error_code=$3,
            updated_at=now()
      where connector_id=$1`,
    [connectorId, state, errorCode],
  );
  await updateLinkedProviderHealth(db, connectorId, state, errorCode);
}

export interface ProviderSyncResult {
  connectorId: string;
  provider: string;
  discovered: number;
  appended: number;
  applied: number;
  checkpointAdvanced: boolean;
  health: ProviderHealthState;
  errorCode: string | null;
}

export interface ProviderSyncDependencies {
  providerPort?: (
    row: ProviderConnectorRow,
    environment: NodeJS.ProcessEnv,
  ) => SourceConnectorPort & {
    health(): Promise<{ state: ProviderHealthState; reason?: string }>;
  };
  appendEvent?: typeof appendSourceConnectorEvent;
  applyNextEvent?: typeof applyNextSourceConnectorEvent;
}

export async function syncProviderSourceConnector(
  db: Postgres,
  connectorId: string,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: ProviderSyncDependencies = {},
): Promise<ProviderSyncResult> {
  const lockClient = await db.pool.connect();
  let locked = false;
  let provider = "unknown";
  try {
    const lock = await lockClient.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtext($1)) locked",
      [`provider-source-connector:${connectorId}`],
    );
    locked = lock.rows[0]?.locked === true;
    if (!locked) {
      return {
        connectorId,
        provider,
        discovered: 0,
        appended: 0,
        applied: 0,
        checkpointAdvanced: false,
        health: "DEGRADED",
        errorCode: "PROVIDER_SYNC_ALREADY_RUNNING",
      };
    }

    const registration = await db.pool.query<ProviderConnectorRow>(
      `select r.id,r.space_id,r.vault_id,r.source_system,r.credential_ref,
              r.provider_config,c.provider_checkpoint_kind,
              c.provider_checkpoint_value
         from source_connector_registrations r
         join source_connector_checkpoints c on c.connector_id=r.id
        where r.id=$1 and r.state='ACTIVE'
          and r.connector_mode='PROVIDER_PULL'`,
      [connectorId],
    );
    const row = registration.rows[0];
    if (!row) throw new Error("PROVIDER_CONNECTOR_NOT_FOUND");
    provider = row.source_system;
    const port = (dependencies.providerPort ?? providerPort)(row, environment);
    const health = await port.health();
    if (health.state !== "AVAILABLE") {
      await updateProviderHealth(
        db,
        connectorId,
        health.state,
        health.reason ? safeErrorCode(health.reason) : "PROVIDER_UNAVAILABLE",
      );
      return {
        connectorId,
        provider,
        discovered: 0,
        appended: 0,
        applied: 0,
        checkpointAdvanced: false,
        health: health.state,
        errorCode: health.reason
          ? safeErrorCode(health.reason)
          : "PROVIDER_UNAVAILABLE",
      };
    }

    const target = await port.checkpoint({
      spaceId: row.space_id,
      vaultId: row.vault_id,
    });
    const from =
      row.provider_checkpoint_kind && row.provider_checkpoint_value
        ? {
            kind: row.provider_checkpoint_kind,
            value: row.provider_checkpoint_value,
          }
        : undefined;

    const sequenceState = await db.pool.query<{ sequence: string | number }>(
      `select greatest(
           c.applied_sequence,
           coalesce((select max(e.sequence) from source_connector_events e
                     where e.connector_id=c.connector_id),0)
         ) sequence
         from source_connector_checkpoints c
        where c.connector_id=$1`,
      [connectorId],
    );
    let sequence = Number(sequenceState.rows[0]?.sequence ?? 0);
    let discovered = 0;
    let appended = 0;
    let highestSequence = sequence;

    for await (const object of port.pull({
      scope: { spaceId: row.space_id, vaultId: row.vault_id },
      ...(from ? { from } : {}),
      target,
      pageSize: 50,
    })) {
      discovered += 1;
      const eventId = eventIdentity(
        provider,
        object.objectId,
        object.sourceVersion,
        object.operation,
      );
      const existing = await db.pool.query<{ sequence: string | number }>(
        `select sequence
           from source_connector_events
          where connector_id=$1 and event_id=$2`,
        [connectorId, eventId],
      );
      if (existing.rows[0]) {
        highestSequence = Math.max(
          highestSequence,
          Number(existing.rows[0].sequence),
        );
        continue;
      }
      sequence += 1;
      highestSequence = sequence;
      const metadata = {
        ...object.metadata,
        _akpProviderObservation: {
          providerVerified: true,
          observedVia: "AUTHENTICATED_PROVIDER_ADAPTER",
          sourceVersion: object.sourceVersion,
        },
      };
      const serialized = {
        operation: object.operation,
        objectId: object.objectId,
        objectType: object.objectType,
        sourceVersion: object.sourceVersion,
        title: object.title ?? null,
        content: object.content ?? null,
        permissions: object.permissions,
        metadata,
      };
      await (dependencies.appendEvent ?? appendSourceConnectorEvent)(db, {
        connectorId,
        eventId,
        sequence,
        occurredAt: observedAt(metadata, target.value),
        operation: object.operation,
        objectId: object.objectId,
        objectType: object.objectType,
        sourceVersion: object.sourceVersion,
        title: object.title ?? null,
        content:
          object.operation === "DELETE" ? null : (object.content ?? null),
        contentType: object.contentType ?? null,
        permissionFidelity: object.permissions.fidelity,
        permissionUncertain: object.permissions.uncertain,
        aclFingerprint: object.permissions.aclFingerprint ?? null,
        metadata,
        payloadHash: payloadHash(serialized),
      });
      appended += 1;
    }

    let applied = 0;
    for (;;) {
      const result = await (
        dependencies.applyNextEvent ?? applyNextSourceConnectorEvent
      )(db, { connectorId });
      if (!result) break;
      applied += 1;
    }

    let deletionHealth: ProviderHealthState = "AVAILABLE";
    let deletionErrorCode: string | null = null;
    if (port.fetchById) {
      const deletionCandidates = await db.pool.query<{
        object_id: string;
        object_type: string;
        source_version: string;
        title: string | null;
        permission_fidelity:
          | "SOURCE_ACL_EXACT"
          | "SOURCE_ACL_MAPPED"
          | "WORKSPACE_WIDE"
          | "NONE"
          | "UNKNOWN";
        permission_uncertain: boolean;
        acl_fingerprint: string | null;
        metadata: Record<string, unknown>;
      }>(
        `select o.object_id,o.object_type,o.source_version,o.title,
                o.permission_fidelity,o.permission_uncertain,
                o.acl_fingerprint,o.metadata
           from source_connector_objects o
          where o.connector_id=$1
            and o.lifecycle='ACTIVE'
            and (
              o.provider_last_checked_at is null
              or o.provider_last_checked_at < now() - interval '15 minutes'
            )
            and not exists(
              select 1
                from source_connector_events e
               where e.connector_id=o.connector_id
                 and e.object_id=o.object_id
                 and e.operation='DELETE'
                 and e.status<>'APPLIED'
            )
          order by o.provider_last_checked_at asc nulls first,
                   o.updated_at,o.object_id
          limit 10`,
        [connectorId],
      );

      for (const candidate of deletionCandidates.rows) {
        try {
          const current = await port.fetchById({
            scope: { spaceId: row.space_id, vaultId: row.vault_id },
            objectId: candidate.object_id,
            checkpoint: target,
          });
          if (current) {
            await db.pool.query(
              `update source_connector_objects
                  set provider_last_checked_at=now()
                where connector_id=$1 and object_id=$2
                  and lifecycle='ACTIVE'`,
              [connectorId, candidate.object_id],
            );
            continue;
          }

          // Jira/Linear point reads are authorization-scoped. A missing object
          // can mean deletion, archival, or loss of visibility. Do not turn an
          // ambiguous absence into a tombstone without an explicit provider
          // deletion signal.
          await db.pool.query(
            `update source_connector_objects
                set provider_last_checked_at=now()
              where connector_id=$1 and object_id=$2
                and lifecycle='ACTIVE'`,
            [connectorId, candidate.object_id],
          );
          deletionHealth = "DEGRADED";
          deletionErrorCode = "PROVIDER_OBJECT_ABSENCE_AMBIGUOUS";
          break;
        } catch (error) {
          deletionHealth = "DEGRADED";
          deletionErrorCode = safeErrorCode(error);
          break;
        }
      }

      for (;;) {
        const result = await (
          dependencies.applyNextEvent ?? applyNextSourceConnectorEvent
        )(db, { connectorId });
        if (!result) break;
        applied += 1;
      }
    }

    const unresolved = await db.pool.query<{ count: number }>(
      `select count(*)::int count
         from source_connector_events
        where connector_id=$1 and sequence<=$2
          and status<>'APPLIED'`,
      [connectorId, highestSequence],
    );
    const allEventsApplied = Number(unresolved.rows[0]?.count ?? 0) === 0;
    const checkpointAdvanced =
      allEventsApplied && deletionHealth === "AVAILABLE";
    const finalHealth: ProviderHealthState = checkpointAdvanced
      ? "AVAILABLE"
      : "DEGRADED";
    const finalErrorCode = !allEventsApplied
      ? "PROVIDER_EVENTS_UNAPPLIED"
      : deletionErrorCode;

    if (checkpointAdvanced) {
      await db.pool.query(
        `update source_connector_checkpoints
            set provider_checkpoint_kind=$2,
                provider_checkpoint_value=$3,
                provider_health=$4,
                provider_last_success_at=case when $4='AVAILABLE' then now()
                                              else provider_last_success_at end,
                provider_last_error_code=$5,
                updated_at=now()
          where connector_id=$1`,
        [connectorId, target.kind, target.value, finalHealth, finalErrorCode],
      );
      await updateLinkedProviderHealth(
        db,
        connectorId,
        finalHealth,
        finalErrorCode,
      );
    } else {
      await updateProviderHealth(
        db,
        connectorId,
        "DEGRADED",
        finalErrorCode ?? "PROVIDER_SYNC_DEGRADED",
      );
    }

    return {
      connectorId,
      provider,
      discovered,
      appended,
      applied,
      checkpointAdvanced,
      health: finalHealth,
      errorCode: finalErrorCode,
    };
  } catch (error) {
    const errorCode = safeErrorCode(error);
    await updateProviderHealth(db, connectorId, "UNAVAILABLE", errorCode).catch(
      () => undefined,
    );
    return {
      connectorId,
      provider,
      discovered: 0,
      appended: 0,
      applied: 0,
      checkpointAdvanced: false,
      health: "UNAVAILABLE",
      errorCode,
    };
  } finally {
    if (locked) {
      await lockClient
        .query("select pg_advisory_unlock(hashtext($1))", [
          `provider-source-connector:${connectorId}`,
        ])
        .catch(() => undefined);
    }
    lockClient.release();
  }
}

export async function syncConfiguredProviderConnectors(
  db: Postgres,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProviderSyncResult[]> {
  const rows = await db.pool.query<{ id: string }>(
    `select id
       from source_connector_registrations
      where state='ACTIVE' and connector_mode='PROVIDER_PULL'
      order by id`,
  );
  const results: ProviderSyncResult[] = [];
  for (const row of rows.rows) {
    results.push(await syncProviderSourceConnector(db, row.id, environment));
  }
  return results;
}
