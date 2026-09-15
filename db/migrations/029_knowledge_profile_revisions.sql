-- Persist versioned KnowledgeProfile revisions without changing the v0.3
-- runtime default. A vault with no active durable revision continues to use
-- its legacy schema_profile/default behavior until an explicit reviewed
-- activation path is introduced.

-- Profile revisions are always scoped by both space and vault. The composite
-- key makes that isolation a database invariant instead of relying only on
-- application predicates.
alter table vaults
  add constraint vaults_space_id_id_profile_scope_key unique (space_id, id);

create table knowledge_profile_revisions (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null,
  vault_id uuid not null,
  profile_id text not null,
  version text not null,
  profile_hash text not null check (profile_hash ~ '^[a-f0-9]{64}$'),
  canonical_profile text not null,
  status text not null default 'DRAFT' check (
    status in (
      'DRAFT',
      'VALIDATED',
      'REVIEW_REQUIRED',
      'ACTIVE',
      'SUPERSEDED',
      'RETIRED'
    )
  ),
  compatibility_class text check (
    compatibility_class is null or compatibility_class in (
      'NON_BREAKING',
      'REINDEX_REQUIRED',
      'RECOMPILE_REQUIRED',
      'MIGRATION_REQUIRED',
      'UNSAFE'
    )
  ),
  corpus_revision text not null,
  supersedes_revision_id uuid,
  created_by uuid references users(id),
  validation_report jsonb not null default '{}'::jsonb,
  validated_at timestamptz,
  activated_at timestamptz,
  superseded_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_profile_revisions_space_vault_fk
    foreign key (space_id, vault_id)
    references vaults(space_id, id) on delete cascade,
  constraint knowledge_profile_revisions_profile_id_format
    check (profile_id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  constraint knowledge_profile_revisions_version_nonempty
    check (length(btrim(version)) between 1 and 100),
  constraint knowledge_profile_revisions_canonical_object
    check (jsonb_typeof(canonical_profile::jsonb) = 'object'),
  constraint knowledge_profile_revisions_canonical_hash
    check (profile_hash = encode(digest(canonical_profile, 'sha256'), 'hex')),
  constraint knowledge_profile_revisions_classified_after_draft
    check (status = 'DRAFT' or compatibility_class is not null),
  unique (vault_id, profile_id, version),
  unique (vault_id, profile_hash),
  unique (vault_id, id)
);

alter table knowledge_profile_revisions
  add constraint knowledge_profile_revisions_supersedes_fk
  foreign key (vault_id, supersedes_revision_id)
  references knowledge_profile_revisions(vault_id, id)
  deferrable initially deferred;

create index knowledge_profile_revisions_vault_created_idx
  on knowledge_profile_revisions(vault_id, created_at desc);
create index knowledge_profile_revisions_space_vault_status_idx
  on knowledge_profile_revisions(space_id, vault_id, status);
create unique index knowledge_profile_revisions_one_active_per_vault_idx
  on knowledge_profile_revisions(vault_id)
  where status = 'ACTIVE';

-- A revision's semantic identity is immutable. Lifecycle, compatibility,
-- validation evidence and lifecycle timestamps may evolve through governed
-- transitions, but changing the serialized contract creates a new revision.
create or replace function akp_guard_knowledge_profile_revision_identity()
returns trigger
language plpgsql
as $function$
begin
  if row(
    new.space_id,
    new.vault_id,
    new.profile_id,
    new.version,
    new.profile_hash,
    new.canonical_profile,
    new.corpus_revision,
    new.supersedes_revision_id,
    new.created_by,
    new.created_at
  ) is distinct from row(
    old.space_id,
    old.vault_id,
    old.profile_id,
    old.version,
    old.profile_hash,
    old.canonical_profile,
    old.corpus_revision,
    old.supersedes_revision_id,
    old.created_by,
    old.created_at
  ) then
    raise exception 'KNOWLEDGE_PROFILE_REVISION_IMMUTABLE';
  end if;
  return new;
end;
$function$;

create trigger knowledge_profile_revisions_guard_identity
  before update on knowledge_profile_revisions
  for each row execute function akp_guard_knowledge_profile_revision_identity();

alter table vaults
  add column active_knowledge_profile_revision_id uuid;

-- The composite FK prevents a vault from pointing at a profile revision owned
-- by another vault. It is nullable so existing v0.3 vaults remain untouched.
alter table vaults
  add constraint vaults_active_knowledge_profile_revision_fk
  foreign key (id, active_knowledge_profile_revision_id)
  references knowledge_profile_revisions(vault_id, id)
  deferrable initially deferred;

comment on column vaults.schema_profile is
  'Legacy v0.3 schema profile/configuration. When active_knowledge_profile_revision_id is non-null, the referenced durable KnowledgeProfile revision is authoritative.';
comment on column vaults.active_knowledge_profile_revision_id is
  'Atomic binding to the authoritative durable KnowledgeProfile revision. NULL preserves v0.3 legacy/default semantics.';

alter table schema_dry_runs
  add column profile_revision_id uuid references knowledge_profile_revisions(id),
  add column compatibility_class text;

update schema_dry_runs
   set compatibility_class = case compatibility_status
     when 'MIGRATION_REQUIRED' then 'MIGRATION_REQUIRED'
     else 'NON_BREAKING'
   end
 where compatibility_class is null;

alter table schema_dry_runs
  alter column compatibility_class set not null,
  add constraint schema_dry_runs_profile_compatibility_class_check
  check (
    compatibility_class in (
      'NON_BREAKING',
      'REINDEX_REQUIRED',
      'RECOMPILE_REQUIRED',
      'MIGRATION_REQUIRED',
      'UNSAFE'
    )
  );

create index schema_dry_runs_profile_revision_idx
  on schema_dry_runs(profile_revision_id, created_at desc)
  where profile_revision_id is not null;
