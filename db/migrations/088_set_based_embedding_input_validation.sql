-- Keep input fingerprint validation set-based for bulk rebuilds. Body-only
-- legacy writes omit the new field; contextual writers must still supply it.
drop trigger unit_embeddings_default_input_hash on unit_embeddings;
drop function akp_default_body_embedding_input_hash();

create or replace function akp_validate_unit_embedding_statement()
returns trigger
language plpgsql
as $function$
declare
  violation text;
begin
  with checked as (
    select
      n.id,
      case
        when g.id is null then 'EMBEDDING_GENERATION_NOT_FOUND'
        when g.status <> 'BUILDING' then 'GENERATION_NOT_BUILDING'
        when u.id is null then 'KNOWLEDGE_UNIT_NOT_FOUND'
        when u.space_id is distinct from g.space_id
          or u.vault_id is distinct from g.vault_id
          or u.corpus_revision is distinct from g.corpus_revision
          then 'EMBEDDING_SCOPE_MISMATCH'
        when n.content_hash is distinct from u.content_hash
          then 'EMBEDDING_CONTENT_HASH_MISMATCH'
        when (n.input_hash is not null and n.input_hash is distinct from akp_embedding_passage_input_hash(g.input_strategy,d.title,u.heading_path,u.body)) or (n.input_hash is null and right(g.input_strategy,length('+title-heading-v1'))='+title-heading-v1')
          then 'EMBEDDING_INPUT_HASH_MISMATCH'
        when u.embedding_eligible is not true
          then 'EMBEDDING_UNIT_NOT_ELIGIBLE'
        when n.embedding_dimensions is distinct from g.dimensions
          or vector_dims(n.embedding) is distinct from g.dimensions
          then 'EMBEDDING_DIMENSION_MISMATCH'
        when lower(btrim(coalesce(g.normalization,''))) = 'l2'
          and (vector_norm(n.embedding) is null
            or abs(vector_norm(n.embedding) - 1.0) > 1e-4)
          then 'EMBEDDING_NORMALIZATION_MISMATCH'
        else null
      end as violation,
      case
        when g.id is null then 1
        when g.status <> 'BUILDING' then 2
        when u.id is null then 3
        when u.space_id is distinct from g.space_id
          or u.vault_id is distinct from g.vault_id
          or u.corpus_revision is distinct from g.corpus_revision
          then 4
        when n.content_hash is distinct from u.content_hash then 5
        when (n.input_hash is not null and n.input_hash is distinct from akp_embedding_passage_input_hash(g.input_strategy,d.title,u.heading_path,u.body)) or (n.input_hash is null and right(g.input_strategy,length('+title-heading-v1'))='+title-heading-v1') then 6
        when u.embedding_eligible is not true then 7
        when n.embedding_dimensions is distinct from g.dimensions
          or vector_dims(n.embedding) is distinct from g.dimensions
          then 8
        when lower(btrim(coalesce(g.normalization,''))) = 'l2'
          and (vector_norm(n.embedding) is null
            or abs(vector_norm(n.embedding) - 1.0) > 1e-4)
          then 9
        else 99
      end as priority
    from new_unit_embeddings n
    left join embedding_generations g on g.id=n.generation_id
    left join knowledge_units u on u.id=n.unit_id
    left join knowledge_documents d on d.id=u.document_id
  )
  select checked.violation
    into violation
    from checked
   where checked.violation is not null
   order by checked.priority,checked.id
   limit 1;

  if violation is not null then
    raise exception '%', violation;
  end if;

  -- A single set-based compatibility write avoids per-vector metadata lookups.
  -- Its UPDATE trigger sees non-null fingerprints and does not recurse further.
  if exists(select 1 from new_unit_embeddings where input_hash is null) then
    update unit_embeddings e
       set input_hash=akp_embedding_passage_input_hash(g.input_strategy,d.title,u.heading_path,u.body)
      from new_unit_embeddings n
      join embedding_generations g on g.id=n.generation_id
      join knowledge_units u on u.id=n.unit_id
      join knowledge_documents d on d.id=u.document_id
     where e.id=n.id and e.input_hash is null;
  end if;
  return null;
end;
$function$;


