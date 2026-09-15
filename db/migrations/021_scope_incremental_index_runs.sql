-- Event identifiers are scoped inputs to the incremental index port. Keep
-- idempotency for one event within its space/vault without allowing a row in a
-- different vault to satisfy the same event lookup.
drop index if exists incremental_index_runs_event_idx;

create unique index incremental_index_runs_event_scope_idx
  on incremental_index_runs(space_id,vault_id,event_id)
  where event_id is not null;
