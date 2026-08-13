alter table vaults
  add column vault_key text,
  add column git_repository text,
  add column default_branch text not null default 'main',
  add column local_path text,
  add column content_roots text[] not null default array['.']::text[],
  add column source_roots text[] not null default '{}'::text[],
  add column schema_profile jsonb not null default '{}'::jsonb,
  add column eval_pack jsonb not null default '{"name":"generic","version":"1","enabled":true,"criticalCases":[]}'::jsonb,
  add column retrieval_config jsonb not null default '{}'::jsonb,
  add column permissions jsonb not null default '{}'::jsonb,
  add column enabled boolean not null default true,
  add column visibility text not null default 'PRIVATE';

alter table vaults
  add constraint vaults_visibility_check
  check (visibility in ('PRIVATE', 'TEAM', 'CENTRAL'));

-- Existing vaults inherit the enclosing space visibility only when it is one
-- of the supported values. New registrations must choose explicitly through
-- the generic VaultRegistration contract.
update vaults v
   set visibility = case s.visibility
                      when 'TEAM' then 'TEAM'
                      when 'CENTRAL' then 'CENTRAL'
                      else 'PRIVATE'
                    end
  from spaces s
 where s.id = v.space_id
   and v.visibility = 'PRIVATE';

-- A local path is not an identity: two vault registrations may intentionally
-- point at the same checkout path (or use the same path in isolated test
-- fixtures). `vault_key` remains the stable registry identity.
alter table vaults
  drop constraint if exists vaults_space_id_canonical_path_key;
create index vaults_space_path_idx on vaults(space_id, canonical_path);

update vaults
   set vault_key = trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'))
                   || '-' || left(id::text, 8),
       local_path = canonical_path
 where vault_key is null;

alter table vaults alter column vault_key set not null;
alter table vaults alter column local_path set not null;

alter table vaults
  add constraint vaults_vault_key_format
  check (vault_key ~ '^[a-z0-9][a-z0-9-]{1,62}$');

create unique index vaults_vault_key_idx on vaults(vault_key);
create index vaults_space_enabled_idx on vaults(space_id, enabled, vault_key);

alter table knowledge_documents
  drop constraint if exists knowledge_documents_space_id_path_key;

drop index if exists knowledge_documents_external_id_idx;

create unique index knowledge_documents_vault_external_id_idx
  on knowledge_documents(vault_id, external_id)
  where vault_id is not null and external_id is not null;

create unique index knowledge_documents_managed_external_id_idx
  on knowledge_documents(space_id, external_id)
  where vault_id is null and external_id is not null;

create unique index knowledge_documents_vault_path_idx
  on knowledge_documents(vault_id, path)
  where vault_id is not null;

create unique index knowledge_documents_managed_space_path_idx
  on knowledge_documents(space_id, path)
  where vault_id is null;

alter table knowledge_units add column vault_id uuid references vaults(id);
update knowledge_units u
   set vault_id = d.vault_id
  from knowledge_documents d
 where d.id = u.document_id;
create index knowledge_units_vault_idx on knowledge_units(vault_id, unit_type);

alter table embedding_generations add column vault_id uuid references vaults(id);
with preferred as (
  select distinct on (space_id) id, space_id
    from vaults
   order by space_id, last_imported_at desc nulls last, created_at
)
update embedding_generations target set vault_id=preferred.id
  from preferred where preferred.space_id=target.space_id and target.vault_id is null;
create index embedding_generations_vault_idx
  on embedding_generations(vault_id,status,created_at desc);

create table vault_index_revisions (
  space_id uuid not null references spaces(id),
  vault_id uuid not null references vaults(id),
  corpus_revision text not null,
  lexical_revision text,
  vector_revision text,
  graph_revision text,
  context_pack_revision text,
  retrieval_configuration_version text not null default 'rrf-v1',
  status text not null default 'DEGRADED',
  warnings jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key(space_id,vault_id)
);

insert into vault_index_revisions(
  space_id,vault_id,corpus_revision,lexical_revision,vector_revision,
  graph_revision,context_pack_revision,retrieval_configuration_version,
  status,warnings,updated_at
)
select i.space_id,v.id,i.corpus_revision,i.lexical_revision,i.vector_revision,
       i.graph_revision,i.context_pack_revision,i.retrieval_configuration_version,
       i.status,i.warnings,i.updated_at
  from index_revisions i
  join lateral (
    select id from vaults where space_id=i.space_id
     order by last_imported_at desc nulls last,created_at limit 1
  ) v on true
on conflict do nothing;

alter table sources add column vault_id uuid references vaults(id);
alter table evidence add column vault_id uuid references vaults(id);
alter table ingest_jobs add column vault_id uuid references vaults(id);
alter table reviews add column vault_id uuid references vaults(id);
alter table context_packets add column vault_id uuid references vaults(id);
alter table context_packets add column scope jsonb not null default '{}'::jsonb;
alter table eval_runs add column vault_id uuid references vaults(id);
alter table eval_runs add column eval_pack text not null default 'generic';
alter table eval_cases add column vault_id uuid references vaults(id);
alter table agent_sessions add column vault_id uuid references vaults(id);
alter table contradiction_clusters add column vault_id uuid references vaults(id);
alter table knowledge_lint_runs add column vault_id uuid references vaults(id);
alter table error_book add column vault_id uuid references vaults(id);
alter table schema_dry_runs add column vault_id uuid references vaults(id);
alter table audit_events add column vault_id uuid references vaults(id);
alter table document_leases add column vault_id uuid references vaults(id);
alter table projects add column vault_id uuid references vaults(id);

alter table projects
  drop constraint if exists projects_space_id_slug_key;
create unique index projects_vault_slug_idx
  on projects(vault_id, slug)
  where vault_id is not null;
create unique index projects_managed_space_slug_idx
  on projects(space_id, slug)
  where vault_id is null;

-- A space membership is intentionally not enough to read every vault in the
-- space. This second authorization boundary lets a private vault be granted
-- to selected users while team/central vaults can safely inherit the space
-- membership when no explicit rows exist (the resolver implements that
-- conservative compatibility fallback).
create table vault_memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  vault_id uuid not null references vaults(id) on delete cascade,
  role text not null check (role in ('VIEWER', 'CONTRIBUTOR', 'CURATOR', 'REVIEWER', 'ARCHITECT', 'ADMIN', 'SERVICE_ACCOUNT')),
  path_prefix text,
  permissions jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique nulls not distinct (user_id, vault_id, role, path_prefix)
);

create index vault_memberships_user_vault_idx
  on vault_memberships(user_id, vault_id, enabled);
create index vault_memberships_vault_user_idx
  on vault_memberships(vault_id, user_id, enabled);

-- Preserve access for imported baseline vaults. The resolver still applies
-- the current space membership and permission intersection at request time.
insert into vault_memberships(user_id, vault_id, role, path_prefix, permissions)
select m.user_id,
       v.id,
       m.role,
       m.path_prefix,
       case m.role
         when 'VIEWER' then '["knowledge:read","source:read"]'::jsonb
         when 'CONTRIBUTOR' then '["knowledge:read","source:read","source:write","knowledge:propose"]'::jsonb
         when 'CURATOR' then '["knowledge:read","source:read","source:write","knowledge:propose"]'::jsonb
         when 'REVIEWER' then '["knowledge:read","source:read","knowledge:review"]'::jsonb
         when 'ARCHITECT' then '["knowledge:read","source:read","source:write","knowledge:propose","knowledge:review","eval:run"]'::jsonb
         when 'ADMIN' then '["knowledge:read","source:read","source:write","knowledge:propose","knowledge:review","eval:run","admin"]'::jsonb
         when 'SERVICE_ACCOUNT' then '["knowledge:read","source:read","source:write"]'::jsonb
         else '[]'::jsonb
       end
  from memberships m
  join vaults v on v.space_id = m.space_id
on conflict do nothing;

with preferred as (
  select distinct on (space_id) id, space_id
    from vaults
   order by space_id, last_imported_at desc nulls last, created_at
)
update sources target set vault_id=preferred.id
  from preferred where preferred.space_id=target.space_id and target.vault_id is null;

update evidence target set vault_id=source.vault_id
  from sources source where source.id=target.source_id and target.vault_id is null;

with preferred as (
  select distinct on (space_id) id, space_id
    from vaults
   order by space_id, last_imported_at desc nulls last, created_at
)
update ingest_jobs target set vault_id=preferred.id
  from preferred where preferred.space_id=target.space_id and target.vault_id is null;

with preferred as (
  select distinct on (space_id) id, space_id
    from vaults
   order by space_id, last_imported_at desc nulls last, created_at
)
update reviews target set vault_id=preferred.id
  from preferred where preferred.space_id=target.space_id and target.vault_id is null;

with preferred as (
  select distinct on (space_id) id, space_id
    from vaults
   order by space_id, last_imported_at desc nulls last, created_at
)
update context_packets target set vault_id=preferred.id
  from preferred where preferred.space_id=target.space_id and target.vault_id is null;

with preferred as (
  select distinct on (space_id) id, space_id
    from vaults
   order by space_id, last_imported_at desc nulls last, created_at
)
update knowledge_lint_runs target set vault_id=preferred.id
  from preferred where preferred.space_id=target.space_id and target.vault_id is null;

with preferred as (
  select distinct on (space_id) id, space_id
    from vaults
   order by space_id, last_imported_at desc nulls last, created_at
)
update eval_runs target set vault_id=preferred.id
  from preferred where preferred.space_id=target.space_id and target.vault_id is null;

-- A contradiction cluster can only be assigned to a vault when every member
-- document belongs to the same vault. Mixed-vault clusters stay NULL and are
-- therefore never returned by a vault-scoped query by accident.
with cluster_vaults as (
  select c.id,
         (array_agg(d.vault_id))[1] as vault_id,
         count(distinct d.vault_id) as vault_count
    from contradiction_clusters c
    join contradiction_members cm on cm.cluster_id=c.id
    join knowledge_documents d on d.id=cm.document_id
   group by c.id
)
update contradiction_clusters target
   set vault_id=cluster_vaults.vault_id
  from cluster_vaults
 where target.id=cluster_vaults.id
   and cluster_vaults.vault_count=1
   and target.vault_id is null;

-- Newer writers may already preserve vault identity in operational JSON. Only
-- accept a syntactically valid ID that exists in this space; never cast
-- arbitrary user metadata into a foreign key.
update error_book e
   set vault_id=(e.metadata->>'vaultId')::uuid
 where e.vault_id is null
   and e.metadata->>'vaultId' ~ '^[0-9a-fA-F-]{36}$'
   and exists (
     select 1 from vaults v
      where v.id=(e.metadata->>'vaultId')::uuid and v.space_id=e.space_id
   );
update schema_dry_runs s
   set vault_id=(s.report->>'vaultId')::uuid
 where s.vault_id is null
   and s.report->>'vaultId' ~ '^[0-9a-fA-F-]{36}$'
   and exists (
     select 1 from vaults v
      where v.id=(s.report->>'vaultId')::uuid and v.space_id=s.space_id
   );
update audit_events a
   set vault_id=(a.metadata->>'vaultId')::uuid
 where a.vault_id is null
   and a.metadata->>'vaultId' ~ '^[0-9a-fA-F-]{36}$'
   and exists (
     select 1 from vaults v
      where v.id=(a.metadata->>'vaultId')::uuid and v.space_id=a.space_id
   );
update document_leases target
   set vault_id=d.vault_id
  from knowledge_documents d
 where d.id=target.document_id and target.vault_id is null;
with preferred as (
  select distinct on (space_id) id, space_id
    from vaults
   order by space_id, last_imported_at desc nulls last, created_at
)
update projects target
   set vault_id=preferred.id
  from preferred
 where preferred.space_id=target.space_id and target.vault_id is null;

-- The bootstrap schema keyed sources only by space. Keep legacy managed rows
-- unique inside their space, while allowing two vaults in that space to carry
-- the same source hash without treating one vault's artifact as the other's.
alter table sources
  drop constraint if exists sources_space_id_sha256_key;
drop index if exists sources_space_id_sha256_key;
create unique index sources_vault_sha256_idx
  on sources(vault_id, sha256)
  where vault_id is not null;
create unique index sources_managed_space_sha256_idx
  on sources(space_id, sha256)
  where vault_id is null;

create index sources_vault_idx on sources(vault_id, created_at desc);
create index evidence_vault_idx on evidence(vault_id, created_at desc);
create index ingest_jobs_vault_idx on ingest_jobs(vault_id, created_at desc);
create index reviews_vault_idx on reviews(vault_id, created_at desc);
create index context_packets_vault_idx on context_packets(vault_id, created_at desc);
create index eval_runs_vault_idx on eval_runs(vault_id, created_at desc);
create index eval_cases_vault_idx on eval_cases(vault_id, active, id);
create index contradiction_clusters_vault_idx
  on contradiction_clusters(vault_id, status, updated_at desc);
create index knowledge_lint_runs_vault_idx
  on knowledge_lint_runs(vault_id, created_at desc);
create index error_book_vault_idx
  on error_book(vault_id, status, created_at desc);
create index schema_dry_runs_vault_idx
  on schema_dry_runs(vault_id, created_at desc);
create index audit_events_vault_idx
  on audit_events(vault_id, created_at desc);
create index document_leases_vault_idx
  on document_leases(vault_id, updated_at desc);
create index projects_vault_idx on projects(vault_id, created_at desc);
