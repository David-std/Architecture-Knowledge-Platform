-- Durable P7 reasoning execution metadata.
--
-- Stores execution structure, hashes, result references, revisions, timings,
-- warnings and budget usage only. Query text, retrieved payload content and
-- hidden chain-of-thought are deliberately excluded.

create table reasoning_execution_traces (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id) on delete cascade,
  actor_id uuid references users(id) on delete set null,
  principal_id uuid references principals(id) on delete set null,
  request_id text,
  vault_ids uuid[] not null
    check (cardinality(vault_ids) between 1 and 20),
  plan_id text not null
    check (plan_id ~ '^reasoning:[a-f0-9]{64}$'),
  schema_version integer not null check (schema_version=1),
  intent text not null,
  revision_set_hash text not null
    check (revision_set_hash ~ '^[a-f0-9]{64}$'),
  started_at timestamptz not null,
  completed_at timestamptz not null,
  status text not null check (status in ('SUCCESS','PARTIAL','FAILED')),
  steps jsonb not null check (jsonb_typeof(steps)='array'),
  warnings jsonb not null default '[]'::jsonb
    check (jsonb_typeof(warnings)='array'),
  budget jsonb not null check (jsonb_typeof(budget)='object'),
  created_at timestamptz not null default now(),
  check (completed_at >= started_at)
);

create index reasoning_execution_traces_space_created_idx
  on reasoning_execution_traces(space_id,created_at desc);

create index reasoning_execution_traces_principal_created_idx
  on reasoning_execution_traces(principal_id,created_at desc)
  where principal_id is not null;

create index reasoning_execution_traces_plan_idx
  on reasoning_execution_traces(plan_id,created_at desc);

comment on table reasoning_execution_traces is
  'Auditable P7 reasoning execution metadata only; excludes query text, retrieved payloads and hidden chain-of-thought.';
