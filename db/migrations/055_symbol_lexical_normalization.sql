-- Symbol-aware lexical projections for P6.4.
--
-- Preserve the existing exact/simple-FTS channels and add a deterministic
-- projection that exposes human word boundaries hidden inside code/project
-- identifiers. The source value remains unchanged; this is rebuildable derived
-- state only.

create or replace function akp_lexical_symbol_text(value text)
returns text
language sql
immutable
parallel safe
as $function$
  select btrim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          coalesce(value, ''),
          '([[:upper:]])([[:upper:]][[:lower:]])',
          '\1 \2',
          'g'
        ),
        '([[:lower:][:digit:]])([[:upper:]])',
        '\1 \2',
        'g'
      ),
      '[^[:alnum:]]+',
      ' ',
      'g'
    )
  )
$function$;

alter table knowledge_documents
  add column lexical_symbol_vector tsvector generated always as (
    setweight(
      to_tsvector(
        'simple'::regconfig,
        akp_lexical_symbol_text(coalesce(external_id, ''))
      ),
      'A'
    ) ||
    setweight(
      to_tsvector(
        'simple'::regconfig,
        akp_lexical_symbol_text(akp_lexical_array_text(aliases))
      ),
      'A'
    ) ||
    setweight(
      to_tsvector(
        'simple'::regconfig,
        akp_lexical_symbol_text(coalesce(title, ''))
      ),
      'B'
    ) ||
    setweight(
      to_tsvector(
        'simple'::regconfig,
        akp_lexical_symbol_text(coalesce(path, ''))
      ),
      'B'
    ) ||
    setweight(
      to_tsvector(
        'simple'::regconfig,
        akp_lexical_symbol_text(coalesce(body_cache, ''))
      ),
      'D'
    )
  ) stored;

alter table knowledge_units
  add column lexical_symbol_vector tsvector generated always as (
    setweight(
      to_tsvector(
        'simple'::regconfig,
        akp_lexical_symbol_text(akp_lexical_array_text(heading_path))
      ),
      'A'
    ) ||
    setweight(
      to_tsvector(
        'simple'::regconfig,
        akp_lexical_symbol_text(
          coalesce(unit_key, '') || ' ' || coalesce(unit_type, '')
        )
      ),
      'B'
    ) ||
    setweight(
      to_tsvector(
        'simple'::regconfig,
        akp_lexical_symbol_text(coalesce(body, ''))
      ),
      'D'
    )
  ) stored;

create index knowledge_documents_lexical_symbol_idx
  on knowledge_documents using gin(lexical_symbol_vector);

create index knowledge_units_lexical_symbol_idx
  on knowledge_units using gin(lexical_symbol_vector);

comment on function akp_lexical_symbol_text(text) is
  'Immutable lexical normalization for camelCase, PascalCase, snake/kebab names, qualified names and paths.';

comment on column knowledge_documents.lexical_symbol_vector is
  'Rebuildable symbol-aware lexical projection; canonical source text remains unchanged.';

comment on column knowledge_units.lexical_symbol_vector is
  'Rebuildable symbol-aware unit projection for headings, keys, types and body symbols.';
