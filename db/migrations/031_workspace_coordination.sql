-- P2 workspace coordination substrate. Coordination state is durable operational
-- state, not canonical knowledge. Events are append-only; claims are versioned
-- projections protected by lease expiry and fencing tokens.
create table workspace_session_participants (
  session_id uuid not null references agent_sessions(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'PARTICIPANT'
    check (role in ('OWNER','PARTICIPANT')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key(session_id,user_id)
);

insert into workspace_session_participants(session_id,user_id,role)
select id,actor_id,'OWNER'
  from agent_sessions
 where actor_id is not null
on conflict do nothing;

create index workspace_session_participants_user_idx
  on workspace_session_participants(user_id,session_id)
  where left_at is null;

create table workspace_claims (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references agent_sessions(id) on delete cascade,
  work_key text not null
    check (
      char_length(work_key) between 1 and 200
      and work_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    ),
  owner_id uuid not null references users(id),
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE','RELEASED','COMPLETED')),
  fencing_token bigint not null default 1 check (fencing_token > 0),
  lease_expires_at timestamptz not null,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(session_id,work_key)
);

create index workspace_claims_owner_lease_idx
  on workspace_claims(owner_id,lease_expires_at)
  where status='ACTIVE';

create table workspace_events (
  id bigserial primary key,
  session_id uuid not null references agent_sessions(id) on delete cascade,
  space_id uuid not null references spaces(id),
  vault_id uuid not null references vaults(id),
  actor_id uuid references users(id),
  claim_id uuid references workspace_claims(id) on delete set null,
  event_type text not null
    check (
      event_type in (
        'SESSION_CREATED',
        'PARTICIPANT_JOINED',
        'CLAIM_ACQUIRED',
        'CLAIM_HANDOFF',
        'FINDING',
        'BLOCKER',
        'QUESTION',
        'ARTIFACT',
        'DECISION_CANDIDATE',
        'NOTE'
      )
    ),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index workspace_events_session_idx
  on workspace_events(session_id,id);
