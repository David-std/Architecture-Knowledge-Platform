-- Workspace-linked context packets preserve the provenance chain to their
-- session. A session with durable packets must be cleaned up explicitly rather
-- than silently nulling session_id and violating object/session invariants.
alter table context_packets
  drop constraint if exists context_packets_session_id_fkey;

alter table context_packets
  add constraint context_packets_session_id_fkey
  foreign key(session_id) references agent_sessions(id) on delete restrict;
