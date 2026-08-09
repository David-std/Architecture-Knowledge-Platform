-- API credentials are deliberately narrower than user memberships. A token may
-- only exercise the explicitly persisted permission/path tuples below; current
-- memberships are still intersected at request time by the API.
alter table api_tokens
  add column if not exists scopes jsonb not null
    default '{"spaces":[]}'::jsonb;

-- Backfill pre-scope local credentials as an explicit snapshot of their then
-- current memberships. New provisioning always writes scopes explicitly.
update api_tokens t
   set scopes = jsonb_build_object(
     'spaces',
     coalesce(
       (
         select jsonb_agg(
           jsonb_build_object(
             'spaceId', m.space_id::text,
             'pathPrefix', m.path_prefix,
             'permissions',
             case m.role
               when 'VIEWER' then '["knowledge:read","source:read"]'::jsonb
               when 'CONTRIBUTOR' then '["knowledge:read","source:read","source:write","knowledge:propose"]'::jsonb
               when 'CURATOR' then '["knowledge:read","source:read","source:write","knowledge:propose"]'::jsonb
               when 'REVIEWER' then '["knowledge:read","source:read","knowledge:review"]'::jsonb
               when 'ARCHITECT' then '["knowledge:read","source:read","source:write","knowledge:propose","knowledge:review","eval:run"]'::jsonb
               when 'ADMIN' then '["knowledge:read","source:read","source:write","knowledge:propose","knowledge:review","eval:run","admin"]'::jsonb
               when 'SERVICE_ACCOUNT' then '["knowledge:read","source:read","source:write"]'::jsonb
               else '[]'::jsonb
             end
           )
         )
         from memberships m where m.user_id=t.user_id
       ),
       '[]'::jsonb
     )
   )
 where t.scopes = '{"spaces":[]}'::jsonb;

alter table idempotency_records
  alter column response drop not null;

alter table idempotency_records
  add column if not exists state text not null default 'COMPLETED',
  add column if not exists lease_owner text,
  add column if not exists lease_expires_at timestamptz;

alter table idempotency_records
  drop constraint if exists idempotency_records_state_check;

alter table idempotency_records
  add constraint idempotency_records_state_check
  check (state in ('IN_PROGRESS','COMPLETED','ABANDONED'));

create index if not exists idempotency_records_claim_idx
  on idempotency_records(state, lease_expires_at);
