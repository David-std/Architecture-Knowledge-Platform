-- Durable links from generated context packets to the workspace/object that
-- requested them. Packet content remains retrieval output, not canonical
-- knowledge; these nullable FKs only make provenance/object-centric browsing
-- explicit without inferring associations from query text or timestamps.
alter table context_packets
  add column session_id uuid references agent_sessions(id) on delete set null,
  add column object_ref_id uuid
    references external_object_refs(id) on delete set null,
  add constraint context_packets_object_requires_session
    check (object_ref_id is null or session_id is not null);

create index context_packets_session_idx
  on context_packets(session_id,created_at desc)
  where session_id is not null;

create index context_packets_object_ref_idx
  on context_packets(object_ref_id,created_at desc)
  where object_ref_id is not null;
