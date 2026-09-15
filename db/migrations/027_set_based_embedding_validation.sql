-- Validate unit_embeddings as a set per statement rather than issuing SQL
-- lookups once per row. The application writer still validates generation
-- state, dimensions and L2 before each production write; this database guard
-- remains the fail-closed cross-scope/content/eligibility boundary for direct
-- SQL and bulk rebuilds.
--
-- Foreign keys are deferred so the statement-level validator can preserve the
-- domain-specific missing-reference errors before PostgreSQL performs the
-- equivalent FK check at transaction commit.
alter table unit_embeddings
  alter constraint unit_embeddings_unit_id_fkey deferrable initially deferred;

alter table unit_embeddings
  alter constraint unit_embeddings_generation_id_fkey deferrable initially deferred;

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
        when u.embedding_eligible is not true then 6
        when n.embedding_dimensions is distinct from g.dimensions
          or vector_dims(n.embedding) is distinct from g.dimensions
          then 7
        when lower(btrim(coalesce(g.normalization,''))) = 'l2'
          and (vector_norm(n.embedding) is null
            or abs(vector_norm(n.embedding) - 1.0) > 1e-4)
          then 8
        else 99
      end as priority
    from new_unit_embeddings n
    left join embedding_generations g on g.id=n.generation_id
    left join knowledge_units u on u.id=n.unit_id
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

drop trigger if exists unit_embeddings_validate_scope on unit_embeddings;
drop trigger if exists unit_embeddings_validate_l2 on unit_embeddings;

create trigger unit_embeddings_validate_insert_statement
  after insert on unit_embeddings
  referencing new table as new_unit_embeddings
  for each statement execute function akp_validate_unit_embedding_statement();

create trigger unit_embeddings_validate_update_statement
  after update on unit_embeddings
  referencing new table as new_unit_embeddings
  for each statement execute function akp_validate_unit_embedding_statement();
