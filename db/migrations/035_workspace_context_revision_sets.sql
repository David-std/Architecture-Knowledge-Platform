-- Workspace context revision sets are immutable operational pinning state.
-- They reference existing revision authorities and never replace canonical knowledge.
create table workspace_context_revision_sets (
  session_id uuid primary key references agent_sessions(id) on delete cascade,
  space_id uuid not null,
  vault_id uuid not null,
  revision_set jsonb not null
    check (jsonb_typeof(revision_set) = 'object'),
  revision_set_hash text not null
    check (revision_set_hash ~ '^[a-f0-9]{64}$'),
  pinned_at timestamptz not null default now(),
  constraint workspace_context_revision_sets_vault_scope_fk
    foreign key(space_id,vault_id)
    references vaults(space_id,id)
);

create index workspace_context_revision_sets_vault_idx
  on workspace_context_revision_sets(space_id,vault_id,pinned_at desc);

create or replace function akp_guard_workspace_context_revision_set()
returns trigger
language plpgsql
as $function$
declare
  session_space uuid;
  session_vault uuid;
begin
  if tg_op = 'UPDATE' then
    raise exception 'WORKSPACE_CONTEXT_REVISION_SET_IMMUTABLE';
  end if;

  select space_id,vault_id
    into session_space,session_vault
    from agent_sessions
   where id=new.session_id;

  if session_space is null
     or session_vault is null
     or session_space <> new.space_id
     or session_vault <> new.vault_id then
    raise exception 'WORKSPACE_CONTEXT_SCOPE_MISMATCH';
  end if;
  return new;
end;
$function$;

create trigger workspace_context_revision_sets_guard
  before insert or update on workspace_context_revision_sets
  for each row execute function akp_guard_workspace_context_revision_set();
