-- Federated multi-graph substrate.
--
-- A node identity is domain + scope + kind + canonical key + revision.
-- Projection revisions are mutable lifecycle pointers; nodes and edges retain
-- their revisioned identity/provenance so rebuilding one domain never rewrites
-- another domain's facts.

create unique index if not exists vaults_space_id_id_idx
  on vaults(space_id,id);

create table federated_graph_projection_revisions (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id) on delete cascade,
  vault_id uuid references vaults(id) on delete cascade,
  graph_domain text not null
    check (graph_domain in (
      'EPISTEMIC','SOFTWARE_CATALOG','CODE','RUNTIME',
      'TEMPORAL','WORK','COMMUNITY'
    )),
  scope_id text not null check (char_length(scope_id) between 1 and 512),
  revision text not null check (char_length(revision) between 1 and 512),
  source_revision text not null
    check (char_length(source_revision) between 1 and 1024),
  source_hash text check (
    source_hash is null or source_hash ~ '^[a-f0-9]{64}$'
  ),
  provider text not null check (char_length(provider) between 1 and 160),
  provider_version text
    check (provider_version is null or char_length(provider_version) between 1 and 160),
  configuration_version text not null
    check (char_length(configuration_version) between 1 and 512),
  lifecycle text not null default 'REQUESTED'
    check (lifecycle in ('REQUESTED','BUILT','ACTIVE','STALE','FAILED')),
  freshness text not null default 'FRESH'
    check (freshness in ('FRESH','STALE')),
  requested_at timestamptz not null default now(),
  built_at timestamptz,
  activated_at timestamptz,
  last_successful_update timestamptz,
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(space_id,graph_domain,scope_id,revision),
  check (built_at is null or built_at >= requested_at),
  check (activated_at is null or built_at is not null),
  check (last_successful_update is null or built_at is not null),
  constraint federated_graph_projection_vault_scope_fk
    foreign key(space_id,vault_id) references vaults(space_id,id)
);

create unique index federated_graph_projection_active_idx
  on federated_graph_projection_revisions(space_id,graph_domain,scope_id)
  where lifecycle='ACTIVE';

create index federated_graph_projection_lookup_idx
  on federated_graph_projection_revisions(
    space_id,graph_domain,scope_id,lifecycle,requested_at desc
  );

create table federated_graph_nodes (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id) on delete cascade,
  vault_id uuid references vaults(id) on delete cascade,
  graph_domain text not null
    check (graph_domain in (
      'EPISTEMIC','SOFTWARE_CATALOG','CODE','RUNTIME',
      'TEMPORAL','WORK','COMMUNITY'
    )),
  scope_id text not null check (char_length(scope_id) between 1 and 512),
  kind text not null check (char_length(kind) between 1 and 120),
  canonical_key text not null
    check (char_length(canonical_key) between 1 and 2048),
  revision text not null check (char_length(revision) between 1 and 512),
  authorization_path text,
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload)='object'),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  unique(space_id,graph_domain,scope_id,kind,canonical_key,revision),
  constraint federated_graph_node_vault_scope_fk
    foreign key(space_id,vault_id) references vaults(space_id,id)
);

create index federated_graph_nodes_scope_idx
  on federated_graph_nodes(space_id,graph_domain,scope_id,kind,canonical_key);
create index federated_graph_nodes_vault_idx
  on federated_graph_nodes(vault_id,graph_domain,scope_id)
  where vault_id is not null;

create table federated_graph_projection_nodes (
  projection_revision_id uuid not null
    references federated_graph_projection_revisions(id) on delete cascade,
  node_id uuid not null references federated_graph_nodes(id) on delete restrict,
  primary key(projection_revision_id,node_id)
);

create index federated_graph_projection_nodes_node_idx
  on federated_graph_projection_nodes(node_id,projection_revision_id);

create table federated_graph_edges (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id) on delete cascade,
  owner_graph_domain text not null
    check (owner_graph_domain in (
      'EPISTEMIC','SOFTWARE_CATALOG','CODE','RUNTIME',
      'TEMPORAL','WORK','COMMUNITY'
    )),
  from_node_id uuid not null references federated_graph_nodes(id) on delete restrict,
  to_node_id uuid not null references federated_graph_nodes(id) on delete restrict,
  relation_type text not null
    check (char_length(relation_type) between 1 and 160),
  authorization_path text,
  derivation text not null
    check (derivation in (
      'SOURCE_EXPLICIT',
      'DETERMINISTIC_EXTRACTED',
      'STATICALLY_RESOLVED',
      'MODEL_INFERRED',
      'HUMAN_ASSERTED',
      'RUNTIME_OBSERVED',
      'DYNAMICALLY_PROVEN',
      'DERIVED_SUMMARY'
    )),
  source_ids jsonb not null default '[]'::jsonb
    check (jsonb_typeof(source_ids)='array'),
  evidence_ids jsonb not null default '[]'::jsonb
    check (jsonb_typeof(evidence_ids)='array'),
  locator_refs jsonb not null default '[]'::jsonb
    check (jsonb_typeof(locator_refs)='array'),
  provenance_revision text not null
    check (char_length(provenance_revision) between 1 and 512),
  support_set_id text,
  confidence double precision
    check (confidence is null or (confidence >= 0 and confidence <= 1)),
  valid_from timestamptz,
  valid_to timestamptz,
  recorded_at timestamptz not null,
  provenance_hash text not null check (provenance_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_from is null or valid_to > valid_from),
  unique(
    space_id,owner_graph_domain,from_node_id,to_node_id,relation_type,
    provenance_revision,derivation,provenance_hash
  )
);

create index federated_graph_edges_from_idx
  on federated_graph_edges(space_id,from_node_id,relation_type);
create index federated_graph_edges_to_idx
  on federated_graph_edges(space_id,to_node_id,relation_type);

create table federated_graph_projection_edges (
  projection_revision_id uuid not null
    references federated_graph_projection_revisions(id) on delete cascade,
  edge_id uuid not null references federated_graph_edges(id) on delete restrict,
  primary key(projection_revision_id,edge_id)
);

create index federated_graph_projection_edges_edge_idx
  on federated_graph_projection_edges(edge_id,projection_revision_id);
