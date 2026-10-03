-- Bounded authenticated absence reconciliation for provider-pull connectors.
--
-- Provider APIs do not always expose lifecycle changes in incremental search,
-- and a missing point read may also reflect authorization/visibility changes.
-- Rotate explicit fetch-by-id probes over active projections; runtime policy
-- must not treat ambiguous absence as proof of deletion.
alter table source_connector_objects
  add column if not exists provider_last_checked_at timestamptz;

create index if not exists source_connector_objects_provider_recheck_idx
  on source_connector_objects(
    connector_id,
    provider_last_checked_at nulls first,
    updated_at,
    object_id
  )
  where lifecycle='ACTIVE';
