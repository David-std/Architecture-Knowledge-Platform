-- Durable source-connector apply retries.
--
-- The signed inbox already preserves event order and checkpoint continuity.
-- These columns make transient projection failures observable/retryable without
-- advancing the source-owned checkpoint, and make terminal exhaustion explicit.

alter table source_connector_events
  add column apply_attempts integer not null default 0
    check (apply_attempts >= 0),
  add column max_apply_attempts integer not null default 8
    check (max_apply_attempts between 1 and 20),
  add column next_attempt_at timestamptz not null default now(),
  add column last_error_at timestamptz;

create index source_connector_events_retry_idx
  on source_connector_events(connector_id,next_attempt_at,sequence)
  where status='PENDING';

comment on column source_connector_events.apply_attempts is
  'Number of durable projection/apply attempts for this signed inbox event.';
comment on column source_connector_events.next_attempt_at is
  'Database-owned retry timestamp; checkpoint never advances while this event is pending.';
