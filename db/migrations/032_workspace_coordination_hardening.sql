-- P2 coordination hardening. Preserve migration 031 and evolve the blackboard
-- with session-local versions, safe lease renewal, and stronger relational invariants.
alter table agent_sessions
  add column coordination_version bigint not null default 0;
alter table agent_sessions
  add constraint agent_sessions_coordination_version_check
  check (coordination_version >= 0);

alter table workspace_events
  add column session_version bigint;

with ranked as (
  select id,
         row_number() over (partition by session_id order by id) session_version
    from workspace_events
)
update workspace_events target
   set session_version=ranked.session_version
  from ranked
 where target.id=ranked.id;

update agent_sessions target
   set coordination_version=coalesce(events.max_version,0)
  from (
    select session_id,max(session_version) max_version
      from workspace_events
     group by session_id
  ) events
 where target.id=events.session_id;

alter table workspace_events
  alter column session_version set not null;
create unique index workspace_events_session_version_idx
  on workspace_events(session_id,session_version);

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
      'NOTE'
    )
  );

alter table workspace_claims
  add constraint workspace_claims_session_owner_fk
  foreign key(session_id,owner_id)
  references workspace_session_participants(session_id,user_id);
