-- Provider-managed source connectors use provider cursors and secret references.
-- Tokens/credentials remain outside PostgreSQL.
alter table source_connector_registrations
  alter column public_key_pem drop not null;

alter table source_connector_registrations
  add column connector_mode text not null default 'SIGNED_WEBHOOK'
    check (connector_mode in ('SIGNED_WEBHOOK','PROVIDER_PULL')),
  add column credential_ref text,
  add column provider_config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(provider_config)='object');

alter table source_connector_registrations
  add constraint source_connector_auth_material_check
  check (
    (connector_mode='SIGNED_WEBHOOK'
      and public_key_pem is not null
      and credential_ref is null)
    or
    (connector_mode='PROVIDER_PULL'
      and public_key_pem is null
      and credential_ref is not null
      and credential_ref ~ '^[A-Z][A-Z0-9_]{1,127}$')
  );

alter table source_connector_checkpoints
  add column provider_checkpoint_kind text
    check (
      provider_checkpoint_kind is null
      or provider_checkpoint_kind in ('REVISION','OPAQUE_CURSOR','SOURCE_SEQUENCE')
    ),
  add column provider_checkpoint_value text,
  add column provider_health text not null default 'AVAILABLE'
    check (provider_health in ('AVAILABLE','DEGRADED','UNAVAILABLE')),
  add column provider_last_success_at timestamptz,
  add column provider_last_error_code text,
  add constraint source_connector_provider_checkpoint_pair
    check (
      (provider_checkpoint_kind is null) =
      (provider_checkpoint_value is null)
    );

comment on column source_connector_registrations.credential_ref is
  'Name/reference of an operator-owned provider credential. Secret bytes are never persisted.';
comment on column source_connector_registrations.provider_config is
  'Non-secret Jira/Linear/provider adapter configuration.';
