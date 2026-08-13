import pg from "pg";

export * from "./vault-registry.js";
export * from "./outbox.js";

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
      where state in (
        'RECEIVED', 'HASHED', 'STORED', 'NORMALIZING', 'ANALYZING',
        'PLANNED', 'DRAFTED', 'VALIDATING', 'AUTO_APPROVED', 'MERGED',
        'INDEXED', 'EVALUATED'
      )
        and cancelled_at is null
        and next_attempt_at <= now()
        and (lease_expires_at is null or lease_expires_at < now())
      order by created_at
      for update skip locked
      limit 1
    )
    update ingest_jobs j
    set lease_owner = $1,
        lease_expires_at = now() + make_interval(secs => $2),
        heartbeat_at = now(),
        updated_at = now()
    from candidate
    where j.id = candidate.id
    returning j.*
    `,
    [workerId, leaseSeconds],
  );
  return result.rows[0] ?? null;
}

export type KnowledgeLintTrigger =
  | "MANUAL"
  | "MERGE"
  | "SOURCE_UPDATE"
  | "SCHEMA_UPDATE"
  | "INDEX_REBUILD"
  | "SCHEDULED";

export interface KnowledgeLintResult {
  id: string;
  spaceId: string;
  vaultId: string;
  trigger: KnowledgeLintTrigger;
  status: "PASSED" | "FINDINGS";
  corpusRevision: string;
  findings: Array<{ code: string; resource_id: string; detail: string }>;
}

export async function runKnowledgeLint(
  db: Postgres,
  spaceId: string,
  vaultId: string,
  trigger: KnowledgeLintTrigger,
): Promise<KnowledgeLintResult> {
  if (!vaultId.trim()) throw new Error("VAULT_SCOPE_REQUIRED");
  const findings = await db.pool.query<{
    code: string;
    resource_id: string;
    detail: string;
  }>(
    `
    select 'STALE_KNOWLEDGE'::text code,id::text resource_id,refresh_status::text detail
      from knowledge_documents
     where space_id=$1 and vault_id=$2
       and lifecycle in ('ACTIVE','DISPUTED')
       and refresh_status<>'CURRENT'
    union all
    select 'OPEN_CONTRADICTION',id::text,status::text
      from contradiction_clusters
     where space_id=$1 and vault_id=$2 and status<>'RESOLVED'
    union all
    select 'DUPLICATE_EXTERNAL_ID',external_id,count(*)::text
      from knowledge_documents
     where space_id=$1 and vault_id=$2 and external_id is not null
     group by vault_id,external_id having count(*)>1
    union all
    select 'UNUSED_SOURCE',s.id::text,s.status::text
      from sources s
     where s.space_id=$1 and s.vault_id=$2 and s.status='ACTIVE'
       and not exists(
         select 1 from evidence e where e.source_id=s.id and e.vault_id=$2
       )
    union all
    select 'ORPHAN_ACTIVE_KNOWLEDGE',d.id::text,d.path::text
      from knowledge_documents d
     where d.space_id=$1 and d.vault_id=$2 and d.lifecycle='ACTIVE'
       and d.layer not in ('source','resource','root')
       and coalesce(d.external_id,'') not like 'RAW-%'
       and not exists(
         select 1 from knowledge_relations r
          where r.space_id=$1
            and (r.from_document_id=d.id or r.to_document_id=d.id)
            and exists(
              select 1 from knowledge_documents f
               where f.id=r.from_document_id and f.vault_id=$2
            )
            and exists(
              select 1 from knowledge_documents t
               where t.id=r.to_document_id and t.vault_id=$2
            )
       )
    union all
    select 'REVIEW_AGE_EXCEEDED',d.id::text,d.stale_after::text
      from knowledge_documents d
     where d.space_id=$1 and d.vault_id=$2
       and d.lifecycle in ('ACTIVE','DISPUTED')
       and d.stale_after is not null and d.stale_after < now()
    order by code,resource_id
    `,
    [spaceId, vaultId],
  );
  const revision = await db.pool.query(
    `
    select coalesce(
      (select corpus_revision from vault_index_revisions where space_id=$1 and vault_id=$2),
      (select current_revision from vaults where space_id=$1 and id=$2),
      'unknown'
    ) revision
    `,
    [spaceId, vaultId],
  );
  const status = findings.rowCount ? "FINDINGS" : "PASSED";
  const inserted = await db.pool.query<{ id: string }>(
    `
    insert into knowledge_lint_runs(space_id,vault_id,trigger,corpus_revision,status,findings)
    values($1,$2,$3,$4,$5,$6::jsonb) returning id
    `,
    [
      spaceId,
      vaultId,
      trigger,
      String(revision.rows[0]?.revision ?? "unknown"),
      status,
      JSON.stringify(findings.rows),
    ],
  );
  return {
    id: String(inserted.rows[0]?.id),
    spaceId,
    vaultId,
    trigger,
    status,
    corpusRevision: String(revision.rows[0]?.revision ?? "unknown"),
    findings: findings.rows,
  };
}
