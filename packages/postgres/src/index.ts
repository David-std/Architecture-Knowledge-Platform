import pg from "pg";

export class Postgres {
  readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl });
  }

  async health(): Promise<boolean> {
    const result = await this.pool.query("select 1 as ok");
    return result.rows[0]?.ok === 1;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function claimNextIngestJob(
  db: Postgres,
  workerId: string,
  leaseSeconds = 60,
): Promise<Record<string, unknown> | null> {
  const result = await db.pool.query(
    `
    with candidate as (
      select id
      from ingest_jobs
      where state in ('RECEIVED', 'HASHED', 'STORED', 'NORMALIZING')
        and (lease_expires_at is null or lease_expires_at < now())
      order by created_at
      for update skip locked
      limit 1
    )
    update ingest_jobs j
    set lease_owner = $1,
        lease_expires_at = now() + make_interval(secs => $2),
        heartbeat_at = now(),
        attempts = attempts + 1,
        updated_at = now()
    from candidate
    where j.id = candidate.id
    returning j.*
    `,
    [workerId, leaseSeconds],
  );
  return result.rows[0] ?? null;
}
