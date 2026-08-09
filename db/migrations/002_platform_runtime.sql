create table vaults (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id),
  canonical_path text not null,
  name text not null,
  read_only boolean not null default true,
  current_revision text,
  last_imported_at timestamptz,
  created_at timestamptz not null default now(),
  unique (space_id, canonical_path)
);

alter table knowledge_documents add column vault_id uuid references vaults(id);
alter table knowledge_documents add column external_id text;
alter table knowledge_documents add column aliases text[] not null default '{}';
alter table knowledge_documents add column layer text;
alter table knowledge_documents add column content_hash text;
alter table knowledge_documents add column token_estimate integer not null default 0;
alter table knowledge_documents add column raw_links jsonb not null default '[]'::jsonb;

create unique index knowledge_documents_external_id_idx
  on knowledge_documents(space_id, external_id)
  where external_id is not null;

create table vault_import_runs (
  id uuid primary key default gen_random_uuid(),
  vault_id uuid not null references vaults(id),
  revision text not null,
  source_path text not null,
  read_only boolean not null,
  status text not null,
  metrics jsonb not null default '{}'::jsonb,
  report_path text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create table vault_import_issues (
  id bigserial primary key,
  run_id uuid not null references vault_import_runs(id) on delete cascade,
  severity text not null,
  code text not null,
  path text,
  message text not null,
  metadata jsonb not null default '{}'::jsonb
);

create table api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  token_hash text not null unique,
  label text not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id),
  slug text not null,
  root_path text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (space_id, slug)
);

create table agent_sessions (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id),
  actor_id uuid references users(id),
  project_id uuid references projects(id),
  purpose text not null,
  context_budget integer not null,
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table ingest_jobs add column cancelled_at timestamptz;
alter table ingest_jobs add column next_attempt_at timestamptz not null default now();
alter table ingest_jobs add column max_attempts integer not null default 5;
alter table ingest_jobs add column stage_outputs jsonb not null default '{}'::jsonb;

create table ingest_job_events (
  id bigserial primary key,
  job_id uuid not null references ingest_jobs(id) on delete cascade,
  state text not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table compilation_plans (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references ingest_jobs(id),
  source_id uuid references sources(id),
  plan jsonb not null,
  status text not null default 'PLANNED',
  created_at timestamptz not null default now()
);

alter table reviews add column decision_by uuid references users(id);
alter table reviews add column decision_at timestamptz;
alter table reviews add column decision_reason text;
alter table reviews add column merged_commit text;

insert into organizations(id, slug, name)
values ('00000000-0000-0000-0000-000000000001', 'local', 'Local Development')
on conflict do nothing;

insert into users(id, email, display_name)
values ('00000000-0000-0000-0000-000000000002', 'admin@localhost', 'Local Administrator')
on conflict do nothing;

insert into spaces(id, organization_id, slug, name, visibility, knowledge_repo_path)
values (
  '00000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000001',
  'architecture',
  'Architecture Knowledge',
  'PRIVATE',
  ''
)
on conflict do nothing;

insert into memberships(user_id, space_id, role)
values (
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000003',
  'ADMIN'
)
on conflict do nothing;

-- SHA-256 of the development-only token "dev-admin-token".
insert into api_tokens(user_id, token_hash, label)
values (
  '00000000-0000-0000-0000-000000000002',
  '1734d503f6aa6a047c36d113cbad769f719c93784b469b771c4c3e7c63adbefd',
  'local development'
)
on conflict do nothing;
