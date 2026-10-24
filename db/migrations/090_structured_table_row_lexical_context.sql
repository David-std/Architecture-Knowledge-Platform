-- Experimental structured lexical context for source-bound TABLE_ROW units.
--
-- Canonical unit body/source spans stay unchanged. The additional context is
-- a deterministic projection used only when retrieval explicitly opts in.

alter table knowledge_units
  add column lexical_context text not null default '',
  add column lexical_context_vector tsvector generated always as (
    to_tsvector('simple'::regconfig, coalesce(lexical_context, ''))
  ) stored,
  add column lexical_augmented_search_vector tsvector generated always as (
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
    ) ||
    setweight(
      to_tsvector('simple'::regconfig, coalesce(lexical_context, '')),
      'C'
    )
  ) stored;

create index knowledge_units_lexical_augmented_search_idx
  on knowledge_units using gin(lexical_augmented_search_vector);

comment on column knowledge_units.lexical_context is
  'Deterministic source-bound lexical context separate from canonical unit body.';
comment on column knowledge_units.lexical_context_vector is
  'Stored simple-configuration lexical projection for optional unit context.';
comment on column knowledge_units.lexical_augmented_search_vector is
  'Weighted lexical projection including optional structured unit context.';
