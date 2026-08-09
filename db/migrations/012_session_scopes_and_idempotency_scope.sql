-- A browser session is a bearer credential derived from an API token. Persist
-- the token's already-effective scope so session use cannot expand to every
-- membership owned by the same user. Empty legacy sessions are revoked: their
-- prior privilege cannot be reconstructed safely after this migration.
alter table web_sessions
  add column if not exists scopes jsonb not null
    default '{"spaces":[]}'::jsonb;

update web_sessions
   set revoked_at=coalesce(revoked_at, now())
 where revoked_at is null
   and scopes='{"spaces":[]}'::jsonb;

-- Idempotency is partitioned by the concrete credential plus its effective
-- authorization snapshot. Replays must never cross API tokens, web sessions,
-- or changed memberships for the same user.
alter table idempotency_records
  add column if not exists credential_fingerprint text not null default 'legacy';

alter table idempotency_records
  drop constraint if exists idempotency_records_pkey;

alter table idempotency_records
  add primary key(actor_id, credential_fingerprint, operation, idempotency_key);

create index if not exists idempotency_records_scope_lookup_idx
  on idempotency_records(actor_id, credential_fingerprint, operation, idempotency_key);
