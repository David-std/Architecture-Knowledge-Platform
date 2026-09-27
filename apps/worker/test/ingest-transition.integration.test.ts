import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Postgres } from "@akp/postgres";
import { transitionClaimedIngestJob } from "../src/ingest-transition.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
const defaultSpace = "00000000-0000-0000-0000-000000000003";

async function seedClaimedJob(
  db: Postgres,
  input: {
    id: string;
    state?: string;
    workerId: string;
    version?: number;
  },
): Promise<void> {
  await db.pool.query(
    `
    insert into ingest_jobs(
      id,space_id,source_uri,state,payload,lease_owner,lease_expires_at,
      version,next_attempt_at
    )
    values($1,$2,$3,$4,'{}'::jsonb,$5,now()+interval '5 minutes',$6,now())
    `,
    [
      input.id,
      defaultSpace,
      `ingest-fence://${input.id}`,
      input.state ?? "HASHED",
      input.workerId,
      input.version ?? 1,
    ],
  );
}

async function cleanupJob(db: Postgres, jobId: string): Promise<void> {
  await db.pool.query("delete from ingest_jobs where id=$1", [jobId]);
}

integration("ingest transition fencing", () => {
  it("does not run stage side effects when cancellation wins the job lock", async () => {
    if (!databaseUrl) return;
    const db = new Postgres(databaseUrl);
    const jobId = randomUUID();
    const workerId = `ingest-fence-${randomUUID()}`;
    const lockClient = await db.pool.connect();
    let sideEffectRan = false;

    try {
      await seedClaimedJob(db, { id: jobId, workerId });
      await lockClient.query("begin");
      await lockClient.query(
        "select id from ingest_jobs where id=$1 for update",
        [jobId],
      );

      const transition = transitionClaimedIngestJob(
        db,
        {
          jobId,
          current: "HASHED",
          next: "STORED",
          expectedVersion: 1,
          workerId,
        },
        async () => {
          sideEffectRan = true;
        },
      );

      await lockClient.query(
        `
        update ingest_jobs
           set state='CANCELLED',cancelled_at=now(),lease_owner=null,
               lease_expires_at=null,updated_at=now()
         where id=$1
        `,
        [jobId],
      );
      await lockClient.query("commit");

      await expect(transition).rejects.toThrow("JOB_LEASE_LOST_OR_CANCELLED");
      expect(sideEffectRan).toBe(false);

      const job = await db.pool.query<{
        state: string;
        cancelled_at: Date | string | null;
      }>(
        "select state,cancelled_at from ingest_jobs where id=$1",
        [jobId],
      );
      expect(job.rows[0]?.state).toBe("CANCELLED");
      expect(job.rows[0]?.cancelled_at).not.toBeNull();
    } finally {
      await lockClient.query("rollback").catch(() => undefined);
      lockClient.release();
      await cleanupJob(db, jobId).catch(() => undefined);
      await db.close();
    }
  });

  it("rolls back stage side effects together with a failed transition", async () => {
    if (!databaseUrl) return;
    const db = new Postgres(databaseUrl);
    const jobId = randomUUID();
    const workerId = `ingest-side-effect-${randomUUID()}`;

    try {
      await seedClaimedJob(db, { id: jobId, workerId });

      await expect(
        transitionClaimedIngestJob(
          db,
          {
            jobId,
            current: "HASHED",
            next: "STORED",
            expectedVersion: 1,
            workerId,
          },
          async (client) => {
            await client.query(
              `
              insert into ingest_job_events(job_id,state,event_type,payload)
              values($1,'HASHED','TEST_SIDE_EFFECT','{}'::jsonb)
              `,
              [jobId],
            );
            throw new Error("SIDE_EFFECT_FAILED");
          },
        ),
      ).rejects.toThrow("SIDE_EFFECT_FAILED");

      const job = await db.pool.query<{
        state: string;
        lease_owner: string | null;
        version: string | number;
      }>(
        "select state,lease_owner,version from ingest_jobs where id=$1",
        [jobId],
      );
      expect(job.rows[0]).toMatchObject({
        state: "HASHED",
        lease_owner: workerId,
      });
      expect(Number(job.rows[0]?.version)).toBe(1);

      const events = await db.pool.query<{ count: number }>(
        `
        select count(*)::int count
          from ingest_job_events
         where job_id=$1 and event_type='TEST_SIDE_EFFECT'
        `,
        [jobId],
      );
      expect(events.rows[0]?.count).toBe(0);
    } finally {
      await cleanupJob(db, jobId).catch(() => undefined);
      await db.close();
    }
  });
});
