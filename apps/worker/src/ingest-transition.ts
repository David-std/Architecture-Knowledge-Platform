import { transitionIngest, type IngestState } from "@akp/domain";
import {
  appendOutboxEvent,
  type Postgres,
  type PostgresPoolClient,
} from "@akp/postgres";
import { lifecycleEventForState } from "./lifecycle.js";

export interface ClaimedIngestTransition {
  jobId: string;
  current: IngestState;
  next: IngestState;
  expectedVersion: number;
  workerId: string;
  stageOutput?: Record<string, unknown>;
  result?: unknown;
}

export type IngestTransitionSideEffect = (
  client: PostgresPoolClient,
) => Promise<void>;

export async function transitionClaimedIngestJob(
  db: Postgres,
  input: ClaimedIngestTransition,
  sideEffect?: IngestTransitionSideEffect,
): Promise<void> {
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  ) {
    throw new Error("JOB_FENCING_VERSION_REQUIRED");
  }
  transitionIngest(input.current, input.next);

  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const claimed = await client.query<{
      id: string;
      space_id: string;
      vault_id: string | null;
    }>(
      `select id,space_id,vault_id
         from ingest_jobs
        where id=$1 and state=$2 and lease_owner=$3 and version=$4
          and cancelled_at is null
        for update`,
      [
        input.jobId,
        input.current,
        input.workerId,
        input.expectedVersion,
      ],
    );
    const job = claimed.rows[0];
    if (!job) {
      throw new Error("JOB_LEASE_LOST_OR_CANCELLED");
    }

    // Database side effects belong to the state transition. Executing them
    // while holding the claimed job row lock means cancellation and lease
    // fencing have a single serialization point rather than a TOCTOU window.
    if (sideEffect) await sideEffect(client);

    const updated = await client.query(
      `update ingest_jobs
          set state=$3,
              result=coalesce($4::jsonb,result),
              stage_outputs=stage_outputs||coalesce($5::jsonb,'{}'::jsonb),
              lease_owner=null,
              lease_expires_at=null,
              heartbeat_at=now(),
              updated_at=now()
        where id=$1 and state=$2 and lease_owner=$6 and version=$7
          and cancelled_at is null
        returning id`,
      [
        input.jobId,
        input.current,
        input.next,
        input.result === undefined ? null : JSON.stringify(input.result),
        input.stageOutput === undefined
          ? null
          : JSON.stringify(input.stageOutput),
        input.workerId,
        input.expectedVersion,
      ],
    );
    if (!updated.rowCount) {
      throw new Error("JOB_LEASE_LOST_OR_CANCELLED");
    }

    await client.query(
      `insert into ingest_job_events(job_id,state,event_type,payload)
       values($1,$2,'STATE_TRANSITION',$3::jsonb)`,
      [
        input.jobId,
        input.next,
        JSON.stringify({ from: input.current, workerId: input.workerId }),
      ],
    );

    const lifecycleEvent = lifecycleEventForState(input.next);
    if (lifecycleEvent) {
      const emitted = await appendOutboxEvent(client, {
        eventType: lifecycleEvent.eventType,
        resourceId: input.jobId,
        spaceId: job.space_id,
        vaultId: job.vault_id,
        correlationId: input.jobId,
        payload: {
          jobId: input.jobId,
          state: input.next,
          sourceId:
            typeof (input.stageOutput ?? {}).sourceId === "string"
              ? input.stageOutput?.sourceId
              : null,
          revision:
            typeof (input.stageOutput ?? {}).revision === "string"
              ? input.stageOutput?.revision
              : null,
        },
      });
      for (const eventType of lifecycleEvent.followUps) {
        await appendOutboxEvent(client, {
          eventType,
          resourceId: input.jobId,
          spaceId: job.space_id,
          vaultId: job.vault_id,
          correlationId: input.jobId,
          causationId: emitted.eventId,
          payload: {
            jobId: input.jobId,
            state: input.next,
            revision:
              typeof (input.stageOutput ?? {}).revision === "string"
                ? input.stageOutput?.revision
                : null,
            changedPaths: Array.isArray(
              (input.stageOutput ?? {}).changedPaths,
            )
              ? input.stageOutput?.changedPaths
              : [],
            tombstones: Array.isArray((input.stageOutput ?? {}).tombstones)
              ? input.stageOutput?.tombstones
              : [],
          },
        });
      }
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function assertClaimedIngestJob(
  db: Postgres,
  input: {
    jobId: string;
    state: IngestState;
    expectedVersion: number;
    workerId: string;
  },
): Promise<void> {
  const current = await db.pool.query(
    `select 1
       from ingest_jobs
      where id=$1 and state=$2 and lease_owner=$3 and version=$4
        and cancelled_at is null`,
    [input.jobId, input.state, input.workerId, input.expectedVersion],
  );
  if (!current.rowCount) throw new Error("JOB_LEASE_LOST_OR_CANCELLED");
}
