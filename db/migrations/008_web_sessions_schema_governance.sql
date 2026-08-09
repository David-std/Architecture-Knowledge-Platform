create table web_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  csrf_hash text not null check (csrf_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  user_agent text,
  remote_address text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index web_sessions_active_idx
  on web_sessions(user_id, expires_at)
  where revoked_at is null;

create table schema_dry_runs (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id),
  actor_id uuid references users(id),
  candidate_version text not null,
  candidate_hash text not null check (candidate_hash ~ '^[a-f0-9]{64}$'),
  corpus_revision text not null,
  affected_document_count integer not null,
  compatibility_status text not null check (
    compatibility_status in ('COMPATIBLE', 'MIGRATION_REQUIRED')
  ),
  report jsonb not null,
  corpus_fingerprint_before text not null,
  corpus_fingerprint_after text not null,
  created_at timestamptz not null default now()
);

create index schema_dry_runs_space_idx
  on schema_dry_runs(space_id, created_at desc);
