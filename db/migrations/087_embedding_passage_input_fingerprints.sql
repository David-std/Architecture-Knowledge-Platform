-- Preserve canonical unit hashes while binding vectors to their actual input.
-- The optional contextual recipe is bounded and versioned. Existing body-only
-- generations retain their descriptors and query preprocessing.
create or replace function akp_embedding_passage_input_text(
  p_strategy text,p_title text,p_headings text[],p_body text
) returns text language sql immutable parallel safe as $function$
  select case when right(p_strategy,length('+title-heading-v1'))='+title-heading-v1'
    then 'Document: ' || left(coalesce(p_title,''),160) || E'\nSection: '
      || right(coalesce(array_to_string(p_headings,' > '),''),320) || E'\n\n' || p_body
    else p_body end;
$function$;

create or replace function akp_embedding_passage_input_hash(
  p_strategy text,p_title text,p_headings text[],p_body text
) returns text language sql immutable parallel safe as $function$
  select encode(digest(convert_to(akp_embedding_passage_input_text(
    p_strategy,p_title,p_headings,p_body),'UTF8'),'sha256'),'hex');
$function$;

alter table unit_embeddings add column input_hash text;
alter table unit_embeddings add constraint unit_embeddings_input_hash_shape
  check(input_hash is null or input_hash ~ '^[0-9a-f]{64}$');

-- Old, scope/content-matching rows were inferred from body alone. Rows whose
-- body snapshot is no longer available remain untrusted and cannot be reused.
alter table unit_embeddings disable trigger unit_embeddings_validate_update_statement;
update unit_embeddings e set input_hash=akp_embedding_passage_input_hash(
  g.input_strategy,d.title,u.heading_path,u.body)
  from embedding_generations g,knowledge_units u,knowledge_documents d
 where g.id=e.generation_id and u.id=e.unit_id and d.id=u.document_id
   and u.space_id=g.space_id and u.vault_id=g.vault_id
   and u.corpus_revision=g.corpus_revision and u.content_hash=e.content_hash;
alter table unit_embeddings enable trigger unit_embeddings_validate_update_statement;
create index unit_embeddings_input_hash_idx on unit_embeddings(input_hash)
  where input_hash is not null;

-- Compatibility for body-only writers. Contextual writers must supply the
-- exact input fingerprint; omission cannot pretend their vector saw metadata.
create or replace function akp_default_body_embedding_input_hash()
returns trigger language plpgsql as $function$
begin
  if new.input_hash is null then
    select akp_embedding_passage_input_hash(g.input_strategy,d.title,u.heading_path,u.body)
      into new.input_hash
      from embedding_generations g,knowledge_units u,knowledge_documents d
     where g.id=new.generation_id and u.id=new.unit_id and d.id=u.document_id
       and right(g.input_strategy,length('+title-heading-v1'))<>'+title-heading-v1';
  end if;
  return new;
end;
$function$;
create trigger unit_embeddings_default_input_hash
  before insert or update on unit_embeddings
  for each row execute function akp_default_body_embedding_input_hash();

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
        when n.input_hash is distinct from akp_embedding_passage_input_hash(g.input_strategy,d.title,u.heading_path,u.body)
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
        when n.input_hash is distinct from akp_embedding_passage_input_hash(g.input_strategy,d.title,u.heading_path,u.body) then 6
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

  return null;
end;
$function$;


create or replace function akp_embedding_generation_is_complete(
  p_generation_id uuid
)
returns boolean
language sql
stable
as $function$
  with target as (
    select id,space_id,vault_id,corpus_revision,dimensions,input_strategy
      from embedding_generations
     where id=p_generation_id
  ),
  eligible as (
    select u.id,u.content_hash,
           akp_embedding_passage_input_hash(t.input_strategy,d.title,u.heading_path,u.body) input_hash
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
           and u.input_hash=e.input_hash
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

