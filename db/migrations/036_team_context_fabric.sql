-- P2 Team Context Fabric. Coordination and offline state remain operational
-- state; approved knowledge still requires the existing governed Git review
-- lifecycle. This migration extends, rather than edits, the applied P2 schema.

alter table workspace_events
  drop constraint if exists workspace_events_event_type_check;
alter table workspace_events
  add constraint workspace_events_event_type_check
  check (
    event_type in (
      'SESSION_CREATED',
      'PARTICIPANT_JOINED',
      'CLAIM_ACQUIRED',
      'CLAIM_HEARTBEAT',
      'CLAIM_HANDOFF',
      'FINDING',
      'BLOCKER',
      'QUESTION',
      'ARTIFACT',
      'DECISION_CANDIDATE',
      'PROMOTION_REQUESTED',
      'NOTE'
    )
  );

alter table event_outbox
  drop constraint if exists event_outbox_event_type_check;
alter table event_outbox
  add constraint event_outbox_event_type_check
  check (
    event_type in (
      'SourceRegistered',
      'ExtractionRequested',
      'ExtractionCompleted',
      'CompilationRequested',
      'KnowledgeDraftCreated',
      'ValidationRequested',
      'KnowledgePublished',
      'CorpusRevisionPublished',
      'LexicalIndexUpdateRequested',
      'VectorIndexUpdateRequested',
      'GraphIndexUpdateRequested',
      'ContextPackInvalidationRequested',
      'ImpactedEvalRunRequested',
      'WorkspaceSessionCreated',
      'WorkspaceClaimUpdated',
      'WorkspaceHandoffCreated',
      'WorkspacePromotionRequested',
      'ExternalObjectRefUpserted',
      'OfflineDraftQueued',
      'OfflineDraftReconciled',
      'ContextFabricPeerRegistered'
    )
  );

create table external_object_refs (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null,
  vault_id uuid not null,
  session_id uuid references agent_sessions(id) on delete cascade,
  provider text not null
    check (char_length(provider) between 1 and 80),
  object_type text not null
    check (char_length(object_type) between 1 and 80),
  external_id text not null
    check (char_length(external_id) between 1 and 512),
  canonical_url text,
  source_revision text,
  title text,
  authority text not null default 'SYSTEM_OF_RECORD'
    check (authority in ('SYSTEM_OF_RECORD','REFERENCE','MIRRORED_PROJECTION')),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata)='object'),
  observed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint external_object_refs_vault_scope_fk
    foreign key(space_id,vault_id) references vaults(space_id,id),
  unique(vault_id,provider,object_type,external_id)
);

create index external_object_refs_session_idx
  on external_object_refs(session_id,updated_at desc)
  where session_id is not null;
create index external_object_refs_lookup_idx
  on external_object_refs(vault_id,provider,object_type,external_id);

create or replace function akp_guard_external_object_ref_scope()
returns trigger language plpgsql as $$
declare
  session_space uuid;
  session_vault uuid;
begin
  if new.session_id is null then
    return new;
  end if;
  select space_id,vault_id into session_space,session_vault
    from agent_sessions where id=new.session_id;
  if session_space is null
     or session_space <> new.space_id
     or session_vault <> new.vault_id then
    raise exception 'EXTERNAL_OBJECT_REF_SCOPE_MISMATCH';
  end if;
  return new;
end;
$$;

create trigger external_object_refs_guard_scope
  before insert or update on external_object_refs
  for each row execute function akp_guard_external_object_ref_scope();

create table workspace_offline_drafts (
  id uuid primary key default gen_random_uuid(),
  client_draft_id text not null
    check (char_length(client_draft_id) between 1 and 200),
  session_id uuid not null references agent_sessions(id) on delete cascade,
  space_id uuid not null,
  vault_id uuid not null,
  actor_id uuid not null references users(id),
  base_revision_set_hash text not null
    check (base_revision_set_hash ~ '^[a-f0-9]{64}$'),
  event_type text not null
    check (event_type in ('FINDING','ARTIFACT','DECISION_CANDIDATE','NOTE')),
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload)='object'),
  status text not null default 'QUEUED'
    check (status in ('QUEUED','RECONCILE_REQUIRED','APPLIED','DISCARDED')),
  queued_at timestamptz not null default now(),
  reconciled_at timestamptz,
  applied_event_id bigint references workspace_events(id),
  constraint workspace_offline_drafts_vault_scope_fk
    foreign key(space_id,vault_id) references vaults(space_id,id),
  constraint workspace_offline_drafts_participant_fk
    foreign key(session_id,actor_id)
    references workspace_session_participants(session_id,user_id),
  unique(session_id,actor_id,client_draft_id),
  check ((status='APPLIED') = (applied_event_id is not null)),
  check (status not in ('APPLIED','DISCARDED') or reconciled_at is not null)
);

create index workspace_offline_drafts_pending_idx
  on workspace_offline_drafts(session_id,status,queued_at)
  where status in ('QUEUED','RECONCILE_REQUIRED');

create or replace function akp_guard_workspace_offline_draft_scope()
returns trigger language plpgsql as $$
declare
  session_space uuid;
  session_vault uuid;
begin
  select space_id,vault_id into session_space,session_vault
    from agent_sessions where id=new.session_id;
  if session_space is null
     or session_space <> new.space_id
     or session_vault <> new.vault_id then
    raise exception 'OFFLINE_DRAFT_SCOPE_MISMATCH';
  end if;
  if tg_op='UPDATE' and row(
    new.client_draft_id,new.session_id,new.space_id,new.vault_id,new.actor_id,
    new.base_revision_set_hash,new.event_type,new.payload,new.queued_at
  ) is distinct from row(
    old.client_draft_id,old.session_id,old.space_id,old.vault_id,old.actor_id,
    old.base_revision_set_hash,old.event_type,old.payload,old.queued_at
  ) then
    raise exception 'OFFLINE_DRAFT_IDENTITY_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger workspace_offline_drafts_guard_scope
  before insert or update on workspace_offline_drafts
  for each row execute function akp_guard_workspace_offline_draft_scope();

create table context_fabric_peers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  space_id uuid references spaces(id) on delete cascade,
  peer_key text not null check (peer_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  display_name text not null check (char_length(display_name) between 1 and 200),
  endpoint text,
  discovery_mode text not null default 'CATALOG_ONLY'
    check (discovery_mode in ('CATALOG_ONLY','REMOTE_QUERY','MIRROR_BUNDLE')),
  trust_state text not null default 'DISCOVERED'
    check (trust_state in ('DISCOVERED','APPROVED','DISABLED')),
  capabilities jsonb not null default '{}'::jsonb
    check (jsonb_typeof(capabilities)='object'),
  revision text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,peer_key)
);

create index context_fabric_peers_space_idx
  on context_fabric_peers(space_id,trust_state,updated_at desc);

comment on table external_object_refs is
  'Authorized references/projections of external systems of record; not canonical AKP knowledge.';
comment on table workspace_offline_drafts is
  'Queued offline coordination drafts. Never approved knowledge and never last-write-wins publication.';
comment on table context_fabric_peers is
  'Federation discovery metadata only. Remote query/import semantics remain separately authorized.';
