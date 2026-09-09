-- A generation may be READY or ACTIVE only when its derived vectors exactly
-- cover the current eligible unit snapshot. Keeping this invariant in the
-- database prevents direct SQL updates and activation races from selecting a
-- partial index, and makes deleted derived rows repairable rather than
-- silently trusted.

create or replace function akp_embedding_generation_is_complete(
  p_generation_id uuid
)
returns boolean
language sql
stable
as $function$
  with target as (
    select id,space_id,vault_id,corpus_revision,dimensions
      from embedding_generations
     where id=p_generation_id
  ),
  eligible as (
    select u.id,u.content_hash
      from target t
      join knowledge_units u
        on u.space_id=t.space_id
       and u.vault_id=t.vault_id
       and u.corpus_revision=t.corpus_revision
      join knowledge_documents d on d.id=u.document_id
     where u.embedding_eligible=true
       and u.lifecycle in ('ACTIVE','DISPUTED')
       and d.lifecycle in ('ACTIVE','DISPUTED')
       and d.refresh_status not in ('STALE_BLOCKED','INVALID')
  ),
  counts as (
    select
      (select count(*) from target) target_count,
      (select count(*) from eligible) expected,
      (
        select count(*)
          from target t
          join unit_embeddings e on e.generation_id=t.id
          join eligible u
            on u.id=e.unit_id and u.content_hash=e.content_hash
         where e.embedding_dimensions=t.dimensions
      ) matching,
      (
        select count(*)
          from target t
          join unit_embeddings e on e.generation_id=t.id
      ) stored
  )
  select coalesce(
    target_count=1 and expected=matching and expected=stored,
    false
  )
    from counts;
$function$;

create or replace function akp_validate_embedding_generation_update()
returns trigger
language plpgsql
as $function$
begin
  if new.space_id is distinct from old.space_id
     or new.vault_id is distinct from old.vault_id
     or new.corpus_revision is distinct from old.corpus_revision
     or new.provider is distinct from old.provider
     or new.model is distinct from old.model
     or new.model_revision is distinct from old.model_revision
     or new.dimensions is distinct from old.dimensions
     or new.normalization is distinct from old.normalization
     or new.input_strategy is distinct from old.input_strategy
     or new.configuration_version is distinct from old.configuration_version
     or new.runtime is distinct from old.runtime
     or new.configuration_hash is distinct from old.configuration_hash then
    raise exception 'EMBEDDING_GENERATION_DESCRIPTOR_IMMUTABLE';
  end if;

  if new.status is distinct from old.status
     and not (
       (old.status='REQUESTED' and new.status in ('BUILDING','FAILED','STALE'))
       or (old.status='BUILDING' and new.status in ('READY','FAILED','STALE'))
       or (old.status='READY' and new.status in ('ACTIVE','RETIRED','STALE'))
       or (old.status='ACTIVE' and new.status in ('RETIRED','STALE'))
       or (old.status='RETIRED' and new.status in ('ACTIVE','BUILDING'))
       or (old.status in ('FAILED','STALE') and new.status in ('BUILDING','RETIRED'))
     ) then
    raise exception 'INVALID_EMBEDDING_GENERATION_TRANSITION';
  end if;

  if new.status='ACTIVE' and old.status not in ('READY','RETIRED') then
    raise exception 'EMBEDDING_GENERATION_NOT_READY';
  end if;
  if new.status in ('READY','ACTIVE')
     and not akp_embedding_generation_is_complete(old.id) then
    raise exception 'EMBEDDING_GENERATION_INCOMPLETE';
  end if;
  if new.status='ACTIVE' then
    new.activated_at=coalesce(new.activated_at,now());
    new.retired_at=null;
  elsif old.status='ACTIVE' and new.status in ('RETIRED','STALE') then
    new.retired_at=coalesce(new.retired_at,now());
  end if;
  if new.status='BUILDING' then
    new.failure_reason=null;
  end if;
  new.updated_at=now();
  return new;
end;
$function$;

create or replace function akp_activate_embedding_generation(p_generation_id uuid)
returns setof embedding_generations
language plpgsql
as $function$
declare
  target embedding_generations;
begin
  select * into target
    from embedding_generations
   where id=p_generation_id
   for update;
  if not found then
    raise exception 'EMBEDDING_GENERATION_NOT_FOUND';
  end if;
  if target.vault_id is null then
    raise exception 'VAULT_SCOPE_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target.vault_id::text,0));
  select * into target
    from embedding_generations
   where id=p_generation_id
   for update;
  if target.status='ACTIVE' then
    if not akp_embedding_generation_is_complete(target.id) then
      raise exception 'EMBEDDING_GENERATION_INCOMPLETE';
    end if;
    return query select * from embedding_generations where id=target.id;
    return;
  end if;
  if target.status not in ('READY','RETIRED') then
    raise exception 'EMBEDDING_GENERATION_NOT_READY';
  end if;
  if not akp_embedding_generation_is_complete(target.id) then
    raise exception 'EMBEDDING_GENERATION_INCOMPLETE';
  end if;

  update embedding_generations
     set status='RETIRED',retired_at=coalesce(retired_at,now()),updated_at=now()
   where space_id=target.space_id
     and vault_id=target.vault_id
     and status='ACTIVE'
     and id<>target.id;

  update embedding_generations
     set status='ACTIVE',activated_at=coalesce(activated_at,now()),
         retired_at=null,updated_at=now()
   where id=target.id;

  return query
  select * from embedding_generations where id=target.id;
end;
$function$;
