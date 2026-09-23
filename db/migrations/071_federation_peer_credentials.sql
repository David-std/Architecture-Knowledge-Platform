-- Federation peer credentials remain outside PostgreSQL. The database stores
-- only the name of an environment variable resolved by the API process.
alter table context_fabric_peers
  add column credential_ref text;

alter table context_fabric_peers
  add constraint context_fabric_peers_credential_ref_check
  check (
    credential_ref is null
    or credential_ref ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'
  );

comment on column context_fabric_peers.credential_ref is
  'Non-secret environment-variable reference for outbound federation authentication.';
