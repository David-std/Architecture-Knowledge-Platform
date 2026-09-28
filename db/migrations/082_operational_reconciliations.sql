-- Audited terminal dispositions for operational residue.
-- Historical outbox/quarantine/ingest rows remain untouched.
create table operational_reconciliations (
  id uuid primary key default gen_random_uuid(),
  resource_type text not null
    check (resource_type in ('EVENT_QUARANTINE','INGEST_JOB')),
  resource_key text not null check (char_length(resource_key) between 1 and 1024),
  space_id uuid references spaces(id) on delete restrict,
  vault_id uuid references vaults(id) on delete restrict,
  environment text not null default 'default'
    check (char_length(environment) between 1 and 120),
  disposition text not null check (
    disposition in (
      'RECOVERED_REPLAYED',
      'SUPERSEDED_BY_VERIFIED_PROJECTION',
      'IRRECOVERABLE_RECONCILED',
      'TERMINAL_FIXTURE_DISPOSITION'
    )
  ),
  actor text not null check (char_length(actor) between 1 and 256),
  rationale text not null check (char_length(rationale) between 1 and 4000),
  evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence)='object'),
  created_at timestamptz not null default now(),
  unique(resource_type,resource_key,environment)
);

create index operational_reconciliations_vault_idx
  on operational_reconciliations(vault_id,resource_type,created_at desc);

create or replace function akp_reject_operational_reconciliation_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'OPERATIONAL_RECONCILIATION_APPEND_ONLY';
end;
$$;

create trigger operational_reconciliations_append_only
before update or delete on operational_reconciliations
for each row execute function akp_reject_operational_reconciliation_mutation();

comment on table operational_reconciliations is
  'Append-only operator dispositions for quarantined deliveries and terminal failed ingests. Original history is preserved.';
