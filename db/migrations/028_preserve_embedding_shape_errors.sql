-- Preserve the domain error for malformed embedding shapes before
-- PostgreSQL CHECK constraints or dimension-specific vector indexes
-- can surface storage-level errors. This trigger performs no table
-- lookup; generation, scope, content, eligibility, and normalization
-- validation remains set-based in the statement-level validator.
create or replace function akp_validate_unit_embedding_shape()
returns trigger
language plpgsql
as $function$
begin
  if new.embedding_dimensions < 1
     or new.embedding_dimensions > 2000
     or vector_dims(new.embedding) is distinct from new.embedding_dimensions then
    raise exception 'EMBEDDING_DIMENSION_MISMATCH';
  end if;
  return new;
end;
$function$;

drop trigger if exists unit_embeddings_validate_shape on unit_embeddings;
create trigger unit_embeddings_validate_shape
  before insert or update on unit_embeddings
  for each row execute function akp_validate_unit_embedding_shape();
