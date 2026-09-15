-- Enforce the normalization declared by a generation at the database
-- boundary as well as in provider/indexing code.  pgvector 0.8.2 exposes
-- vector_norm(vector) as a double-precision Euclidean norm; the same 1e-4
-- tolerance is used by the TypeScript lifecycle and provider guards.
create or replace function akp_validate_unit_embedding_l2()
returns trigger
language plpgsql
as $function$
declare
  generation_normalization text;
  norm double precision;
begin
  select g.normalization
    into generation_normalization
    from embedding_generations g
   where g.id=new.generation_id;

  if lower(btrim(coalesce(generation_normalization,'')))='l2' then
    norm := vector_norm(new.embedding);
    if norm is null or abs(norm - 1.0) > 1e-4 then
      raise exception 'EMBEDDING_NORMALIZATION_MISMATCH';
    end if;
  end if;
  return new;
end;
$function$;

drop trigger if exists unit_embeddings_validate_l2 on unit_embeddings;
create trigger unit_embeddings_validate_l2
before insert or update on unit_embeddings
for each row execute function akp_validate_unit_embedding_l2();
