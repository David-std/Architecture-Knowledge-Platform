create table knowledge_units (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references knowledge_documents(id) on delete cascade,
  space_id uuid not null references spaces(id),
  unit_key text not null,
  unit_type text not null check (
    unit_type in (
      'DOCUMENT','SECTION','RULE','WORKFLOW_STEP','EXAMPLE',
      'COUNTEREXAMPLE','EVIDENCE','SOURCE_EXCERPT','CODE_EVIDENCE'
    )
  ),
  heading_path text[] not null default '{}',
  body text not null,
  content_hash text not null,
  corpus_revision text not null,
  lifecycle text not null,
  trust_tier text not null,
  source_ids text[] not null default '{}',
  token_estimate integer not null default 0,
  search_vector tsvector generated always as (
    to_tsvector('simple'::regconfig, body)
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_id, unit_key, corpus_revision)
);

create index knowledge_units_search_idx on knowledge_units using gin(search_vector);
create index knowledge_units_document_idx on knowledge_units(document_id);

create table embedding_generations (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id),
  provider text not null,
  model text not null,
  model_revision text not null,
  dimensions integer not null,
  normalization text not null,
  configuration_version text not null,
  corpus_revision text not null,
  status text not null check (status in ('BUILDING','READY','ACTIVE','STALE','FAILED')),
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  unique (
    space_id, provider, model, model_revision, configuration_version, corpus_revision
  )
);

create table unit_embeddings (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references knowledge_units(id) on delete cascade,
  generation_id uuid not null references embedding_generations(id) on delete cascade,
  content_hash text not null,
  embedding vector(64) not null,
  created_at timestamptz not null default now(),
  unique (unit_id, generation_id)
);

create index unit_embeddings_vector_idx
  on unit_embeddings using hnsw (embedding vector_cosine_ops);

create table index_revisions (
  space_id uuid primary key references spaces(id),
  corpus_revision text not null,
  lexical_revision text,
  vector_revision text,
  graph_revision text,
  context_pack_revision text,
  retrieval_configuration_version text not null default 'rrf-v1',
  status text not null default 'DEGRADED',
  warnings jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table knowledge_documents
  add column last_verified_at timestamptz,
  add column verified_against_revision text,
  add column freshness_policy text not null default 'REVIEW_ON_CHANGE',
  add column stale_after timestamptz,
  add column invalidated_by uuid references knowledge_documents(id),
  add column stale_reason text,
  add column refresh_status text not null default 'CURRENT',
  add column owner_id uuid references users(id);

create index knowledge_documents_refresh_idx
  on knowledge_documents(space_id, refresh_status, lifecycle);

create table contradiction_clusters (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id),
  topic text not null,
  status text not null default 'OPEN',
  resolution text,
  reviewer_id uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table contradiction_members (
  cluster_id uuid not null references contradiction_clusters(id) on delete cascade,
  document_id uuid not null references knowledge_documents(id) on delete cascade,
  authority text,
  scope text,
  primary key (cluster_id, document_id)
);

create table document_leases (
  document_id uuid primary key references knowledge_documents(id) on delete cascade,
  holder_id uuid references users(id),
  review_id uuid references reviews(id) on delete cascade,
  base_revision text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table knowledge_lint_runs (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id),
  trigger text not null,
  corpus_revision text not null,
  status text not null,
  findings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table error_book (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id),
  error_type text not null check (
    error_type in (
      'SOURCE_MISSED','FACT_DROPPED','WRONG_IDENTITY','DUPLICATE_PAGE',
      'STALE_CLAIM','BROKEN_PROVENANCE','BAD_CONTEXT_PACKET','RETRIEVAL_FAILURE',
      'INDEX_REVISION_MISMATCH','PROMPT_INJECTION','REVIEW_ESCAPE','RESTORE_FAILURE'
    )
  ),
  status text not null default 'OPEN',
  root_cause text,
  correction text,
  regression_reference text,
  verification_result text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table publication_locks (
  space_id uuid primary key references spaces(id),
  owner text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table idempotency_records (
  actor_id uuid not null references users(id),
  operation text not null,
  idempotency_key text not null,
  resource_id text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor_id, operation, idempotency_key)
);
