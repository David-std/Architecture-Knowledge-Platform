-- Make graph projection replacement lifecycle explicit without changing
-- source-of-truth ownership. Historical BUILT/STALE values remain valid.
alter table federated_graph_projection_revisions
  drop constraint if exists federated_graph_projection_revisions_lifecycle_check;

alter table federated_graph_projection_revisions
  add constraint federated_graph_projection_revisions_lifecycle_check
  check (lifecycle in (
    'REQUESTED','BUILDING','READY','BUILT',
    'ACTIVE','RETIRED','STALE','FAILED'
  ));

alter table federated_graph_projection_revisions
  add column if not exists building_at timestamptz,
  add column if not exists ready_at timestamptz,
  add column if not exists retired_at timestamptz;

alter table federated_graph_projection_revisions
  add constraint federated_graph_projection_building_time_check
    check (building_at is null or building_at >= requested_at),
  add constraint federated_graph_projection_ready_time_check
    check (
      ready_at is null
      or (building_at is not null and ready_at >= building_at)
    ),
  add constraint federated_graph_projection_retired_time_check
    check (
      retired_at is null
      or (activated_at is not null and retired_at >= activated_at)
    );
