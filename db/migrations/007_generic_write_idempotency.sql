alter table idempotency_records
  add column if not exists request_hash text,
  add column if not exists response_status integer not null default 200;

create index if not exists idempotency_records_created_idx
  on idempotency_records(created_at);
