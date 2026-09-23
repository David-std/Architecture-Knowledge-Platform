-- Continuous Assurance durable work and normalized findings.

create table assurance_runs (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id) on delete cascade,
  vault_id uuid not null,
  trigger text not null
    check (
      trigger in (
        'MANUAL','SCHEDULED','SOURCE_CHANGE','INDEX_CHANGE','CONNECTOR_EVENT'
      )
    ),
  detectors text[] not null,
  status text not null default 'PENDING'
    check (status in ('PENDING','RUNNING','COMPLETED','FAILED','CANCELLED')),
  idempotency_key text not null
    check (char_length(idempotency_key) between 1 and 200),
  cursor jsonb not null default '{"detectorIndex":0}'::jsonb
    check (
      jsonb_typeof(cursor)='object'
      and jsonb_typeof(cursor->'detectorIndex')='number'
      and (cursor->>'detectorIndex')::integer >= 0
    ),
  requested_by_user_id uuid references users(id) on delete set null,
  requested_by_principal_id uuid references principals(id) on delete set null,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  lease_owner text,
  lease_token bigint not null default 0 check (lease_token >= 0),
  lease_expires_at timestamptz,
  cancel_requested_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  error jsonb,
  result_summary jsonb not null default '{}'::jsonb
    check (jsonb_typeof(result_summary)='object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint assurance_runs_vault_scope_fk
    foreign key(space_id,vault_id)
    references vaults(space_id,id)
    on delete cascade,
  constraint assurance_runs_detectors_nonempty
    check (
      cardinality(detectors) between 1 and 17
      and detectors <@ array[
        'GROUNDING','FRESHNESS','CONTRADICTION','DUPLICATE_IDENTITY',
        'GRAPH_HEALTH','TEMPORAL_CONSISTENCY','CODE_GRAPH_FRESHNESS',
        'LINK_ORPHAN','SYNTHESIS_ACCESS_BOUNDARY','CONNECTOR_DELETION',
        'CONNECTOR_FRESHNESS','CONNECTOR_ACL_DRIFT','GRAPH_DISAGREEMENT',
        'ORPHAN_WORK','EXPIRED_CLAIM','STALE_HANDOFF',
        'UNSUPPORTED_CAUSALITY'
      ]::text[]
    ),
  unique(space_id,vault_id,idempotency_key)
);

create index assurance_runs_claim_idx
  on assurance_runs(status,next_attempt_at,lease_expires_at,created_at)
  where status in ('PENDING','RUNNING');

create table assurance_findings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references assurance_runs(id) on delete cascade,
  space_id uuid not null references spaces(id) on delete cascade,
  vault_id uuid not null,
  detector text not null,
  severity text not null check (severity in ('INFO','WARN','HIGH','CRITICAL')),
  finding_key text not null check (finding_key ~ '^[a-f0-9]{64}$'),
  subject_kind text not null
    check (char_length(subject_kind) between 1 and 120),
  subject_id text not null
    check (char_length(subject_id) between 1 and 4096),
  code text not null check (code ~ '^[A-Z][A-Z0-9_:-]{1,159}$'),
  summary text not null check (char_length(summary) between 1 and 4000),
  evidence_refs jsonb not null default '[]'::jsonb
    check (jsonb_typeof(evidence_refs)='array'),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata)='object'),
  state text not null default 'OPEN'
    check (state in ('OPEN','RESOLVED','SUPPRESSED')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint assurance_findings_vault_scope_fk
    foreign key(space_id,vault_id)
    references vaults(space_id,id)
    on delete cascade,
  unique(run_id,finding_key)
);

create index assurance_findings_scope_idx
  on assurance_findings(vault_id,detector,state,created_at desc);

create index assurance_findings_run_idx
  on assurance_findings(run_id,created_at);

comment on table assurance_runs is
  'Durable, idempotent, lease-fenced Continuous Assurance work. Cursor state is resumable and scoped to one vault.';

comment on table assurance_findings is
  'Normalized Continuous Assurance findings with evidence references; findings are diagnostics, never canonical knowledge.';
