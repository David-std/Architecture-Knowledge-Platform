alter table workspace_session_participants
  add column last_seen_at timestamptz,
  add column presence_expires_at timestamptz;

update workspace_session_participants
   set last_seen_at=joined_at,
       presence_expires_at=joined_at
 where last_seen_at is null;

alter table workspace_session_participants
  alter column last_seen_at set not null;

alter table workspace_session_participants
  add constraint workspace_participant_presence_window_check
  check (
    presence_expires_at is null
    or presence_expires_at >= last_seen_at
  );

create index workspace_participant_presence_idx
  on workspace_session_participants(session_id,presence_expires_at desc)
  where left_at is null;

comment on column workspace_session_participants.presence_expires_at is
  'Ephemeral presence lease only; it grants no work ownership or authorization.';
