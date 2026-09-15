alter table event_outbox
  add column if not exists telemetry_metadata jsonb not null default '{}'::jsonb;

alter table event_outbox
  drop constraint if exists event_outbox_telemetry_metadata_object;

alter table event_outbox
  add constraint event_outbox_telemetry_metadata_object
  check (jsonb_typeof(telemetry_metadata) = 'object');

create index if not exists event_outbox_traceparent_idx
  on event_outbox ((telemetry_metadata->>'traceparent'))
  where telemetry_metadata ? 'traceparent';
