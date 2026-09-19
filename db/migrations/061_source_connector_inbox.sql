-- P8 authenticated source connector inbox with no-gap checkpoints.

create table source_connector_registrations (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id) on delete cascade,
  vault_id uuid not null,
  connector_key text not null
    check (connector_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  source_system text not null
    check (char_length(source_system) between 1 and 120),
  public_key_pem text not null
    check (char_length(public_key_pem) between 32 and 8192),
  descriptor jsonb not null
    check (jsonb_typeof(descriptor)='object'),
  state text not null default 'ACTIVE'
    check (state in ('ACTIVE','DISABLED')),
  created_by_user_id uuid references users(id) on delete set null,
  created_by_principal_id uuid references principals(id) on delete set null,
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_connector_registrations_vault_scope_fk
    foreign key(space_id,vault_id)
    references vaults(space_id,id)
    on delete cascade,
  unique(vault_id,connector_key)
);

create table source_connector_checkpoints (
  connector_id uuid primary key
    references source_connector_registrations(id) on delete cascade,
  applied_sequence bigint not null default 0
    check (applied_sequence >= 0),
  updated_at timestamptz not null default now()
);

create table source_connector_events (
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null
    references source_connector_registrations(id) on delete cascade,
  event_id text not null
    check (char_length(event_id) between 1 and 200),
  sequence bigint not null check (sequence > 0),
  occurred_at timestamptz not null,
  operation text not null check (operation in ('UPSERT','DELETE')),
  object_id text not null
    check (char_length(object_id) between 1 and 2048),
  object_type text not null
    check (char_length(object_type) between 1 and 120),
  source_version text not null
    check (char_length(source_version) between 1 and 1024),
  title text,
  content text,
  content_type text,
  permission_fidelity text not null
    check (
      permission_fidelity in (
        'SOURCE_ACL_EXACT','SOURCE_ACL_MAPPED','WORKSPACE_WIDE','NONE'
      )
    ),
  permission_uncertain boolean not null default false,
  acl_fingerprint text,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata)='object'),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'PENDING'
    check (status in ('PENDING','APPLIED','REJECTED')),
  error_code text,
  received_at timestamptz not null default now(),
  applied_at timestamptz,
  unique(connector_id,event_id),
  unique(connector_id,sequence),
  check (operation<>'DELETE' or content is null)
);

create index source_connector_events_pending_idx
  on source_connector_events(connector_id,sequence)
  where status='PENDING';

create table source_connector_objects (
  connector_id uuid not null
    references source_connector_registrations(id) on delete cascade,
  object_id text not null
    check (char_length(object_id) between 1 and 2048),
  object_type text not null
    check (char_length(object_type) between 1 and 120),
  source_version text not null
    check (char_length(source_version) between 1 and 1024),
  lifecycle text not null
    check (lifecycle in ('ACTIVE','DELETED_TOMBSTONE')),
  title text,
  content text,
  content_type text,
  content_trust text not null default 'UNTRUSTED_EXTERNAL'
    check (content_trust='UNTRUSTED_EXTERNAL'),
  permission_fidelity text not null
    check (
      permission_fidelity in (
        'SOURCE_ACL_EXACT','SOURCE_ACL_MAPPED','WORKSPACE_WIDE','NONE'
      )
    ),
  permission_uncertain boolean not null default false,
  acl_fingerprint text,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata)='object'),
  source_sequence bigint not null check (source_sequence > 0),
  observed_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key(connector_id,object_id),
  check (lifecycle<>'DELETED_TOMBSTONE' or content is null)
);

create index source_connector_objects_acl_idx
  on source_connector_objects(connector_id,permission_uncertain,lifecycle);

comment on table source_connector_events is
  'Signed generic connector inbox. Sequence is source-owned and only contiguous events advance the durable checkpoint.';
comment on table source_connector_objects is
  'Current untrusted external object projection. Deletions remain explicit tombstones.';
