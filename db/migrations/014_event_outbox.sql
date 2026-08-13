-- Durable integration events for the modular monolith.
--
-- `event_outbox` is intentionally immutable.  Delivery state lives in
-- `event_deliveries`, so a single event can be delivered independently to
-- multiple consumers without making the event itself mutable.
create table event_outbox (
  event_id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in (
    'SourceRegistered',
    'ExtractionRequested',
    'ExtractionCompleted',
    'CompilationRequested',
    'KnowledgeDraftCreated',
    'ValidationRequested',
    'KnowledgePublished',
    'CorpusRevisionPublished',
    'LexicalIndexUpdateRequested',
    'VectorIndexUpdateRequested',
    'GraphIndexUpdateRequested',
    'ContextPackInvalidationRequested',
    'ImpactedEvalRunRequested'
  )),
  event_version integer not null default 1 check (event_version > 0),
  resource_id text not null,
  organization_id uuid references organizations(id),
  space_id uuid references spaces(id),
  vault_id uuid references vaults(id),
  correlation_id text,
  causation_id text,
  occurred_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index outbox_events_pending_order_idx
  on event_outbox(occurred_at, event_id);
create index outbox_events_resource_idx
  on event_outbox(resource_id, occurred_at desc);
create index outbox_events_space_idx
  on event_outbox(space_id, occurred_at desc);

-- The plural name remains an updatable compatibility view for callers that
-- use the conventional `outbox_events` spelling. Foreign keys must target the
-- canonical `event_outbox` table.
create view outbox_events as
select * from event_outbox;

create table event_consumers (
  consumer_name text primary key,
  enabled boolean not null default true,
  max_attempts integer not null default 8 check (max_attempts between 1 and 100),
  lease_seconds integer not null default 60 check (lease_seconds between 5 and 3600),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table event_deliveries (
  event_id uuid not null references event_outbox(event_id) on delete restrict,
  consumer_name text not null references event_consumers(consumer_name) on delete restrict,
  status text not null default 'PENDING' check (
    status in ('PENDING','CLAIMED','RETRY','SUCCEEDED','QUARANTINED')
  ),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_owner text,
  lease_token uuid,
  fencing_version bigint not null default 0,
  delivery_generation integer not null default 0 check (delivery_generation >= 0),
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  last_error jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (event_id, consumer_name),
  check ((status = 'CLAIMED') = (lease_owner is not null and lease_token is not null)),
  check (status <> 'SUCCEEDED' or completed_at is not null)
);

create index event_deliveries_claim_idx
  on event_deliveries(consumer_name, status, next_attempt_at, lease_expires_at, created_at);
create index event_deliveries_event_idx
  on event_deliveries(event_id, status);

create view event_consumptions as
select * from event_deliveries;

-- Attempt and quarantine records are append-only history.  Current delivery
-- state above is mutable solely to support leases and retries.
create table event_delivery_attempts (
  id bigserial primary key,
  event_id uuid not null references event_outbox(event_id) on delete restrict,
  consumer_name text not null,
  attempt integer not null check (attempt > 0),
  delivery_generation integer not null default 0 check (delivery_generation >= 0),
  worker_id text not null,
  fencing_version bigint not null,
  outcome text not null check (outcome in ('CLAIMED','SUCCEEDED','RETRY','QUARANTINED','LEASE_LOST')),
  error jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (event_id, consumer_name, delivery_generation, attempt)
);

create index event_delivery_attempts_event_idx
  on event_delivery_attempts(event_id, consumer_name, attempt desc);

create table event_quarantine (
  id bigserial primary key,
  event_id uuid not null references event_outbox(event_id) on delete restrict,
  consumer_name text not null,
  attempts integer not null check (attempts > 0),
  reason jsonb not null,
  quarantined_at timestamptz not null default now(),
  requeue_requested_at timestamptz,
  requeue_requested_by text
);

create index event_quarantine_open_idx
  on event_quarantine(consumer_name, event_id, quarantined_at desc)
  where requeue_requested_at is null;

-- DLQ is a compatibility/readability alias; quarantine remains the canonical
-- append-only record because operators may requeue a poisoned delivery.
create view event_dead_letters as
  select * from event_quarantine;

-- Fan-out is best effort at registration time and deterministic for future
-- events.  `register_event_consumer` backfills events published before the
-- consumer was registered.
create or replace function akp_seed_event_delivery()
returns trigger language plpgsql as $$
begin
  insert into event_deliveries(event_id, consumer_name)
  select new.event_id, consumer_name
    from event_consumers
   where enabled
  on conflict (event_id, consumer_name) do nothing;
  perform pg_notify('akp_outbox', new.event_id::text);
  return new;
end;
$$;

create trigger event_outbox_seed_delivery
after insert on event_outbox
for each row execute function akp_seed_event_delivery();

-- Outbox events and their append-only history cannot be rewritten or removed.
create or replace function akp_reject_outbox_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'OUTBOX_EVENT_IMMUTABLE';
end;
$$;

create trigger event_outbox_append_only_update
before update or delete on event_outbox
for each row execute function akp_reject_outbox_mutation();

create trigger event_delivery_attempts_append_only_update
before update or delete on event_delivery_attempts
for each row execute function akp_reject_outbox_mutation();

create or replace function akp_reject_quarantine_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'EVENT_QUARANTINE_APPEND_ONLY';
end;
$$;

create trigger event_quarantine_append_only_delete
before delete on event_quarantine
for each row execute function akp_reject_quarantine_mutation();

-- Impacted-evaluation requests are durable work items too. Keep the source
-- event on the run so redelivery cannot enqueue a second evaluation.
alter table eval_runs
  add column if not exists trigger_event_id uuid references event_outbox(event_id);
create unique index if not exists eval_runs_trigger_event_idx
  on eval_runs(trigger_event_id)
  where trigger_event_id is not null;
