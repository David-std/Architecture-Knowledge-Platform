import type { Postgres } from "./index.js";

export type SourceConnectorPermissionFidelity =
  "SOURCE_ACL_EXACT" | "SOURCE_ACL_MAPPED" | "WORKSPACE_WIDE" | "NONE";

export interface SourceConnectorRegistrationInput {
  spaceId: string;
  vaultId: string;
  connectorKey: string;
  sourceSystem: string;
  publicKeyPem: string;
  descriptor: Record<string, unknown>;
  createdByUserId?: string | null;
  createdByPrincipalId?: string | null;
}

export interface SourceConnectorEventInput {
  connectorId: string;
  eventId: string;
  sequence: number;
  occurredAt: string;
  operation: "UPSERT" | "DELETE";
  objectId: string;
  objectType: string;
  sourceVersion: string;
  title?: string | null;
  content?: string | null;
  contentType?: string | null;
  permissionFidelity: SourceConnectorPermissionFidelity;
  permissionUncertain: boolean;
  aclFingerprint?: string | null;
  metadata: Record<string, unknown>;
  payloadHash: string;
}

export interface SourceConnectorEventReceipt {
  id: string;
  status: "PENDING" | "APPLIED" | "REJECTED";
  duplicate: boolean;
  sequence: number;
}

export interface AppliedSourceConnectorEvent {
  eventId: string;
  connectorId: string;
  spaceId: string;
  vaultId: string;
  sequence: number;
  operation: "UPSERT" | "DELETE";
  objectId: string;
}

export interface SourceConnectorInboxSummary {
  pending: number;
  immediatelyClaimable: number;
  blockedByGap: number;
}

function sourceConnectorError(code: string, statusCode: number): Error {
  const error = new Error(code) as Error & {
    code?: string;
    statusCode?: number;
  };
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

export async function registerSourceConnector(
  db: Postgres,
  input: SourceConnectorRegistrationInput,
): Promise<Record<string, unknown>> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const inserted = await client.query<Record<string, unknown>>(
      `insert into source_connector_registrations(
         space_id,vault_id,connector_key,source_system,public_key_pem,descriptor,
         created_by_user_id,created_by_principal_id
       ) values($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
       on conflict(vault_id,connector_key) do update
         set source_system=excluded.source_system,
             public_key_pem=excluded.public_key_pem,
             descriptor=excluded.descriptor,
             state='ACTIVE',
             updated_at=now()
       returning *`,
      [
        input.spaceId,
        input.vaultId,
        input.connectorKey,
        input.sourceSystem,
        input.publicKeyPem,
        JSON.stringify(input.descriptor),
        input.createdByUserId ?? null,
        input.createdByPrincipalId ?? null,
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("SOURCE_CONNECTOR_REGISTER_FAILED");
    await client.query(
      `insert into source_connector_checkpoints(connector_id)
       values($1)
       on conflict(connector_id) do nothing`,
      [row.id],
    );
    await client.query("commit");
    return row;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function appendSourceConnectorEvent(
  db: Postgres,
  input: SourceConnectorEventInput,
): Promise<SourceConnectorEventReceipt> {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw sourceConnectorError("SOURCE_CONNECTOR_SEQUENCE_INVALID", 400);
  }
  if (!/^[a-f0-9]{64}$/.test(input.payloadHash)) {
    throw sourceConnectorError("SOURCE_CONNECTOR_PAYLOAD_HASH_INVALID", 400);
  }
  if (input.operation === "DELETE" && input.content != null) {
    throw sourceConnectorError("SOURCE_CONNECTOR_DELETE_CONTENT_FORBIDDEN", 400);
  }

  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const registration = await client.query<{
      state: string;
      applied_sequence: string | number;
    }>(
      `select r.state,c.applied_sequence
         from source_connector_registrations r
         join source_connector_checkpoints c on c.connector_id=r.id
        where r.id=$1
        for update of r,c`,
      [input.connectorId],
    );
    const connector = registration.rows[0];
    if (!connector) throw sourceConnectorError("SOURCE_CONNECTOR_NOT_FOUND", 404);
    if (connector.state !== "ACTIVE") {
      throw sourceConnectorError("SOURCE_CONNECTOR_DISABLED", 409);
    }

    const existingByEvent = await client.query<{
      id: string;
      sequence: string | number;
      payload_hash: string;
      status: SourceConnectorEventReceipt["status"];
    }>(
      `select id,sequence,payload_hash,status
         from source_connector_events
        where connector_id=$1 and event_id=$2`,
      [input.connectorId, input.eventId],
    );
    const sameEvent = existingByEvent.rows[0];
    if (sameEvent) {
      if (
        Number(sameEvent.sequence) !== input.sequence ||
        sameEvent.payload_hash !== input.payloadHash
      ) {
        throw sourceConnectorError("SOURCE_CONNECTOR_EVENT_ID_CONFLICT", 409);
      }
      await client.query("commit");
      return {
        id: sameEvent.id,
        status: sameEvent.status,
        duplicate: true,
        sequence: Number(sameEvent.sequence),
      };
    }

    if (input.sequence <= Number(connector.applied_sequence)) {
      throw sourceConnectorError("SOURCE_CONNECTOR_SEQUENCE_ALREADY_APPLIED", 409);
    }

    const existingSequence = await client.query<{ event_id: string }>(
      `select event_id
         from source_connector_events
        where connector_id=$1 and sequence=$2`,
      [input.connectorId, input.sequence],
    );
    if (existingSequence.rowCount) {
      throw sourceConnectorError("SOURCE_CONNECTOR_SEQUENCE_CONFLICT", 409);
    }

    const inserted = await client.query<{
      id: string;
      status: SourceConnectorEventReceipt["status"];
      sequence: string | number;
    }>(
      `insert into source_connector_events(
         connector_id,event_id,sequence,occurred_at,operation,object_id,
         object_type,source_version,title,content,content_type,
         permission_fidelity,permission_uncertain,acl_fingerprint,
         metadata,payload_hash
       ) values(
         $1,$2,$3,$4::timestamptz,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
         $15::jsonb,$16
       )
       returning id,status,sequence`,
      [
        input.connectorId,
        input.eventId,
        input.sequence,
        input.occurredAt,
        input.operation,
        input.objectId,
        input.objectType,
        input.sourceVersion,
        input.title ?? null,
        input.content ?? null,
        input.contentType ?? null,
        input.permissionFidelity,
        input.permissionUncertain,
        input.aclFingerprint ?? null,
        JSON.stringify(input.metadata),
        input.payloadHash,
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("SOURCE_CONNECTOR_EVENT_APPEND_FAILED");
    await client.query(
      `update source_connector_registrations
          set last_event_at=greatest(coalesce(last_event_at,$2::timestamptz),$2::timestamptz),
              updated_at=now()
        where id=$1`,
      [input.connectorId, input.occurredAt],
    );
    await client.query("commit");
    return {
      id: row.id,
      status: row.status,
      duplicate: false,
      sequence: Number(row.sequence),
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function applyNextSourceConnectorEvent(
  db: Postgres,
): Promise<AppliedSourceConnectorEvent | null> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const selected = await client.query<Record<string, unknown>>(
      `select e.*,r.space_id,r.vault_id
         from source_connector_events e
         join source_connector_registrations r on r.id=e.connector_id
         join source_connector_checkpoints c on c.connector_id=e.connector_id
        where e.status='PENDING' and r.state='ACTIVE'
          and e.sequence=c.applied_sequence+1
        order by e.received_at,e.id
        for update of e skip locked
        limit 1`,
    );
    const event = selected.rows[0];
    if (!event) {
      await client.query("commit");
      return null;
    }

    const checkpoint = await client.query<{
      applied_sequence: string | number;
    }>(
      `select applied_sequence
         from source_connector_checkpoints
        where connector_id=$1
        for update`,
      [event.connector_id],
    );
    const applied = Number(checkpoint.rows[0]?.applied_sequence ?? -1);
    const sequence = Number(event.sequence);
    if (sequence !== applied + 1) {
      await client.query("rollback");
      return null;
    }

    const lifecycle =
      String(event.operation) === "DELETE" ? "DELETED_TOMBSTONE" : "ACTIVE";
    await client.query(
      `insert into source_connector_objects(
         connector_id,object_id,object_type,source_version,lifecycle,title,
         content,content_type,permission_fidelity,permission_uncertain,
         acl_fingerprint,metadata,source_sequence,observed_at
       ) values(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::timestamptz
       )
       on conflict(connector_id,object_id) do update
         set object_type=excluded.object_type,
             source_version=excluded.source_version,
             lifecycle=excluded.lifecycle,
             title=excluded.title,
             content=excluded.content,
             content_type=excluded.content_type,
             permission_fidelity=excluded.permission_fidelity,
             permission_uncertain=excluded.permission_uncertain,
             acl_fingerprint=excluded.acl_fingerprint,
             metadata=excluded.metadata,
             source_sequence=excluded.source_sequence,
             observed_at=excluded.observed_at,
             updated_at=now()
       where source_connector_objects.source_sequence<excluded.source_sequence`,
      [
        event.connector_id,
        event.object_id,
        event.object_type,
        event.source_version,
        lifecycle,
        event.title ?? null,
        lifecycle === "DELETED_TOMBSTONE" ? null : (event.content ?? null),
        event.content_type ?? null,
        event.permission_fidelity,
        event.permission_uncertain,
        event.acl_fingerprint ?? null,
        JSON.stringify(event.metadata ?? {}),
        sequence,
        event.occurred_at,
      ],
    );
    const eventUpdated = await client.query(
      `update source_connector_events
          set status='APPLIED',applied_at=now()
        where id=$1 and status='PENDING'`,
      [event.id],
    );
    if (eventUpdated.rowCount !== 1) {
      throw new Error("SOURCE_CONNECTOR_EVENT_FENCED");
    }
    const checkpointUpdated = await client.query(
      `update source_connector_checkpoints
          set applied_sequence=$2,updated_at=now()
        where connector_id=$1 and applied_sequence=$3`,
      [event.connector_id, sequence, applied],
    );
    if (checkpointUpdated.rowCount !== 1) {
      throw new Error("SOURCE_CONNECTOR_CHECKPOINT_FENCED");
    }

    await client.query(
      `insert into assurance_runs(
         space_id,vault_id,trigger,detectors,idempotency_key
       ) values(
         $1,$2,'CONNECTOR_EVENT',
         array[
           'CONNECTOR_DELETION',
           'CONNECTOR_FRESHNESS',
           'CONNECTOR_ACL_DRIFT'
         ]::text[],
         $3
       )
       on conflict(space_id,vault_id,idempotency_key) do nothing`,
      [
        event.space_id,
        event.vault_id,
        `connector-event:${String(event.connector_id)}:${sequence}`,
      ],
    );
    await client.query("commit");
    return {
      eventId: String(event.event_id),
      connectorId: String(event.connector_id),
      spaceId: String(event.space_id),
      vaultId: String(event.vault_id),
      sequence,
      operation: String(event.operation) as "UPSERT" | "DELETE",
      objectId: String(event.object_id),
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function summarizeSourceConnectorInbox(
  db: Postgres,
): Promise<SourceConnectorInboxSummary> {
  const result = await db.pool.query<{
    pending: number;
    immediately_claimable: number;
    blocked_by_gap: number;
  }>(
    `select
       count(*) filter (where e.status='PENDING')::int pending,
       count(*) filter (
         where e.status='PENDING' and e.sequence=c.applied_sequence+1
       )::int immediately_claimable,
       count(*) filter (
         where e.status='PENDING' and e.sequence>c.applied_sequence+1
       )::int blocked_by_gap
       from source_connector_events e
       join source_connector_checkpoints c on c.connector_id=e.connector_id
       join source_connector_registrations r on r.id=e.connector_id
      where r.state='ACTIVE'`,
  );
  return {
    pending: Number(result.rows[0]?.pending ?? 0),
    immediatelyClaimable: Number(result.rows[0]?.immediately_claimable ?? 0),
    blockedByGap: Number(result.rows[0]?.blocked_by_gap ?? 0),
  };
}
