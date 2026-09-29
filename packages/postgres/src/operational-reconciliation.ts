import type { Postgres } from "./index.js";

export type OperationalReconciliationResourceType =
  "EVENT_QUARANTINE" | "INGEST_JOB";

export type OperationalReconciliationDisposition =
  | "RECOVERED_REPLAYED"
  | "SUPERSEDED_BY_VERIFIED_PROJECTION"
  | "IRRECOVERABLE_RECONCILED"
  | "TERMINAL_FIXTURE_DISPOSITION";

export interface OperationalReconciliationRecord {
  id: string;
  resourceType: OperationalReconciliationResourceType;
  resourceKey: string;
  spaceId: string | null;
  vaultId: string | null;
  environment: string;
  disposition: OperationalReconciliationDisposition;
  actor: string;
  rationale: string;
  evidence: Record<string, unknown>;
  createdAt: string;
}

function requireDispositionEvidence(input: {
  actor: string;
  rationale: string;
  evidence?: Record<string, unknown>;
}): Record<string, unknown> {
  if (!input.actor.trim())
    throw new Error("OPERATIONAL_RECONCILIATION_ACTOR_REQUIRED");
  if (!input.rationale.trim())
    throw new Error("OPERATIONAL_RECONCILIATION_RATIONALE_REQUIRED");
  const evidence = input.evidence ?? {};
  if (Object.keys(evidence).length === 0) {
    throw new Error("OPERATIONAL_RECONCILIATION_EVIDENCE_REQUIRED");
  }
  return evidence;
}

function normalize(
  row: Record<string, unknown>,
): OperationalReconciliationRecord {
  return {
    id: String(row.id),
    resourceType: String(
      row.resource_type,
    ) as OperationalReconciliationResourceType,
    resourceKey: String(row.resource_key),
    spaceId: row.space_id ? String(row.space_id) : null,
    vaultId: row.vault_id ? String(row.vault_id) : null,
    environment: String(row.environment),
    disposition: String(
      row.disposition,
    ) as OperationalReconciliationDisposition,
    actor: String(row.actor),
    rationale: String(row.rationale),
    evidence:
      row.evidence &&
      typeof row.evidence === "object" &&
      !Array.isArray(row.evidence)
        ? (row.evidence as Record<string, unknown>)
        : {},
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export function quarantineResourceKey(
  eventId: string,
  consumerName: string,
  quarantineId: string | number,
): string {
  const normalizedQuarantineId = String(quarantineId).trim();
  if (
    !eventId.trim() ||
    !consumerName.trim() ||
    !/^[1-9][0-9]*$/u.test(normalizedQuarantineId)
  ) {
    throw new Error("OPERATIONAL_RECONCILIATION_RESOURCE_REQUIRED");
  }
  return `${eventId.trim()}:${consumerName.trim()}:quarantine:${normalizedQuarantineId}`;
}

export async function reconcileEventQuarantine(
  db: Postgres,
  input: {
    eventId: string;
    consumerName: string;
    environment?: string;
    disposition: Exclude<
      OperationalReconciliationDisposition,
      "TERMINAL_FIXTURE_DISPOSITION"
    >;
    actor: string;
    rationale: string;
    evidence?: Record<string, unknown>;
  },
): Promise<OperationalReconciliationRecord> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const evidence = requireDispositionEvidence(input);
    const source = await client.query<{
      quarantine_id: string | number;
      space_id: string | null;
      vault_id: string | null;
      delivery_status: string | null;
    }>(
      `select q.id quarantine_id,o.space_id,o.vault_id,d.status delivery_status
         from event_quarantine q
         join event_outbox o on o.event_id=q.event_id
         left join event_deliveries d
           on d.event_id=q.event_id and d.consumer_name=q.consumer_name
        where q.event_id=$1 and q.consumer_name=$2
        order by q.quarantined_at desc,q.id desc
        limit 1`,
      [input.eventId, input.consumerName],
    );
    const row = source.rows[0];
    if (!row) throw new Error("EVENT_QUARANTINE_NOT_FOUND");
    if (
      input.disposition === "RECOVERED_REPLAYED" &&
      row.delivery_status !== "SUCCEEDED"
    ) {
      throw new Error("EVENT_QUARANTINE_REPLAY_NOT_SUCCEEDED");
    }
    const inserted = await client.query<Record<string, unknown>>(
      `insert into operational_reconciliations(
         resource_type,resource_key,space_id,vault_id,environment,disposition,
         actor,rationale,evidence
       ) values(
         'EVENT_QUARANTINE',$1,$2,$3,$4,$5,$6,$7,$8::jsonb
       )
       on conflict(resource_type,resource_key,environment) do nothing
       returning *`,
      [
        quarantineResourceKey(
          input.eventId,
          input.consumerName,
          row.quarantine_id,
        ),
        row.space_id,
        row.vault_id,
        input.environment?.trim() || "default",
        input.disposition,
        input.actor.trim(),
        input.rationale.trim(),
        JSON.stringify(evidence),
      ],
    );
    const result = inserted.rows[0];
    if (!result) {
      throw new Error("OPERATIONAL_RECONCILIATION_ALREADY_EXISTS");
    }
    await client.query("commit");
    return normalize(result);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function reconcileFailedIngest(
  db: Postgres,
  input: {
    jobId: string;
    environment?: string;
    disposition:
      | "IRRECOVERABLE_RECONCILED"
      | "TERMINAL_FIXTURE_DISPOSITION"
      | "SUPERSEDED_BY_VERIFIED_PROJECTION";
    actor: string;
    rationale: string;
    evidence?: Record<string, unknown>;
  },
): Promise<OperationalReconciliationRecord> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const evidence = requireDispositionEvidence(input);
    const source = await client.query<{
      space_id: string;
      vault_id: string | null;
      state: string;
    }>(
      `select space_id,vault_id,state
         from ingest_jobs
        where id=$1
        for share`,
      [input.jobId],
    );
    const row = source.rows[0];
    if (!row) throw new Error("INGEST_JOB_NOT_FOUND");
    if (row.state !== "FAILED") {
      throw new Error("INGEST_JOB_NOT_FAILED");
    }
    const inserted = await client.query<Record<string, unknown>>(
      `insert into operational_reconciliations(
         resource_type,resource_key,space_id,vault_id,environment,disposition,
         actor,rationale,evidence
       ) values(
         'INGEST_JOB',$1,$2,$3,$4,$5,$6,$7,$8::jsonb
       )
       on conflict(resource_type,resource_key,environment) do nothing
       returning *`,
      [
        input.jobId,
        row.space_id,
        row.vault_id,
        input.environment?.trim() || "default",
        input.disposition,
        input.actor.trim(),
        input.rationale.trim(),
        JSON.stringify(evidence),
      ],
    );
    const result = inserted.rows[0];
    if (!result) {
      throw new Error("OPERATIONAL_RECONCILIATION_ALREADY_EXISTS");
    }
    await client.query("commit");
    return normalize(result);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
