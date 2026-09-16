-- P2 workspace presence compatibility hardening. New participants must satisfy
-- the presence timestamp invariant even when older coordination write paths do
-- not explicitly supply last_seen_at. Presence remains only an ephemeral lease;
-- a participant is not online until presence_expires_at is advanced by heartbeat.

alter table workspace_session_participants
  alter column last_seen_at set default now();

comment on column workspace_session_participants.last_seen_at is
  'Initialized on join/rejoin and advanced by presence heartbeat; it grants no work ownership or authorization.';
