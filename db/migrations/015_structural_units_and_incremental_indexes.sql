alter table knowledge_units
  drop constraint if exists knowledge_units_unit_type_check;

alter table knowledge_units
  add constraint knowledge_units_unit_type_check check (
    unit_type in (
      'DOCUMENT','SECTION','PARAGRAPH','LIST','TABLE','FIGURE','EQUATION',
      'PRECONDITION','RULE','WORKFLOW_STEP','EXAMPLE','COUNTEREXAMPLE',
      'EVIDENCE','SOURCE_EXCERPT','CODE_EVIDENCE'
    )
  ),
  add column parent_unit_id uuid references knowledge_units(id) on delete cascade,
  add column document_revision text,
  add column permissions jsonb not null default '{}'::jsonb,
  add column locator jsonb not null default '{}'::jsonb,
  add column artifact_id uuid references source_artifacts(id) on delete set null,
  add column structural_order integer not null default 0,
  add column container_only boolean not null default false,
  add column embedding_eligible boolean not null default true;

-- Embedding generations are rebuilt independently per vault. The legacy
-- space-only signature would make two vaults with the same corpus revision
-- share a generation and leak derived vectors across boundaries.
alter table embedding_generations
  drop constraint if exists embedding_generations_space_id_provider_model_model_revision_configuration_version_corpus_revision_key;
create unique index embedding_generations_vault_signature_idx
  on embedding_generations(
    vault_id,provider,model,model_revision,configuration_version,corpus_revision
  );

update knowledge_units
   set document_revision=corpus_revision,
       container_only=(unit_type in ('DOCUMENT','SECTION')),
       embedding_eligible=(unit_type not in ('DOCUMENT','SECTION'))
 where document_revision is null;

alter table knowledge_units alter column document_revision set not null;

create index knowledge_units_parent_idx on knowledge_units(parent_unit_id,structural_order);
create index knowledge_units_structural_idx
  on knowledge_units(vault_id,document_id,document_revision,structural_order);
create index knowledge_units_embedding_eligible_idx
  on knowledge_units(vault_id,embedding_eligible,content_hash)
  where embedding_eligible=true;

alter table error_book drop constraint if exists error_book_error_type_check;
alter table error_book add constraint error_book_error_type_check check (
  error_type in (
    'SOURCE_MISSED','FACT_DROPPED','WRONG_IDENTITY','DUPLICATE_PAGE',
    'STALE_CLAIM','BROKEN_PROVENANCE','BAD_CONTEXT_PACKET','RETRIEVAL_FAILURE',
    'INDEX_REVISION_MISMATCH','PROMPT_INJECTION','REVIEW_ESCAPE',
    'EXTRACTOR_FAILURE','TABLE_PARSE_FAILURE','RESTORE_FAILURE',
    'GENERICITY_LEAK','REPOSITORY_HYGIENE_FAILURE'
  )
);

create table incremental_index_runs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references event_outbox(event_id),
  space_id uuid not null references spaces(id),
  vault_id uuid not null references vaults(id),
  corpus_revision text not null,
  changed_paths text[] not null default '{}',
  tombstoned_paths text[] not null default '{}',
  documents_rebuilt integer not null default 0,
  units_rebuilt integer not null default 0,
  embeddings_reused integer not null default 0,
  embeddings_created integer not null default 0,
  status text not null check (status in ('RUNNING','COMPLETED','FAILED')),
  error text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index incremental_index_runs_vault_idx
  on incremental_index_runs(vault_id,started_at desc);

-- A redelivered CorpusRevisionPublished event must resume the same durable
-- incremental run rather than create an indistinguishable duplicate.
create unique index incremental_index_runs_event_idx
  on incremental_index_runs(event_id)
  where event_id is not null;
