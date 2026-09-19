import { createHash } from "node:crypto";
import type {
  AssuranceDetector,
  AssuranceFinding,
  AssuranceRun,
  AssuranceRunCursor,
} from "@akp/domain";
import { ASSURANCE_DETECTORS } from "@akp/domain";
import type { Postgres } from "./index.js";

const DETECTOR_SET = new Set<string>(ASSURANCE_DETECTORS);

function assertDetectors(detectors: readonly AssuranceDetector[]): void {
  if (
    detectors.length < 1 ||
    detectors.length > ASSURANCE_DETECTORS.length ||
    new Set(detectors).size !== detectors.length ||
    detectors.some((detector) => !DETECTOR_SET.has(detector))
  ) {
    throw new Error("ASSURANCE_DETECTORS_INVALID");
  }
}

function rowToRun(row: Record<string, unknown>): AssuranceRun {
  return {
    id: String(row.id),
    spaceId: String(row.space_id),
    vaultId: String(row.vault_id),
    trigger: String(row.trigger) as AssuranceRun["trigger"],
    detectors: (row.detectors ?? []) as AssuranceDetector[],
    status: String(row.status) as AssuranceRun["status"],
    idempotencyKey: String(row.idempotency_key),
    cursor: (row.cursor ?? { detectorIndex: 0 }) as AssuranceRunCursor,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
    leaseToken: Number(row.lease_token),
    leaseExpiresAt: row.lease_expires_at
      ? new Date(String(row.lease_expires_at))
      : null,
    cancelRequestedAt: row.cancel_requested_at
      ? new Date(String(row.cancel_requested_at))
      : null,
    nextAttemptAt: new Date(String(row.next_attempt_at)),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

export async function submitAssuranceRun(
  db: Postgres,
  input: {
    spaceId: string;
    vaultId: string;
    trigger: AssuranceRun["trigger"];
    detectors: AssuranceDetector[];
    idempotencyKey: string;
    requestedByUserId?: string | null;
    requestedByPrincipalId?: string | null;
    maxAttempts?: number;
  },
): Promise<AssuranceRun> {
  assertDetectors(input.detectors);
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    throw new Error("ASSURANCE_IDEMPOTENCY_KEY_INVALID");
  }
  const maxAttempts = input.maxAttempts ?? 5;
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 20
  ) {
    throw new Error("ASSURANCE_MAX_ATTEMPTS_INVALID");
  }
  const result = await db.pool.query(
    `insert into assurance_runs(
       space_id,vault_id,trigger,detectors,idempotency_key,
       requested_by_user_id,requested_by_principal_id,max_attempts
     ) values($1,$2,$3,$4::text[],$5,$6,$7,$8)
     on conflict(space_id,vault_id,idempotency_key) do update
       set updated_at=assurance_runs.updated_at
     returning *`,
    [
      input.spaceId,
      input.vaultId,
      input.trigger,
      input.detectors,
      idempotencyKey,
      input.requestedByUserId ?? null,
      input.requestedByPrincipalId ?? null,
      maxAttempts,
    ],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error("ASSURANCE_RUN_SUBMIT_FAILED");
  return rowToRun(row);
}

export async function claimNextAssuranceRun(
  db: Postgres,
  workerId: string,
  leaseSeconds = 60,
): Promise<AssuranceRun | null> {
  if (!workerId.trim()) throw new Error("ASSURANCE_WORKER_ID_REQUIRED");
  if (
    !Number.isSafeInteger(leaseSeconds) ||
    leaseSeconds < 5 ||
    leaseSeconds > 3600
  ) {
    throw new Error("ASSURANCE_LEASE_SECONDS_INVALID");
  }
  const result = await db.pool.query(
    `with candidate as (
       select id
         from assurance_runs
        where status in ('PENDING','RUNNING')
          and cancel_requested_at is null
          and attempts < max_attempts
          and next_attempt_at <= now()
          and (
            status='PENDING'
            or lease_expires_at is null
            or lease_expires_at < now()
          )
        order by created_at,id
        for update skip locked
        limit 1
     )
     update assurance_runs r
        set status='RUNNING',
            attempts=r.attempts+1,
            lease_owner=$1,
            lease_token=r.lease_token+1,
            lease_expires_at=now()+make_interval(secs => $2),
            started_at=coalesce(r.started_at,now()),
            updated_at=now()
       from candidate
      where r.id=candidate.id
     returning r.*`,
    [workerId, leaseSeconds],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? rowToRun(row) : null;
}

export async function renewAssuranceRunLease(
  db: Postgres,
  input: {
    runId: string;
    workerId: string;
    leaseToken: number;
    leaseSeconds?: number;
    cursor?: AssuranceRunCursor;
  },
): Promise<boolean> {
  const leaseSeconds = input.leaseSeconds ?? 60;
  if (
    !Number.isSafeInteger(leaseSeconds) ||
    leaseSeconds < 5 ||
    leaseSeconds > 3600
  ) {
    throw new Error("ASSURANCE_LEASE_SECONDS_INVALID");
  }
  const result = await db.pool.query(
    `update assurance_runs
        set lease_expires_at=now()+make_interval(secs => $4),
            cursor=coalesce($5::jsonb,cursor),
            updated_at=now()
      where id=$1 and status='RUNNING' and lease_owner=$2 and lease_token=$3
        and lease_expires_at>now() and cancel_requested_at is null`,
    [
      input.runId,
      input.workerId,
      input.leaseToken,
      leaseSeconds,
      input.cursor ? JSON.stringify(input.cursor) : null,
    ],
  );
  return result.rowCount === 1;
}

export async function cancelAssuranceRun(
  db: Postgres,
  runId: string,
): Promise<boolean> {
  const result = await db.pool.query(
    `update assurance_runs
        set cancel_requested_at=coalesce(cancel_requested_at,now()),
            status='CANCELLED',
            completed_at=coalesce(completed_at,now()),
            lease_owner=null,lease_expires_at=null,
            updated_at=now()
      where id=$1 and status in ('PENDING','RUNNING')`,
    [runId],
  );
  return result.rowCount === 1;
}

export function assuranceFindingKey(
  finding: Pick<
    AssuranceFinding,
    "detector" | "code" | "subjectKind" | "subjectId"
  >,
): string {
  return createHash("sha256")
    .update(
      [
        finding.detector,
        finding.code,
        finding.subjectKind,
        finding.subjectId,
      ].join("\0"),
    )
    .digest("hex");
}

export async function appendAssuranceFindings(
  db: Postgres,
  input: {
    runId: string;
    workerId: string;
    leaseToken: number;
    spaceId: string;
    vaultId: string;
    findings: readonly AssuranceFinding[];
  },
): Promise<number> {
  if (input.findings.length > 1000) {
    throw new Error("ASSURANCE_FINDING_BATCH_TOO_LARGE");
  }
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const owner = await client.query(
      `select 1
         from assurance_runs
        where id=$1 and space_id=$2 and vault_id=$3
          and status='RUNNING' and lease_owner=$4 and lease_token=$5
          and lease_expires_at>now() and cancel_requested_at is null
        for update`,
      [
        input.runId,
        input.spaceId,
        input.vaultId,
        input.workerId,
        input.leaseToken,
      ],
    );
    if (owner.rowCount !== 1) throw new Error("ASSURANCE_RUN_FENCED");
    let inserted = 0;
    for (const finding of input.findings) {
      if (!DETECTOR_SET.has(finding.detector)) {
        throw new Error("ASSURANCE_DETECTOR_INVALID");
      }
      const result = await client.query(
        `insert into assurance_findings(
           run_id,space_id,vault_id,detector,severity,finding_key,
           subject_kind,subject_id,code,summary,evidence_refs,metadata
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb)
         on conflict(run_id,finding_key) do nothing`,
        [
          input.runId,
          input.spaceId,
          input.vaultId,
          finding.detector,
          finding.severity,
          assuranceFindingKey(finding),
          finding.subjectKind,
          finding.subjectId,
          finding.code,
          finding.summary,
          JSON.stringify(finding.evidenceRefs),
          JSON.stringify(finding.metadata),
        ],
      );
      inserted += result.rowCount ?? 0;
    }
    await client.query("commit");
    return inserted;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function completeAssuranceRun(
  db: Postgres,
  input: {
    runId: string;
    workerId: string;
    leaseToken: number;
    cursor?: AssuranceRunCursor;
    summary: Record<string, unknown>;
  },
): Promise<boolean> {
  const result = await db.pool.query(
    `update assurance_runs
        set status='COMPLETED',
            cursor=coalesce($4::jsonb,cursor),
            result_summary=$5::jsonb,
            completed_at=now(),
            lease_owner=null,
            lease_expires_at=null,
            updated_at=now()
      where id=$1 and status='RUNNING' and lease_owner=$2 and lease_token=$3
        and lease_expires_at>now() and cancel_requested_at is null`,
    [
      input.runId,
      input.workerId,
      input.leaseToken,
      input.cursor ? JSON.stringify(input.cursor) : null,
      JSON.stringify(input.summary),
    ],
  );
  return result.rowCount === 1;
}

export async function failAssuranceRun(
  db: Postgres,
  input: {
    runId: string;
    workerId: string;
    leaseToken: number;
    error: unknown;
    retryDelaySeconds?: number;
    cursor?: AssuranceRunCursor;
  },
): Promise<"RETRY" | "FAILED" | "FENCED"> {
  const retryDelaySeconds = Math.max(
    1,
    Math.min(3600, input.retryDelaySeconds ?? 30),
  );
  const result = await db.pool.query<{ status: string }>(
    `update assurance_runs
        set status=case
              when attempts < max_attempts then 'PENDING'
              else 'FAILED'
            end,
            cursor=coalesce($4::jsonb,cursor),
            error=$5::jsonb,
            next_attempt_at=case
              when attempts < max_attempts
                then now()+make_interval(secs => $6)
              else next_attempt_at
            end,
            completed_at=case
              when attempts < max_attempts then null
              else now()
            end,
            lease_owner=null,
            lease_expires_at=null,
            updated_at=now()
      where id=$1 and status='RUNNING' and lease_owner=$2 and lease_token=$3
        and lease_expires_at>now() and cancel_requested_at is null
      returning status`,
    [
      input.runId,
      input.workerId,
      input.leaseToken,
      input.cursor ? JSON.stringify(input.cursor) : null,
      JSON.stringify({
        code:
          input.error instanceof Error
            ? input.error.message
            : "ASSURANCE_RUN_FAILED",
      }),
      retryDelaySeconds,
    ],
  );
  const status = result.rows[0]?.status;
  if (status === "PENDING") return "RETRY";
  if (status === "FAILED") return "FAILED";
  return "FENCED";
}
