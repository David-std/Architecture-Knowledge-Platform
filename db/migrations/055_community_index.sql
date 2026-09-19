-- Versioned community index derived from an already-built graph projection.
--
-- Community summaries are navigation/orientation artifacts only. They are
-- explicitly DERIVED_INDEX and non-citable; source authority remains with the
-- underlying knowledge/evidence records in the support set.

-- The vault primary key already makes id globally unique. This redundant
-- composite index lets derived projections enforce that their space_id and
-- vault_id refer to the same tenant boundary with a composite foreign key.
create unique index if not exists vaults_space_id_id_idx
  on vaults(space_id,id);

create table community_index_revisions (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id) on delete cascade,
  vault_id uuid not null references vaults(id) on delete cascade,
  scope_id text not null check (char_length(scope_id) between 1 and 512),
  community_revision text not null
    check (char_length(community_revision) between 1 and 512),
  graph_revision text not null
    check (char_length(graph_revision) between 1 and 1024),
  algorithm text not null check (char_length(algorithm) between 1 and 120),
  algorithm_version text not null
    check (char_length(algorithm_version) between 1 and 120),
  objective text not null check (objective in ('CPM','MODULARITY')),
  resolution double precision not null check (resolution > 0),
  random_seed integer not null,
  quality double precision,
  hierarchy jsonb not null default '{}'::jsonb
    check (jsonb_typeof(hierarchy)='object'),
  lifecycle text not null default 'DERIVED_INDEX'
    check (lifecycle='DERIVED_INDEX'),
  status text not null default 'BUILT'
    check (status in ('BUILT','ACTIVE','STALE','FAILED')),
  stale boolean not null default false,
  built_at timestamptz not null default now(),
  activated_at timestamptz,
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(space_id,vault_id,scope_id,community_revision),
  constraint community_index_revision_vault_scope_fk
    foreign key(space_id,vault_id) references vaults(space_id,id),
  check ((status='ACTIVE' and stale=false) or status<>'ACTIVE'),
  check (activated_at is null or status in ('ACTIVE','STALE'))
);

create unique index community_index_active_idx
  on community_index_revisions(space_id,vault_id,scope_id)
  where status='ACTIVE' and stale=false;

create index community_index_revision_lookup_idx
  on community_index_revisions(
    space_id,vault_id,scope_id,graph_revision,status,built_at desc
  );

create table community_index_communities (
  revision_id uuid not null
    references community_index_revisions(id) on delete cascade,
  community_key text not null
    check (char_length(community_key) between 1 and 256),
  ordinal integer not null check (ordinal >= 0),
  member_count integer not null check (member_count >= 0),
  summary text not null,
  summary_lifecycle text not null default 'DERIVED_INDEX'
    check (summary_lifecycle='DERIVED_INDEX'),
  citable boolean not null default false check (citable=false),
  support_set jsonb not null default '{}'::jsonb
    check (jsonb_typeof(support_set)='object'),
  hierarchy jsonb not null default '{}'::jsonb
    check (jsonb_typeof(hierarchy)='object'),
  created_at timestamptz not null default now(),
  primary key(revision_id,community_key),
  unique(revision_id,ordinal)
);

create table community_index_memberships (
  revision_id uuid not null
    references community_index_revisions(id) on delete cascade,
  document_id uuid not null references knowledge_documents(id) on delete cascade,
  community_key text not null,
  hierarchy jsonb not null default '{}'::jsonb
    check (jsonb_typeof(hierarchy)='object'),
  created_at timestamptz not null default now(),
  primary key(revision_id,document_id),
  foreign key(revision_id,community_key)
    references community_index_communities(revision_id,community_key)
    on delete cascade
);

create index community_index_membership_community_idx
  on community_index_memberships(revision_id,community_key,document_id);
