-- Persist the bounded material omitted from a generated ContextPacket.
-- Handles stay in the public packet while payloads remain out-of-band so the
-- packet's measured token budget and content hash keep their original meaning.

create table context_packet_continuations (
  packet_id uuid not null references context_packets(id) on delete cascade,
  handle text not null check (handle ~ '^[a-f0-9]{64}$'),
  reason text not null,
  remaining_tokens integer not null check (remaining_tokens >= 0),
  sections jsonb not null check (jsonb_typeof(sections) = 'array'),
  created_at timestamptz not null default now(),
  primary key (packet_id, handle)
);

create index context_packet_continuations_handle_idx
  on context_packet_continuations(handle, created_at desc);

comment on table context_packet_continuations is
  'Out-of-band continuation payloads for generated ContextPackets; every read is re-authorized against current vault and credential scopes.';
