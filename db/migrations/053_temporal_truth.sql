-- Canonical bitemporal truth substrate.
-- Observation, fact, support and history rows are append-only. Mutable heads
-- only point to the latest immutable truth revision for a vault.
create table truth_revision_heads (
  vault_id uuid primary key references vaults(id),
  space_id uuid not null references spaces(id),
  revision_seq bigint not null default 0,
  revision_hash text,
  updated_at timestamptz not null default now(),
  check (revision_seq >= 0),
  check (revision_hash is null or revision_hash ~ '^[a-f0-9]{64}$')
);

create table truth_revisions (
  id uuid primary key,
  space_id uuid not null references spaces(id),
  vault_id uuid not null references vaults(id),
  revision_seq bigint not null check (revision_seq > 0),
  revision_hash text not null unique check (revision_hash ~ '^[a-f0-9]{64}$'),
  parent_revision_hash text check (
    parent_revision_hash is null or parent_revision_hash ~ '^[a-f0-9]{64}$'
  ),
  reason text not null check (length(btrim(reason)) between 1 and 120),
  resource_type text not null check (length(btrim(resource_type)) between 1 and 120),
  resource_id text not null check (length(btrim(resource_id)) between 1 and 2048),
  created_at timestamptz not null default now(),
  unique(vault_id,revision_seq)
);
create index truth_revisions_vault_created_idx
  on truth_revisions(vault_id,created_at desc);

create table source_episodes (
  id uuid primary key,
  space_id uuid not null references spaces(id),
  vault_id uuid not null references vaults(id),
  source_id uuid not null references sources(id),
  source_artifact_id uuid not null references source_artifacts(id),
  source_hash text not null check (source_hash ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz,
  ingested_at timestamptz not null,
  locator_refs jsonb not null default '[]'::jsonb
    check (jsonb_typeof(locator_refs)='array'),
  created_at timestamptz not null default now()
);
create index source_episodes_source_idx on source_episodes(source_id,ingested_at desc);
create index source_episodes_vault_idx on source_episodes(vault_id,ingested_at desc);

create table truth_support_sets (
  id uuid primary key,
  schema_version integer not null default 1 check (schema_version=1),
  space_id uuid not null references spaces(id),
  vault_id uuid not null references vaults(id),
  state text not null check (state in ('SUPPORTED','DISPUTED')),
  fact_ids uuid[] not null default '{}',
  evidence_ids uuid[] not null default '{}',
  source_artifact_ids uuid[] not null default '{}',
  source_revision_hashes text[] not null default '{}',
  source_episode_ids uuid[] not null default '{}',
  alternative_support_groups jsonb not null default '[]'::jsonb
    check (jsonb_typeof(alternative_support_groups)='array'),
  created_at timestamptz not null default now(),
  check (
    cardinality(fact_ids)
    + cardinality(evidence_ids)
    + cardinality(source_artifact_ids)
    + cardinality(source_revision_hashes)
    + cardinality(source_episode_ids) > 0
  )
);
create index truth_support_sets_vault_idx on truth_support_sets(vault_id,created_at desc);

create table temporal_facts (
  id uuid primary key,
  space_id uuid not null references spaces(id),
  vault_id uuid not null references vaults(id),
  scope_id text not null check (length(btrim(scope_id)) between 1 and 512),
  authorization_path text not null
    check (length(btrim(authorization_path)) between 1 and 4096),
  subject_ref text not null check (length(btrim(subject_ref)) between 1 and 2048),
  predicate text not null check (length(btrim(predicate)) between 1 and 512),
  object jsonb not null,
  valid_from timestamptz not null,
  valid_to timestamptz,
  recorded_at timestamptz not null,
  source_episode_id uuid references source_episodes(id),
  support_set_id uuid not null references truth_support_sets(id),
  lifecycle text not null check (lifecycle in ('ACTIVE','DISPUTED')),
  truth_revision_hash text not null references truth_revisions(revision_hash),
  truth_revision_seq bigint not null check (truth_revision_seq > 0),
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_to > valid_from)
);
create index temporal_facts_current_idx
  on temporal_facts(vault_id,subject_ref,predicate,valid_from,valid_to);
create index temporal_facts_recorded_idx
  on temporal_facts(vault_id,truth_revision_seq,recorded_at);

create table temporal_fact_supersessions (
  id uuid primary key,
  space_id uuid not null references spaces(id),
  vault_id uuid not null references vaults(id),
  old_fact_id uuid not null references temporal_facts(id),
  new_fact_id uuid not null references temporal_facts(id),
  truth_revision_hash text not null references truth_revisions(revision_hash),
  truth_revision_seq bigint not null check (truth_revision_seq > 0),
  recorded_at timestamptz not null,
  unique(old_fact_id,new_fact_id),
  check (old_fact_id<>new_fact_id)
);
create index temporal_fact_supersessions_old_idx
  on temporal_fact_supersessions(old_fact_id,truth_revision_seq);

create table source_episode_withdrawals (
  id uuid primary key,
  space_id uuid not null references spaces(id),
  vault_id uuid not null references vaults(id),
  source_episode_id uuid not null unique references source_episodes(id),
  reason text not null check (length(btrim(reason)) between 1 and 2048),
  truth_revision_hash text not null references truth_revisions(revision_hash),
  truth_revision_seq bigint not null check (truth_revision_seq > 0),
  recorded_at timestamptz not null
);

create table evidence_invalidations (
  id uuid primary key,
  space_id uuid not null references spaces(id),
  vault_id uuid not null references vaults(id),
  evidence_id uuid not null unique references evidence(id),
  reason text not null check (length(btrim(reason)) between 1 and 2048),
  truth_revision_hash text not null references truth_revisions(revision_hash),
  truth_revision_seq bigint not null check (truth_revision_seq > 0),
  recorded_at timestamptz not null
);

create table derived_truth_dependencies (
  id uuid primary key,
  space_id uuid not null references spaces(id),
  vault_id uuid not null references vaults(id),
  derived_store_kind text not null
    check (derived_store_kind in (
      'VECTOR','GRAPH_SUMMARY','COMMUNITY_REPORT','CACHED_SYNTHESIS',
      'CONTEXT_FRAGMENT','TASK_ARTIFACT'
    )),
  derived_item_ref text not null check (length(btrim(derived_item_ref)) between 1 and 4096),
  support_set_id uuid not null references truth_support_sets(id),
  source_revision_hashes text[] not null default '{}',
  truth_revision_hash text not null references truth_revisions(revision_hash),
  projection_revision text,
  created_at timestamptz not null default now(),
  unique(vault_id,derived_store_kind,derived_item_ref,truth_revision_hash)
);
create index derived_truth_dependencies_support_idx
  on derived_truth_dependencies(support_set_id,created_at desc);

create or replace function akp_reject_temporal_truth_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'TEMPORAL_TRUTH_IMMUTABLE';
end;
$$;

create trigger truth_revisions_append_only
before update or delete on truth_revisions
for each row execute function akp_reject_temporal_truth_mutation();
create trigger source_episodes_append_only
before update or delete on source_episodes
for each row execute function akp_reject_temporal_truth_mutation();
create trigger truth_support_sets_append_only
before update or delete on truth_support_sets
for each row execute function akp_reject_temporal_truth_mutation();
create trigger temporal_facts_append_only
before update or delete on temporal_facts
for each row execute function akp_reject_temporal_truth_mutation();
create trigger temporal_fact_supersessions_append_only
before update or delete on temporal_fact_supersessions
for each row execute function akp_reject_temporal_truth_mutation();
create trigger source_episode_withdrawals_append_only
before update or delete on source_episode_withdrawals
for each row execute function akp_reject_temporal_truth_mutation();
create trigger evidence_invalidations_append_only
before update or delete on evidence_invalidations
for each row execute function akp_reject_temporal_truth_mutation();
create trigger derived_truth_dependencies_append_only
before update or delete on derived_truth_dependencies
for each row execute function akp_reject_temporal_truth_mutation();

alter table event_outbox
  drop constraint if exists event_outbox_event_type_check;
alter table event_outbox
  add constraint event_outbox_event_type_check
  check (
    event_type in (
      'SourceRegistered','ExtractionRequested','ExtractionCompleted',
      'CompilationRequested','KnowledgeDraftCreated','ValidationRequested',
      'KnowledgePublished','CorpusRevisionPublished',
      'LexicalIndexUpdateRequested','VectorIndexUpdateRequested',
      'GraphIndexUpdateRequested','CodeGraphRefreshRequested',
      'CodeKnowledgeLinkApproved','GraphRevisionBuilt',
      'GraphRevisionActivated','GraphRevisionStale',
      'SourceWithdrawn','EvidenceInvalidated','FactSuperseded',
      'TruthRevisionPublished','DerivedSupportInvalidationRequested',
      'ContextPackInvalidationRequested','ImpactedEvalRunRequested',
      'WorkspaceSessionCreated','WorkspaceSessionUpdated',
      'WorkspaceClaimUpdated','WorkspaceHandoffCreated',
      'WorkspacePromotionRequested','ExternalObjectRefUpserted',
      'OfflineDraftQueued','OfflineDraftReconciled',
      'ContextFabricPeerRegistered','PrincipalRevoked'
    )
  );
