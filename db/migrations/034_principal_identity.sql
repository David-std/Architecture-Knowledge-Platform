-- P2 first-class principal identity. User identity remains the compatibility
-- anchor for existing RBAC; scoped process credentials add a distinct audit and
-- policy identity without granting broader authority than the parent user.
create table principals (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (
    kind in ('HUMAN','AGENT_PROCESS','SERVICE_ACCOUNT','CONNECTOR','MAINTENANCE_JOB')
  ),
  user_id uuid references users(id) on delete cascade,
  parent_principal_id uuid references principals(id) on delete cascade,
  session_id uuid references agent_sessions(id) on delete cascade,
  vault_id uuid references vaults(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 200),
  allowed_actions text[] not null default '{}',
  policy_revision bigint not null default 1 check (policy_revision >= 1),
  state text not null default 'ACTIVE' check (state in ('ACTIVE','REVOKED')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (
    (kind='HUMAN' and user_id is not null and parent_principal_id is null and session_id is null and vault_id is null)
    or
    (kind='AGENT_PROCESS' and user_id is not null and parent_principal_id is not null and session_id is not null and vault_id is not null)
    or
    kind in ('SERVICE_ACCOUNT','CONNECTOR','MAINTENANCE_JOB')
  )
);

create unique index principals_human_user_idx
  on principals(user_id)
  where kind='HUMAN';
create index principals_parent_idx on principals(parent_principal_id,state);
create index principals_session_idx on principals(session_id,state);
create index principals_vault_idx on principals(vault_id,state);

insert into principals(kind,user_id,display_name,allowed_actions)
select 'HUMAN',id,display_name,array['*']::text[]
  from users
on conflict do nothing;

create or replace function ensure_human_principal_for_user()
returns trigger language plpgsql as $$
begin
  insert into principals(kind,user_id,display_name,allowed_actions)
  values('HUMAN',new.id,new.display_name,array['*']::text[])
  on conflict do nothing;
  return new;
end;
$$;

create trigger users_create_human_principal
  after insert on users
  for each row execute function ensure_human_principal_for_user();

create table principal_credentials (
  id uuid primary key default gen_random_uuid(),
  principal_id uuid not null references principals(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  label text not null check (char_length(label) between 1 and 200),
  scopes jsonb not null default '{"spaces":[]}'::jsonb,
  allowed_actions text[] not null default '{}',
  policy_revision bigint not null check (policy_revision >= 1),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index principal_credentials_principal_idx
  on principal_credentials(principal_id,revoked_at,expires_at);

alter table audit_events
  add column principal_id uuid references principals(id) on delete set null;
update audit_events target
   set principal_id=principal.id
  from principals principal
 where principal.kind='HUMAN'
   and principal.user_id=target.actor_id
   and target.principal_id is null;
create index audit_events_principal_idx
  on audit_events(principal_id,created_at desc);


-- Process scope is immutable after issuance. Revocation may change only the
-- lifecycle/policy fence; it cannot retarget the parent, workspace, vault or
-- allowed action set in place.
create or replace function akp_guard_principal_scope_identity()
returns trigger language plpgsql as $$
begin
  if row(
    new.kind,new.user_id,new.parent_principal_id,new.session_id,new.vault_id,
    new.display_name,new.allowed_actions,new.created_at
  ) is distinct from row(
    old.kind,old.user_id,old.parent_principal_id,old.session_id,old.vault_id,
    old.display_name,old.allowed_actions,old.created_at
  ) then
    raise exception 'PRINCIPAL_SCOPE_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger principals_guard_scope_identity
  before update on principals
  for each row execute function akp_guard_principal_scope_identity();

create or replace function akp_guard_principal_credential_scope()
returns trigger language plpgsql as $$
begin
  if row(
    new.principal_id,new.user_id,new.token_hash,new.label,new.scopes,
    new.allowed_actions,new.policy_revision,new.expires_at,new.created_at
  ) is distinct from row(
    old.principal_id,old.user_id,old.token_hash,old.label,old.scopes,
    old.allowed_actions,old.policy_revision,old.expires_at,old.created_at
  ) then
    raise exception 'PRINCIPAL_CREDENTIAL_SCOPE_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger principal_credentials_guard_scope
  before update on principal_credentials
  for each row execute function akp_guard_principal_credential_scope();
