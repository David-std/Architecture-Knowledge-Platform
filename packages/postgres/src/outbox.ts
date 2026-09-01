import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResult } from "pg";
import type { Postgres } from "./index.js";

/** A small common surface implemented by pg.Pool and pg.PoolClient. */
export type SqlExecutor = Pick<PoolClient, "query">;
export type OutboxTarget = Postgres | SqlExecutor;

export const INTEGRATION_EVENT_TYPES = [
  "SourceRegistered",
  "ExtractionRequested",
  "ExtractionCompleted",
  "CompilationRequested",
  "KnowledgeDraftCreated",
  "ValidationRequested",
  "KnowledgePublished",
  "CorpusRevisionPublished",
  "LexicalIndexUpdateRequested",
  "VectorIndexUpdateRequested",
  "GraphIndexUpdateRequested",
  "ContextPackInvalidationRequested",
  "ImpactedEvalRunRequested",
] as const;
export type IntegrationEventType = (typeof INTEGRATION_EVENT_TYPES)[number];

/** Events that mutate or invalidate a derived knowledge projection. */
export const VAULT_SCOPED_EVENT_TYPES: ReadonlySet<IntegrationEventType> =
  new Set([
    "KnowledgePublished",
    "CorpusRevisionPublished",
    "LexicalIndexUpdateRequested",
    "VectorIndexUpdateRequested",
    "GraphIndexUpdateRequested",
    "ContextPackInvalidationRequested",
    "ImpactedEvalRunRequested",
  ]);

export interface EventEnvelope {
  eventId: string;
  eventType: IntegrationEventType;
  eventVersion: number;
  resourceId: string;
  organizationId: string | null;
  spaceId: string | null;
  vaultId: string | null;
  correlationId: string | null;
  causationId: string | null;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface AppendOutboxEventInput {
  eventId?: string;
  eventType: IntegrationEventType;
  eventVersion?: number;
  resourceId: string;
  organizationId?: string | null;
  spaceId?: string | null;
  vaultId?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  occurredAt?: Date | string;
  payload?: Record<string, unknown>;
}

export interface OutboxEventRecord extends EventEnvelope {
  createdAt: string;
}

export type EventDeliveryStatus =
  "PENDING" | "CLAIMED" | "RETRY" | "SUCCEEDED" | "QUARANTINED";

export interface EventDeliveryRecord {
  event: OutboxEventRecord;
  consumerName: string;
  status: EventDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  leaseSeconds: number;
  leaseOwner: string;
  leaseToken: string;
  fencingVersion: number;
  deliveryGeneration: number;
  leaseExpiresAt: string;
  heartbeatAt: string | null;
  lastError: Record<string, unknown> | null;
}

export interface EventDeliveryClaim extends EventDeliveryRecord {
  workerId: string;
}

export interface RetryPolicy {
  /** Delay for the first failed attempt. */
  baseDelayMs: number;
  /** Upper bound applied after jitter. */
  maxDelayMs: number;
  /** Symmetric, bounded jitter ratio (0.2 means +/-20%). */
  jitterRatio: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60 * 1_000,
  jitterRatio: 0.2,
};

/**
 * Exponential retry delay with bounded jitter.  The random source is
 * injectable so retry behavior can be tested without sleeping or flakiness.
 */
export function retryDelayMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("RETRY_ATTEMPT_MUST_BE_POSITIVE");
  }
  if (
    !Number.isFinite(policy.baseDelayMs) ||
    !Number.isFinite(policy.maxDelayMs) ||
    !Number.isFinite(policy.jitterRatio) ||
    policy.baseDelayMs < 0 ||
    policy.maxDelayMs < policy.baseDelayMs ||
    policy.jitterRatio < 0 ||
    policy.jitterRatio > 1
  ) {
    throw new Error("INVALID_RETRY_POLICY");
  }
  const sample = random();
  const boundedRandom = Number.isFinite(sample)
    ? Math.min(1, Math.max(0, sample))
    : 0.5;
  const exponential = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  const jittered =
    exponential * (1 + (boundedRandom * 2 - 1) * policy.jitterRatio);
  return Math.max(0, Math.min(policy.maxDelayMs, Math.round(jittered)));
}

function executorFor(target: OutboxTarget): SqlExecutor {
  if ("pool" in target) return target.pool;
  return target;
}

function isPostgres(target: OutboxTarget): target is Postgres {
  return "pool" in target;
}

async function inTransaction<T>(
  target: OutboxTarget,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!isPostgres(target)) return action(target as PoolClient);
  const client = await target.pool.connect();
  try {
    await client.query("begin");
    const result = await action(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function iso(value: unknown, fallback = new Date().toISOString()): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fallback;
}

function isUuid(value: string): boolean {
  // PostgreSQL seed fixtures use nil/version-zero UUIDs; contracts only
  // require UUID shape, not RFC-4122 version semantics.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function parseEnvelope(input: Record<string, unknown>): EventEnvelope {
  const eventId = String(input.eventId);
  const eventType = String(input.eventType);
  const eventVersion = Number(input.eventVersion);
  const resourceId = String(input.resourceId);
  if (!isUuid(eventId)) throw new Error("INVALID_EVENT_ID");
  if (!(INTEGRATION_EVENT_TYPES as readonly string[]).includes(eventType)) {
    throw new Error("INVALID_EVENT_TYPE");
  }
  if (!Number.isInteger(eventVersion) || eventVersion < 1) {
    throw new Error("INVALID_EVENT_VERSION");
  }
  if (!resourceId.trim()) throw new Error("EVENT_RESOURCE_ID_REQUIRED");
  const optionalUuid = (value: unknown, name: string): string | null => {
    if (value === null || value === undefined || value === "") return null;
    const result = String(value);
    if (!isUuid(result)) throw new Error(`INVALID_${name.toUpperCase()}`);
    return result;
  };
  const vaultId = optionalUuid(input.vaultId, "vault_id");
  if (
    VAULT_SCOPED_EVENT_TYPES.has(eventType as IntegrationEventType) &&
    !vaultId
  ) {
    throw new Error("EVENT_VAULT_SCOPE_REQUIRED");
  }
  const payload =
    input.payload &&
    typeof input.payload === "object" &&
    !Array.isArray(input.payload)
      ? (input.payload as Record<string, unknown>)
      : {};
  const occurredAt = iso(input.occurredAt);
  return {
    eventId,
    eventType: eventType as IntegrationEventType,
    eventVersion,
    resourceId,
    organizationId: optionalUuid(input.organizationId, "organization_id"),
    spaceId: optionalUuid(input.spaceId, "space_id"),
    vaultId,
    correlationId:
      input.correlationId === null || input.correlationId === undefined
        ? null
        : String(input.correlationId),
    causationId:
      input.causationId === null || input.causationId === undefined
        ? null
        : String(input.causationId),
    occurredAt,
    payload,
  };
}

function mapEvent(row: Record<string, unknown>): OutboxEventRecord {
  const parsed = parseEnvelope({
    eventId: String(row.event_id),
    eventType: String(row.event_type),
    eventVersion: Number(row.event_version),
    resourceId: String(row.resource_id),
    organizationId: row.organization_id ? String(row.organization_id) : null,
    spaceId: row.space_id ? String(row.space_id) : null,
    vaultId: row.vault_id ? String(row.vault_id) : null,
    correlationId: row.correlation_id ? String(row.correlation_id) : null,
    causationId: row.causation_id ? String(row.causation_id) : null,
    occurredAt: iso(row.occurred_at),
    payload:
      row.payload && typeof row.payload === "object"
        ? (row.payload as Record<string, unknown>)
        : {},
  });
  return {
    ...parsed,
    createdAt: iso(row.event_created_at ?? row.created_at),
  };
}

function mapDelivery(row: Record<string, unknown>): EventDeliveryRecord {
  return {
    event: mapEvent(row),
    consumerName: String(row.consumer_name),
    status: String(row.status) as EventDeliveryStatus,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    leaseSeconds: Number(row.lease_seconds),
    leaseOwner: String(row.lease_owner),
    leaseToken: String(row.lease_token),
    fencingVersion: Number(row.fencing_version),
    deliveryGeneration: Number(row.delivery_generation),
    leaseExpiresAt: iso(row.lease_expires_at),
    heartbeatAt: row.heartbeat_at ? iso(row.heartbeat_at) : null,
    lastError:
      row.last_error && typeof row.last_error === "object"
        ? (row.last_error as Record<string, unknown>)
        : null,
  };
}

function normalizeEvent(input: AppendOutboxEventInput): EventEnvelope {
  if (input.occurredAt !== undefined) {
    const candidate =
      input.occurredAt instanceof Date
        ? input.occurredAt
        : new Date(input.occurredAt);
    if (Number.isNaN(candidate.getTime())) {
      throw new Error("INVALID_OCCURRED_AT");
    }
  }
  return parseEnvelope({
    eventId: input.eventId ?? randomUUID(),
    eventType: input.eventType,
    eventVersion: input.eventVersion ?? 1,
    resourceId: input.resourceId,
    organizationId: input.organizationId ?? null,
    spaceId: input.spaceId ?? null,
    vaultId: input.vaultId ?? null,
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    occurredAt: iso(input.occurredAt),
    payload: input.payload ?? {},
  });
}

/**
 * Append an immutable event.  Pass a PoolClient obtained by the caller when
 * business state and the event must commit in one transaction; passing
 * Postgres opens a transaction for this operation.
 */
export async function appendOutboxEvent(
  target: OutboxTarget,
  input: AppendOutboxEventInput,
): Promise<OutboxEventRecord> {
  const event = normalizeEvent(input);
  return inTransaction(target, async (client) => {
    const inserted = await client.query(
      `
      insert into event_outbox(
        event_id,event_type,event_version,resource_id,organization_id,space_id,
        vault_id,correlation_id,causation_id,occurred_at,payload
      ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
      on conflict(event_id) do nothing
      returning event_id,event_type,event_version,resource_id,organization_id,
                space_id,vault_id,correlation_id,causation_id,occurred_at,payload,
                created_at
      `,
      [
        event.eventId,
        event.eventType,
        event.eventVersion,
        event.resourceId,
        event.organizationId,
        event.spaceId,
        event.vaultId,
        event.correlationId,
        event.causationId,
        event.occurredAt,
        JSON.stringify(event.payload),
      ],
    );
    const row = inserted.rows[0] as Record<string, unknown> | undefined;
    if (row) return mapEvent(row);
    const existing = await client.query(
      `
      select event_id,event_type,event_version,resource_id,organization_id,
             space_id,vault_id,correlation_id,causation_id,occurred_at,payload,
             created_at
        from event_outbox where event_id=$1
      `,
      [event.eventId],
    );
    const existingRow = existing.rows[0] as Record<string, unknown> | undefined;
    if (!existingRow) throw new Error("OUTBOX_EVENT_INSERT_FAILED");
    const persisted = mapEvent(existingRow);
    if (
      persisted.eventType !== event.eventType ||
      persisted.eventVersion !== event.eventVersion ||
      persisted.resourceId !== event.resourceId ||
      persisted.organizationId !== event.organizationId ||
      persisted.spaceId !== event.spaceId ||
      persisted.vaultId !== event.vaultId ||
      persisted.correlationId !== event.correlationId ||
      persisted.causationId !== event.causationId ||
      JSON.stringify(persisted.payload) !== JSON.stringify(event.payload)
    ) {
      throw new Error("OUTBOX_EVENT_ID_CONFLICT");
    }
    return persisted;
  });
}

export interface RegisterConsumerOptions {
  enabled?: boolean;
  maxAttempts?: number;
  leaseSeconds?: number;
}

/** Register a consumer and backfill delivery rows for earlier events. */
export async function registerEventConsumer(
  target: OutboxTarget,
  consumerName: string,
  options: RegisterConsumerOptions = {},
): Promise<void> {
  if (!consumerName.trim()) throw new Error("CONSUMER_NAME_REQUIRED");
  await inTransaction(target, async (client) => {
    await client.query(
      `
      insert into event_consumers(consumer_name,enabled,max_attempts,lease_seconds)
      values($1,$2,$3,$4)
      on conflict(consumer_name) do update set enabled=excluded.enabled,
          max_attempts=excluded.max_attempts,lease_seconds=excluded.lease_seconds,
          updated_at=now()
      `,
      [
        consumerName,
        options.enabled ?? true,
        options.maxAttempts ?? 8,
        options.leaseSeconds ?? 60,
      ],
    );
    await client.query(
      `
      insert into event_deliveries(event_id,consumer_name)
      select event_id,$1 from event_outbox
      on conflict(event_id,consumer_name) do nothing
      `,
      [consumerName],
    );
  });
}

/** Atomically claim one delivery using SKIP LOCKED and a fencing token. */
export async function claimNextEventDelivery(
  target: OutboxTarget,
  consumerName: string,
  workerId: string,
): Promise<EventDeliveryClaim | null> {
  const executor = executorFor(target);
  const result = await executor.query(
    `
    with candidate as (
      select d.event_id
        from event_deliveries d
        join event_outbox e on e.event_id=d.event_id
        join event_consumers c on c.consumer_name=d.consumer_name
       where d.consumer_name=$1 and c.enabled
         and (
           (d.status in ('PENDING','RETRY') and d.next_attempt_at <= now())
           or (d.status='CLAIMED' and d.lease_expires_at < now())
         )
         and (
           e.causation_id is null
           or not exists (
             select 1 from event_outbox parent_event
              where parent_event.event_id::text=e.causation_id
           )
           or exists (
             select 1 from event_deliveries parent_delivery
              where parent_delivery.event_id::text=e.causation_id
                and parent_delivery.consumer_name=d.consumer_name
                and parent_delivery.status='SUCCEEDED'
           )
         )
       order by d.next_attempt_at, d.created_at, d.event_id
       for update skip locked
       limit 1
    ), claimed as (
      update event_deliveries d
         set status='CLAIMED',
             attempts=d.attempts+1,
             lease_owner=$2,
             lease_token=gen_random_uuid(),
             fencing_version=d.fencing_version+1,
             lease_expires_at=now()+make_interval(secs => c.lease_seconds),
             heartbeat_at=now(),
             last_error=null,
             updated_at=now()
        from candidate, event_consumers c
       where d.event_id=candidate.event_id and c.consumer_name=$1
         and d.consumer_name=c.consumer_name
       returning d.*
    ), attempted as (
      insert into event_delivery_attempts(
        event_id,consumer_name,attempt,delivery_generation,worker_id,
        fencing_version,outcome,started_at
      )
      select event_id,consumer_name,attempts,delivery_generation,$2,
             fencing_version,'CLAIMED',now()
        from claimed
      on conflict do nothing
      returning event_id
    )
    select d.event_id,d.consumer_name,d.status,d.attempts,d.next_attempt_at,
           d.lease_owner,d.lease_token,d.fencing_version,d.lease_expires_at,
           d.delivery_generation,d.heartbeat_at,d.last_error,d.completed_at,
           d.created_at,d.updated_at,
           c.max_attempts,c.lease_seconds,
           e.event_type,e.event_version,e.resource_id,e.organization_id,e.space_id,
           e.vault_id,e.correlation_id,e.causation_id,e.occurred_at,e.payload,
           e.created_at event_created_at
      from claimed d
      join event_consumers c on c.consumer_name=d.consumer_name
      join event_outbox e on e.event_id=d.event_id
      left join attempted a on a.event_id=d.event_id
    `,
    [consumerName, workerId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return { ...mapDelivery(row), workerId };
}

export async function heartbeatEventDelivery(
  target: OutboxTarget,
  claim: Pick<
    EventDeliveryClaim,
    "event" | "consumerName" | "workerId" | "leaseToken" | "fencingVersion"
  >,
): Promise<boolean> {
  const executor = executorFor(target);
  const result = await executor.query(
    `
    update event_deliveries
       set lease_expires_at=now()+make_interval(secs => c.lease_seconds),
           heartbeat_at=now(),updated_at=now()
      from event_consumers c
     where event_deliveries.event_id=$1
       and event_deliveries.consumer_name=$2
       and event_deliveries.status='CLAIMED'
       and event_deliveries.lease_owner=$3
       and event_deliveries.lease_token=$4::uuid
       and event_deliveries.fencing_version=$5
       and c.consumer_name=event_deliveries.consumer_name
    returning event_deliveries.event_id
    `,
    [
      claim.event.eventId,
      claim.consumerName,
      claim.workerId,
      claim.leaseToken,
      claim.fencingVersion,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface DeliveryFailure {
  status: "RETRY" | "QUARANTINED";
  attempts: number;
  delayMs: number;
}

function errorPayload(error: unknown): Record<string, unknown> {
  return {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "Error",
  };
}

/** Ack only if the caller still owns the fencing token. */
export async function acknowledgeEventDelivery(
  target: OutboxTarget,
  claim: EventDeliveryClaim,
): Promise<void> {
  await inTransaction(target, async (client) => {
    const updated = await client.query(
      `
      update event_deliveries
         set status='SUCCEEDED',lease_owner=null,lease_token=null,
             lease_expires_at=null,heartbeat_at=now(),completed_at=now(),updated_at=now()
       where event_id=$1 and consumer_name=$2 and status='CLAIMED'
         and lease_owner=$3 and lease_token=$4::uuid and fencing_version=$5
       returning attempts,fencing_version
      `,
      [
        claim.event.eventId,
        claim.consumerName,
        claim.workerId,
        claim.leaseToken,
        claim.fencingVersion,
      ],
    );
    if (!updated.rowCount) throw new Error("EVENT_LEASE_LOST");
    await client.query(
      `
      insert into event_delivery_attempts(
        event_id,consumer_name,attempt,delivery_generation,worker_id,
        fencing_version,outcome,finished_at
      ) values($1,$2,$3,$4,$5,$6,'SUCCEEDED',now())
      on conflict do nothing
      `,
      [
        claim.event.eventId,
        claim.consumerName,
        claim.attempts,
        claim.deliveryGeneration,
        claim.workerId,
        claim.fencingVersion,
      ],
    );
  });
}

/**
 * Record a failed attempt.  A bounded exponential delay is persisted for
 * retries; once max_attempts is reached the delivery is quarantined and can
 * only move again through an explicit requeue operation.
 */
export async function failEventDelivery(
  target: OutboxTarget,
  claim: EventDeliveryClaim,
  error: unknown,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<DeliveryFailure> {
  const delayMs = retryDelayMs(claim.attempts, policy);
  const details = errorPayload(error);
  return inTransaction(target, async (client) => {
    const terminal = claim.attempts >= claim.maxAttempts;
    const nextStatus = terminal ? "QUARANTINED" : "RETRY";
    const updated = await client.query(
      `
      update event_deliveries
         set status=$6, last_error=$7::jsonb,
             next_attempt_at=now()+make_interval(secs => $8),
             lease_owner=null,lease_token=null,lease_expires_at=null,
             heartbeat_at=now(),updated_at=now()
       where event_id=$1 and consumer_name=$2 and status='CLAIMED'
         and lease_owner=$3 and lease_token=$4::uuid and fencing_version=$5
       returning attempts
      `,
      [
        claim.event.eventId,
        claim.consumerName,
        claim.workerId,
        claim.leaseToken,
        claim.fencingVersion,
        nextStatus,
        JSON.stringify(details),
        delayMs / 1_000,
      ],
    );
    if (!updated.rowCount) throw new Error("EVENT_LEASE_LOST");
    await client.query(
      `
      insert into event_delivery_attempts(
        event_id,consumer_name,attempt,delivery_generation,worker_id,
        fencing_version,outcome,error,finished_at
      ) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,now())
      on conflict do nothing
      `,
      [
        claim.event.eventId,
        claim.consumerName,
        claim.attempts,
        claim.deliveryGeneration,
        claim.workerId,
        claim.fencingVersion,
        nextStatus,
        JSON.stringify(details),
      ],
    );
    if (terminal) {
      await client.query(
        `
        insert into event_quarantine(event_id,consumer_name,attempts,reason)
        values($1,$2,$3,$4::jsonb)
        `,
        [
          claim.event.eventId,
          claim.consumerName,
          claim.attempts,
          JSON.stringify({ ...details, maxAttempts: claim.maxAttempts }),
        ],
      );
    }
    return {
      status: nextStatus,
      attempts: claim.attempts,
      delayMs: terminal ? 0 : delayMs,
    };
  });
}

/** Requeue a quarantined delivery after an operator decision. */
export async function requeueEventDelivery(
  target: OutboxTarget,
  eventId: string,
  consumerName: string,
  requestedBy: string,
): Promise<boolean> {
  return inTransaction(target, async (client) => {
    const result = await client.query(
      `
      update event_deliveries
         set status='PENDING',attempts=0,delivery_generation=delivery_generation+1,
             next_attempt_at=now(),last_error=null,
             lease_owner=null,lease_token=null,lease_expires_at=null,
             heartbeat_at=null,completed_at=null,updated_at=now()
       where event_id=$1 and consumer_name=$2 and status='QUARANTINED'
       returning event_id
      `,
      [eventId, consumerName],
    );
    if (!result.rowCount) return false;
    await client.query(
      `
      update event_quarantine
         set requeue_requested_at=now(),requeue_requested_by=$3
       where event_id=$1 and consumer_name=$2 and requeue_requested_at is null
      `,
      [eventId, consumerName, requestedBy],
    );
    return true;
  });
}

export interface ReconciliationReport {
  unconsumed: number;
  staleClaims: number;
  quarantined: number;
  orphanDeliveries: number;
}

/**
 * A point-in-time view of one consumer's durable queue.  The buckets are
 * mutually exclusive for every delivery row, which makes the result safe to
 * serialize as a worker drain contract instead of relying on log text.
 *
 * `causallyBlocked` includes a non-terminal delivery whose known causating
 * event has not succeeded for this consumer.  A causation id that does not
 * resolve to an event is intentionally treated as an unblocked legacy/root
 * event, matching claimNextEventDelivery's fail-open compatibility rule.
 */
export interface OutboxDrainSummary {
  consumerName: string;
  total: number;
  immediatelyClaimable: number;
  causallyBlocked: number;
  scheduledRetry: number;
  leased: number;
  quarantined: number;
  succeeded: number;
  nonTerminal: number;
  nextWakeAt: string | null;
}

/**
 * Inspect durable delivery state without changing it.  `nextWakeAt` is the
 * earliest database-owned retry or lease timestamp still in the queue.  A
 * caller can therefore wait on a durable deadline rather than guessing with
 * a polling sleep; a null value means the queue is blocked without a future
 * timestamp (for example a malformed causal cycle) and must be bounded by
 * the caller's own drain deadline.
 */
export async function summarizeOutbox(
  target: OutboxTarget,
  consumerName: string,
): Promise<OutboxDrainSummary> {
  if (!consumerName.trim()) throw new Error("CONSUMER_NAME_REQUIRED");
  const result = await executorFor(target).query(
    `
    with delivery_state as (
      select d.status,d.next_attempt_at,d.lease_expires_at,
             case
               when e.causation_id is null then false
               when not exists (
                 select 1 from event_outbox parent_event
                  where parent_event.event_id::text=e.causation_id
               ) then false
               when exists (
                 select 1 from event_deliveries parent_delivery
                  where parent_delivery.event_id::text=e.causation_id
                    and parent_delivery.consumer_name=d.consumer_name
                    and parent_delivery.status='SUCCEEDED'
               ) then false
               else true
             end causally_blocked
        from event_deliveries d
        join event_outbox e on e.event_id=d.event_id
       where d.consumer_name=$1
    ), rollup as (
      select
        count(*)::int total,
        count(*) filter (
          where status not in ('SUCCEEDED','QUARANTINED')
            and not causally_blocked
            and (
              (status in ('PENDING','RETRY') and next_attempt_at <= now())
              or (status='CLAIMED' and lease_expires_at <= now())
            )
        )::int immediately_claimable,
        count(*) filter (
          where status not in ('SUCCEEDED','QUARANTINED')
            and causally_blocked
        )::int causally_blocked,
        count(*) filter (
          where status in ('PENDING','RETRY')
            and not causally_blocked and next_attempt_at > now()
        )::int scheduled_retry,
        count(*) filter (
          where status='CLAIMED'
            and not causally_blocked
            and (lease_expires_at is null or lease_expires_at > now())
        )::int leased,
        count(*) filter (where status='QUARANTINED')::int quarantined,
        count(*) filter (where status='SUCCEEDED')::int succeeded,
        min(
          case
            when status in ('PENDING','RETRY') and next_attempt_at > now()
              then next_attempt_at
            when status='CLAIMED' and lease_expires_at > now()
              then lease_expires_at
            else null
          end
        ) next_wake_at
      from delivery_state
    )
    select total,immediately_claimable,causally_blocked,scheduled_retry,
           leased,quarantined,succeeded,next_wake_at
      from rollup
    `,
    [consumerName],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  const total = Number(row?.total ?? 0);
  const immediatelyClaimable = Number(row?.immediately_claimable ?? 0);
  const causallyBlocked = Number(row?.causally_blocked ?? 0);
  const scheduledRetry = Number(row?.scheduled_retry ?? 0);
  const leased = Number(row?.leased ?? 0);
  const quarantined = Number(row?.quarantined ?? 0);
  const succeeded = Number(row?.succeeded ?? 0);
  return {
    consumerName,
    total,
    immediatelyClaimable,
    causallyBlocked,
    scheduledRetry,
    leased,
    quarantined,
    succeeded,
    nonTerminal: total - quarantined - succeeded,
    nextWakeAt: row?.next_wake_at ? iso(row.next_wake_at) : null,
  };
}

/**
 * Reconciliation is intentionally read-only.  It reports drift for a
 * scheduled safety net while normal delivery remains event-driven.
 */
export async function reconcileOutbox(
  target: OutboxTarget,
  consumerName?: string,
): Promise<ReconciliationReport> {
  const executor = executorFor(target);
  const filter = consumerName ? "and consumer_name=$1" : "";
  const params = consumerName ? [consumerName] : [];
  const rows = await executor.query(
    `
    select
      count(*) filter (where status in ('PENDING','RETRY') and next_attempt_at <= now())::int unconsumed,
      count(*) filter (where status='CLAIMED' and lease_expires_at < now())::int stale_claims,
      count(*) filter (where status='QUARANTINED')::int quarantined,
      count(*) filter (where not exists(select 1 from event_outbox e where e.event_id=event_deliveries.event_id))::int orphan_deliveries
      from event_deliveries
     where true ${filter}
    `,
    params,
  );
  const row = rows.rows[0] as Record<string, unknown> | undefined;
  return {
    unconsumed: Number(row?.unconsumed ?? 0),
    staleClaims: Number(row?.stale_claims ?? 0),
    quarantined: Number(row?.quarantined ?? 0),
    orphanDeliveries: Number(row?.orphan_deliveries ?? 0),
  };
}

export async function listQuarantinedEvents(
  target: OutboxTarget,
  consumerName?: string,
): Promise<Array<Record<string, unknown>>> {
  const executor = executorFor(target);
  const result = await executor.query(
    `
    select q.id,q.event_id,q.consumer_name,q.attempts,q.reason,q.quarantined_at,
           q.requeue_requested_at,q.requeue_requested_by,e.event_type,e.resource_id
      from event_quarantine q
      join event_outbox e on e.event_id=q.event_id
     where ($1::text is null or q.consumer_name=$1)
     order by q.quarantined_at desc
    `,
    [consumerName ?? null],
  );
  return result.rows as Array<Record<string, unknown>>;
}

/** Useful for callers that need a typed result without exposing pg internals. */
export function rows<T extends Record<string, unknown>>(
  result: QueryResult<T>,
): T[] {
  return result.rows;
}
