create table derived_truth_projection_revisions (
  id uuid primary key,
  space_id uuid not null references spaces(id),
  vault_id uuid not null references vaults(id),
  truth_revision_hash text not null references truth_revisions(revision_hash),
  truth_revision_seq bigint not null check (truth_revision_seq > 0),
  trigger_event_id uuid not null unique references event_outbox(event_id),
  reason text not null
    check (reason in ('FACT_SUPERSEDED','SOURCE_WITHDRAWN','EVIDENCE_INVALIDATED')),
  resource_id uuid not null,
  evaluated_valid_at timestamptz not null,
  projection_hash text not null
    check (projection_hash ~ '^[a-f0-9]{64}$'),
  item_count integer not null check (item_count >= 0),
  created_at timestamptz not null default now()
);

create index derived_truth_projection_revisions_vault_idx
  on derived_truth_projection_revisions(vault_id,truth_revision_seq desc,created_at desc);

create table derived_truth_projection_items (
  projection_revision_id uuid not null
    references derived_truth_projection_revisions(id),
  space_id uuid not null references spaces(id),
  vault_id uuid not null references vaults(id),
  derived_store_kind text not null
    check (derived_store_kind in (
      'VECTOR','GRAPH_SUMMARY','COMMUNITY_REPORT','CACHED_SYNTHESIS',
      'CONTEXT_FRAGMENT','TASK_ARTIFACT'
    )),
  derived_item_ref text not null
    check (length(btrim(derived_item_ref)) between 1 and 4096),
  state text not null
    check (state in ('SUPPORTED','DISPUTED','UNSUPPORTED','UNANNOTATED')),
  valid boolean not null,
  dependency_id uuid references derived_truth_dependencies(id),
  truth_revision_hash text not null references truth_revisions(revision_hash),
  truth_revision_seq bigint not null check (truth_revision_seq > 0),
  evaluated_valid_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key(projection_revision_id,derived_store_kind,derived_item_ref)
);

create index derived_truth_projection_items_current_idx
  on derived_truth_projection_items(
    vault_id,derived_store_kind,derived_item_ref,truth_revision_seq desc
  );

create trigger derived_truth_projection_revisions_append_only
before update or delete on derived_truth_projection_revisions
for each row execute function akp_reject_temporal_truth_mutation();

create trigger derived_truth_projection_items_append_only
before update or delete on derived_truth_projection_items
for each row execute function akp_reject_temporal_truth_mutation();
