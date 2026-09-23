-- First-class relationship assertions for the federated graph.
--
-- The existing federated_graph_edges rows remain the structural/projection
-- compatibility layer. Assertion identity, lifecycle, provenance, support and
-- temporal validity live in a separate durable derived entity so independent
-- or disputed assertions are not flattened into an edge property bag.

create unique index if not exists federated_graph_nodes_space_id_id_idx
  on federated_graph_nodes(space_id,id);

create table federated_graph_relationship_assertions (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id) on delete cascade,
  owner_graph_domain text not null
    check (owner_graph_domain in (
      'EPISTEMIC','SOFTWARE_CATALOG','CODE','RUNTIME',
      'TEMPORAL','WORK','COMMUNITY'
    )),
  from_node_id uuid not null,
  to_node_id uuid not null,
  relation_type text not null
    check (char_length(relation_type) between 1 and 160),
  authorization_path text,
  lifecycle text not null default 'ACTIVE'
    check (lifecycle in ('ACTIVE','DISPUTED','SUPERSEDED','RETIRED')),
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
  assertion_hash text not null check (assertion_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(space_id,owner_graph_domain,from_node_id,to_node_id,relation_type,assertion_hash),
  unique(space_id,id),
  check (valid_to is null or valid_from is null or valid_to > valid_from),
  constraint federated_graph_assertion_from_space_fk
    foreign key(space_id,from_node_id)
    references federated_graph_nodes(space_id,id) on delete restrict,
  constraint federated_graph_assertion_to_space_fk
    foreign key(space_id,to_node_id)
    references federated_graph_nodes(space_id,id) on delete restrict
);

create index federated_graph_assertions_from_idx
  on federated_graph_relationship_assertions(
    space_id,from_node_id,relation_type,lifecycle
  );
create index federated_graph_assertions_to_idx
  on federated_graph_relationship_assertions(
    space_id,to_node_id,relation_type,lifecycle
  );
create index federated_graph_assertions_support_idx
  on federated_graph_relationship_assertions(space_id,support_set_id)
  where support_set_id is not null;

alter table federated_graph_edges
  add column assertion_id uuid;

insert into federated_graph_relationship_assertions(
  space_id,owner_graph_domain,from_node_id,to_node_id,relation_type,
  authorization_path,lifecycle,derivation,source_ids,evidence_ids,locator_refs,
  provenance_revision,support_set_id,confidence,valid_from,valid_to,recorded_at,
  assertion_hash
)
select
  space_id,owner_graph_domain,from_node_id,to_node_id,relation_type,
  authorization_path,'ACTIVE',derivation,source_ids,evidence_ids,locator_refs,
  provenance_revision,support_set_id,confidence,valid_from,valid_to,recorded_at,
  provenance_hash
from federated_graph_edges
on conflict(
  space_id,owner_graph_domain,from_node_id,to_node_id,relation_type,assertion_hash
) do nothing;

update federated_graph_edges e
   set assertion_id=a.id
  from federated_graph_relationship_assertions a
 where a.space_id=e.space_id
   and a.owner_graph_domain=e.owner_graph_domain
   and a.from_node_id=e.from_node_id
   and a.to_node_id=e.to_node_id
   and a.relation_type=e.relation_type
   and a.assertion_hash=e.provenance_hash;

alter table federated_graph_edges
  alter column assertion_id set not null;

alter table federated_graph_edges
  add constraint federated_graph_edge_assertion_space_fk
  foreign key(space_id,assertion_id)
  references federated_graph_relationship_assertions(space_id,id)
  on delete restrict;

create unique index federated_graph_edges_assertion_idx
  on federated_graph_edges(assertion_id);
