-- Consolidate unit embedding validation into one row-level trigger.
-- The prior split triggers queried embedding_generations twice and
-- knowledge_units once for every inserted vector. Preserve all validation
-- semantics while using one indexed LEFT JOIN on the successful path.
create or replace function akp_validate_unit_embedding()
returns trigger
language plpgsql
as $function$
declare
  validation_record record;
  norm double precision;
begin
  select
    g.id as generation_id,
    g.space_id as generation_space_id,
    g.vault_id as generation_vault_id,
    g.corpus_revision as generation_corpus_revision,
    g.dimensions as generation_dimensions,
    g.status as generation_status,
    g.normalization as generation_normalization,
    u.id as unit_id,
    u.space_id as unit_space_id,
    u.vault_id as unit_vault_id,
    u.corpus_revision as unit_corpus_revision,
    u.content_hash as unit_content_hash,
    u.embedding_eligible as unit_embedding_eligible
    into validation_record
    from embedding_generations g
    left join knowledge_units u on u.id=new.unit_id
   where g.id=new.generation_id;

  if not found then
    raise exception 'EMBEDDING_GENERATION_NOT_FOUND';
  end if;

  if validation_record.generation_status <> 'BUILDING' then
    raise exception 'GENERATION_NOT_BUILDING';
  end if;

  if validation_record.unit_id is null then
    raise exception 'KNOWLEDGE_UNIT_NOT_FOUND';
  end if;

  if validation_record.unit_space_id is distinct from validation_record.generation_space_id
     or validation_record.unit_vault_id is distinct from validation_record.generation_vault_id
     or validation_record.unit_corpus_revision is distinct from validation_record.generation_corpus_revision then
    raise exception 'EMBEDDING_SCOPE_MISMATCH';
  end if;

  if new.content_hash is distinct from validation_record.unit_content_hash then
    raise exception 'EMBEDDING_CONTENT_HASH_MISMATCH';
  end if;

  if validation_record.unit_embedding_eligible is not true then
    raise exception 'EMBEDDING_UNIT_NOT_ELIGIBLE';
  end if;

  if new.embedding_dimensions is distinct from validation_record.generation_dimensions
     or vector_dims(new.embedding) is distinct from validation_record.generation_dimensions then
    raise exception 'EMBEDDING_DIMENSION_MISMATCH';
  end if;

  if lower(btrim(coalesce(validation_record.generation_normalization,'')))='l2' then
    norm := vector_norm(new.embedding);
    if norm is null or abs(norm - 1.0) > 1e-4 then
      raise exception 'EMBEDDING_NORMALIZATION_MISMATCH';
    end if;
  end if;

  return new;
end;
$function$;

drop trigger if exists unit_embeddings_validate_l2 on unit_embeddings;
drop function if exists akp_validate_unit_embedding_l2();
