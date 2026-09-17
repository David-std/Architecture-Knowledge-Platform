-- P2 Work / Activity graph.
--
-- external_object_refs already projects an authorized external object and
-- records which system owns it. Two things were missing to make that a work
-- graph rather than a bag of links:
--
--   1. the projection had no typed work classification, so nothing
--      distinguished a pull request from a meeting note;
--   2. there was no way to record that someone did something to it.
--
-- Both are added here without duplicating the reference model: the class is a
-- column on the existing projection, and activity is an append-only log that
-- points at it.

-- A deliberately small, closed vocabulary. It is the set of work objects the
-- first-party software delivery workflows actually traverse; a provider's own
-- finer-grained object_type stays in object_type, which remains free text.
alter table external_object_refs
  add column work_object_class text
  check (
    work_object_class is null or work_object_class in (
      'GOAL',
      'PROJECT',
      'WORK_ITEM',
      'PULL_REQUEST',
      'CODE_REVIEW',
      'INCIDENT',
      'CHANGE',
      'BUILD',
      'DEPLOYMENT',
      'ENVIRONMENT',
      'TEST_RUN',
      'MEETING',
      'MESSAGE',
      'DOCUMENT',
      'REPOSITORY',
      'SERVICE'
    )
  );

comment on column external_object_refs.work_object_class is
  'Typed work classification for the Work/Activity graph. NULL keeps a plain reference that no work query traverses.';

create index external_object_refs_work_class_idx
  on external_object_refs(vault_id, work_object_class)
  where work_object_class is not null;

-- Append-only activity. What a person or agent did, to which work object, when,
-- and — critically — on what basis we believe it.
create table work_activity_events (
  id bigserial primary key,
  space_id uuid not null,
  vault_id uuid not null,
  object_ref_id uuid not null
    references external_object_refs(id) on delete cascade,
  session_id uuid references agent_sessions(id) on delete set null,
  -- The acting principal. Recorded by identity, not by display name, so an
  -- agent's activity stays attributable to the human authority behind it.
  actor_principal_id uuid references principals(id),
  actor_external_id text
    check (actor_external_id is null or char_length(actor_external_id) between 1 and 512),
  action text not null
    check (
      action in (
        'CREATED',
        'UPDATED',
        'COMMENTED',
        'REVIEWED',
        'APPROVED',
        'REJECTED',
        'MERGED',
        'CLOSED',
        'REOPENED',
        'ASSIGNED',
        'ESCALATED',
        'DEPLOYED',
        'ROLLED_BACK',
        'RESOLVED',
        'LINKED',
        'REFERENCED',
        'CAUSED'
      )
    ),
  -- An action may point at a second object: a deployment that CAUSED an
  -- incident, a pull request that RESOLVED a work item.
  target_ref_id uuid references external_object_refs(id) on delete cascade,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  source_system text not null
    check (char_length(source_system) between 1 and 80),
  -- How we know. Observed ordering is not the same claim as the source system
  -- stating it, and neither is the same as a model's guess.
  derivation text not null
    check (
      derivation in (
        'SOURCE_EXPLICIT',
        'OBSERVED_CORRELATION',
        'MODEL_INFERRED',
        'HUMAN_ASSERTED',
        'DYNAMICALLY_PROVEN'
      )
    ),
  evidence_refs jsonb not null default '[]'::jsonb
    check (jsonb_typeof(evidence_refs)='array'),
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload)='object'),
  -- Correlation is not causality. A CAUSED edge asserts that one object
  -- brought about another, so it may only rest on a source statement, a human
  -- assertion, or dynamic proof. Frequency of co-occurrence never promotes an
  -- observation or a model's guess into an architectural fact, and the
  -- database refuses to store one that claims otherwise.
  constraint work_activity_events_causality_requires_support
    check (
      action <> 'CAUSED'
      or derivation in ('SOURCE_EXPLICIT','HUMAN_ASSERTED','DYNAMICALLY_PROVEN')
    ),
  -- A relational action needs something to relate to.
  constraint work_activity_events_relational_actions_need_target
    check (
      action not in ('LINKED','REFERENCED','CAUSED','RESOLVED')
      or target_ref_id is not null
    ),
  constraint work_activity_events_actor_identified
    check (actor_principal_id is not null or actor_external_id is not null),
  constraint work_activity_events_vault_scope_fk
    foreign key(space_id,vault_id) references vaults(space_id,id)
);

create index work_activity_events_object_idx
  on work_activity_events(object_ref_id, occurred_at desc);
create index work_activity_events_vault_idx
  on work_activity_events(vault_id, occurred_at desc);
create index work_activity_events_session_idx
  on work_activity_events(session_id, occurred_at desc)
  where session_id is not null;
create index work_activity_events_target_idx
  on work_activity_events(target_ref_id, occurred_at desc)
  where target_ref_id is not null;

-- Activity is history. Correcting an observation means recording a further
-- event, never rewriting what was already observed.
--
-- Deletes are permitted because they only arrive by cascade when the owning
-- object or vault goes away, and activity about a deleted object should go
-- with it. One update is permitted for the same reason: session_id is ON
-- DELETE SET NULL, so retiring a workspace session detaches the correlation
-- without touching the observation. Every other change is refused.
create or replace function akp_guard_work_activity_events_immutable()
returns trigger
language plpgsql
as $function$
begin
  -- Everything except the detached correlation must be byte-identical.
  if old.session_id is not null
     and new.session_id is null
     and (to_jsonb(old) - 'session_id') = (to_jsonb(new) - 'session_id')
  then
    return new;
  end if;
  raise exception 'WORK_ACTIVITY_EVENT_IMMUTABLE';
end;
$function$;

create trigger work_activity_events_immutable
  before update on work_activity_events
  for each row execute function akp_guard_work_activity_events_immutable();
