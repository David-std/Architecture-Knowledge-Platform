-- Durable trace for optional query-transformation experiments.
--
-- A transformation is search assistance only. Authorization, truth scope,
-- lifecycle/trust policy and the original query remain authoritative.

create table retrieval_query_traces (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id) on delete cascade,
  actor_id uuid references users(id) on delete set null,
  trace_id text,
  original_query text not null
    check (char_length(original_query) between 1 and 4096),
  original_query_hash text not null
    check (original_query_hash ~ '^[a-f0-9]{64}$'),
  intent text,
  strategy text,
  transformer_id text not null
    check (char_length(transformer_id) between 1 and 160),
  transform_kind text not null
    check (transform_kind in ('DECOMPOSITION','MULTI_QUERY','HYDE')),
  variants jsonb not null
    check (jsonb_typeof(variants)='array'),
  variant_count integer not null
    check (variant_count between 0 and 8),
  assisted_channels text[] not null default array[]::text[],
  vault_ids uuid[] not null,
  scope jsonb not null default '{}'::jsonb
    check (jsonb_typeof(scope)='object'),
  truth_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(truth_snapshot)='object'),
  created_at timestamptz not null default now(),
  check (jsonb_array_length(variants)=variant_count)
);

create index retrieval_query_traces_space_created_idx
  on retrieval_query_traces(space_id,created_at desc);

create index retrieval_query_traces_actor_created_idx
  on retrieval_query_traces(actor_id,created_at desc)
  where actor_id is not null;

comment on table retrieval_query_traces is
  'Durable audit trace for optional query transformations; transformed variants never replace authorization/truth/original-query semantics.';
