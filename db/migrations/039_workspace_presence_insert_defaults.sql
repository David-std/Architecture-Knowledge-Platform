-- Presence is advisory coordination state and must not make participant creation
-- depend on every caller knowing the projection's storage columns. A newly joined
-- participant starts offline until an explicit presence heartbeat grants a lease.
-- The default repairs compatibility only; it does not imply an online lease.
alter table workspace_session_participants
  alter column last_seen_at set default now();

comment on column workspace_session_participants.last_seen_at is
  'Most recent join/presence observation. New participants default to their join time; online status still requires a non-expired presence_expires_at lease.';
