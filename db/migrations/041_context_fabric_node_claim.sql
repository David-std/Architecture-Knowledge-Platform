-- P2.3 Team Context Node identity.
--
-- A deployment mode that only exists as an environment variable cannot stop the
-- failure it is meant to prevent: two writable nodes claiming authority over one
-- shared derived state. This singleton row records which node owns this
-- database, so a second node with a different identity fails closed instead of
-- silently interleaving coordination, index and graph writes.
create table context_fabric_node_claim (
  singleton boolean primary key default true check (singleton),
  node_id text not null
    check (
      char_length(node_id) between 1 and 200
      and node_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
    ),
  deployment_mode text not null
    check (
      deployment_mode in (
        'SOLO_LOCAL',
        'GIT_SYNC_SMALL_TEAM',
        'TEAM_NODE',
        'FEDERATED_ORG'
      )
    ),
  claimed_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  adopted_from text
);
