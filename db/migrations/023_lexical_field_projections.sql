-- Field-aware lexical projections for the P3 retrieval path.
--
-- PostgreSQL's built-in `simple` configuration is deliberately used here. It
-- keeps tokenisation deterministic and domain-agnostic, while the stored
-- per-field vectors let the runtime apply an explicit, auditable weight to
-- identity, aliases, title, path, headings, unit metadata and body text.
-- `pg_trgm` is intentionally not enabled: exact lookups have B-tree indexes
-- and lexical matching works on every clean install without an optional
-- extension. A future trigram index, if justified by benchmark evidence,
-- must be introduced by a separate append-only migration.

-- `array_to_string(text[], text)` is marked STABLE by PostgreSQL because its
-- generic array implementation also supports types with session-sensitive
-- output. For text[] its result is a pure function of the values and
-- separator, so expose that narrow deterministic operation as an immutable
-- helper usable by generated columns.
create or replace function akp_lexical_array_text(items text[])
returns text
language sql
immutable
parallel safe
as $function$
  select coalesce(array_to_string(items, ' '), '')
$function$;

alter table knowledge_documents
  add column lexical_external_id_vector tsvector generated always as (
    to_tsvector('simple'::regconfig, coalesce(external_id, ''))
  ) stored,
  add column lexical_alias_vector tsvector generated always as (
    to_tsvector(
      'simple'::regconfig,
      akp_lexical_array_text(aliases)
    )
  ) stored,
  add column lexical_title_vector tsvector generated always as (
    to_tsvector('simple'::regconfig, coalesce(title, ''))
  ) stored,
  add column lexical_path_vector tsvector generated always as (
    to_tsvector(
      'simple'::regconfig,
      regexp_replace(coalesce(path, ''), '[^[:alnum:]]+', ' ', 'g')
    )
  ) stored,
  add column lexical_body_vector tsvector generated always as (
    to_tsvector('simple'::regconfig, coalesce(body_cache, ''))
  ) stored,
  add column lexical_search_vector tsvector generated always as (
    setweight(
      to_tsvector('simple'::regconfig, coalesce(external_id, '')),
      'A'
    ) ||
    setweight(
      to_tsvector(
        'simple'::regconfig,
        akp_lexical_array_text(aliases)
      ),
      'A'
    ) ||
    setweight(
      to_tsvector('simple'::regconfig, coalesce(title, '')),
      'B'
    ) ||
    setweight(
      to_tsvector(
        'simple'::regconfig,
        regexp_replace(coalesce(path, ''), '[^[:alnum:]]+', ' ', 'g')
      ),
      'C'
    ) ||
    setweight(
      to_tsvector('simple'::regconfig, coalesce(body_cache, '')),
      'D'
    )
  ) stored;

alter table knowledge_units
  add column lexical_heading_vector tsvector generated always as (
    to_tsvector(
      'simple'::regconfig,
      akp_lexical_array_text(heading_path)
    )
  ) stored,
  add column lexical_unit_vector tsvector generated always as (
    to_tsvector(
      'simple'::regconfig,
      coalesce(unit_key, '') || ' ' || coalesce(unit_type, '')
    )
  ) stored,
  add column lexical_body_vector tsvector generated always as (
    to_tsvector('simple'::regconfig, coalesce(body, ''))
  ) stored,
  add column lexical_search_vector tsvector generated always as (
    setweight(
      to_tsvector(
        'simple'::regconfig,
        akp_lexical_array_text(heading_path)
      ),
      'A'
    ) ||
    setweight(
      to_tsvector(
        'simple'::regconfig,
        coalesce(unit_key, '') || ' ' || coalesce(unit_type, '')
      ),
      'B'
    ) ||
    setweight(
      to_tsvector('simple'::regconfig, coalesce(body, '')),
      'C'
    )
  ) stored;

-- GIN supports the bounded FTS candidate scan. The existing legacy search
-- vectors remain intact for compatibility with older index revisions.
create index knowledge_documents_lexical_search_idx
  on knowledge_documents using gin(lexical_search_vector);
create index knowledge_documents_lexical_external_id_idx
  on knowledge_documents(space_id, vault_id, lower(external_id))
  where external_id is not null;
create index knowledge_documents_lexical_title_idx
  on knowledge_documents(space_id, vault_id, lower(title));
create index knowledge_documents_lexical_path_idx
  on knowledge_documents(space_id, vault_id, lower(path));
create index knowledge_documents_lexical_alias_idx
  on knowledge_documents using gin(aliases);

create index knowledge_units_lexical_search_idx
  on knowledge_units using gin(lexical_search_vector);
create index knowledge_units_lexical_heading_idx
  on knowledge_units using gin(lexical_heading_vector);
create index knowledge_units_lexical_unit_idx
  on knowledge_units(space_id, vault_id, lower(unit_key));

comment on column knowledge_documents.lexical_external_id_vector is
  'Stored simple-configuration lexical projection for external identity.';
comment on column knowledge_documents.lexical_alias_vector is
  'Stored simple-configuration lexical projection for aliases.';
comment on column knowledge_documents.lexical_title_vector is
  'Stored simple-configuration lexical projection for document title.';
comment on column knowledge_documents.lexical_path_vector is
  'Stored simple-configuration lexical projection for document path.';
comment on column knowledge_documents.lexical_body_vector is
  'Stored simple-configuration lexical projection for document body.';
comment on column knowledge_documents.lexical_search_vector is
  'Weighted lexical projection: identity/alias A, title B, path C, body D.';
comment on column knowledge_units.lexical_heading_vector is
  'Stored simple-configuration lexical projection for the heading path.';
comment on column knowledge_units.lexical_unit_vector is
  'Stored simple-configuration lexical projection for unit key and type.';
comment on column knowledge_units.lexical_body_vector is
  'Stored simple-configuration lexical projection for unit body.';
comment on column knowledge_units.lexical_search_vector is
  'Weighted lexical projection: heading A, unit metadata B, body C.';
