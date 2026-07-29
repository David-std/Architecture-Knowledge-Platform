create extension if not exists vector;
create extension if not exists pgcrypto;

create table organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text not null,
  password_hash text,
  created_at timestamptz not null default now()
);

create table spaces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  slug text not null,
  name text not null,
  visibility text not null check (visibility in ('PRIVATE', 'TEAM', 'CENTRAL')),
  knowledge_repo_path text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, slug)
);

create table memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  space_id uuid not null references spaces(id),
  role text not null check (role in ('VIEWER', 'CONTRIBUTOR', 'CURATOR', 'REVIEWER', 'ARCHITECT', 'ADMIN', 'SERVICE_ACCOUNT')),
  path_prefix text,
  unique nulls not distinct (user_id, space_id, role, path_prefix)
);

create table sources (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id),
  title text,
  source_uri text not null,
  media_type text,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  byte_size bigint not null,
  object_key text not null,
  status text not null default 'ACTIVE',
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (space_id, sha256)
);

create table source_artifacts (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references sources(id),
  kind text not null,
  object_key text not null,
  source_hash text not null,
  extractor text not null,
  extractor_version text not null,
  quality text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id),
  path text not null,
  title text not null,
  type text not null,
  lifecycle text not null,
  trust_tier text not null,
  current_revision text not null,
  body_cache text not null,
  frontmatter jsonb not null,
  search_vector tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(body_cache, '')), 'B')
  ) stored,
  updated_at timestamptz not null default now(),
  unique (space_id, path)
);

create index knowledge_documents_search_idx
  on knowledge_documents using gin(search_vector);

create table knowledge_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references knowledge_documents(id),
  git_commit text not null,
  content_hash text not null,
  body text not null,
  frontmatter jsonb not null,
  created_at timestamptz not null default now(),
  unique (document_id, git_commit)
);

create table knowledge_relations (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id),
  from_document_id uuid not null references knowledge_documents(id),
  to_document_id uuid not null references knowledge_documents(id),
  relation_type text not null,
  weight real not null default 1,
  provenance text not null,
  metadata jsonb not null default '{}'::jsonb,
  unique (from_document_id, to_document_id, relation_type, provenance)
);

create index knowledge_relations_from_idx on knowledge_relations(from_document_id);
create index knowledge_relations_to_idx on knowledge_relations(to_document_id);

create table evidence (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id),
  source_id uuid not null references sources(id),
  artifact_id uuid references source_artifacts(id),
  locator jsonb not null,
  content_hash text not null,
  excerpt text,
  review_status text not null,
  created_at timestamptz not null default now()
);

create table embeddings (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id),
  document_id uuid not null references knowledge_documents(id),
  model text not null,
  model_revision text,
  dimensions integer not null,
  embedding vector not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  unique (document_id, model, content_hash)
);

create table ingest_jobs (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id),
  source_uri text not null,
  state text not null,
  payload jsonb not null,
  result jsonb,
  error jsonb,
  attempts integer not null default 0,
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index ingest_jobs_claim_idx
  on ingest_jobs(state, lease_expires_at, created_at);

create table reviews (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id),
  branch_name text not null,
  base_commit text not null,
  head_commit text not null,
  status text not null,
  author_id uuid references users(id),
  impact_manifest jsonb not null,
  validation_report jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table review_comments (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references reviews(id),
  author_id uuid references users(id),
  path text,
  line integer,
  body text not null,
  created_at timestamptz not null default now()
);

create table context_packets (
  id uuid primary key,
  space_id uuid references spaces(id),
  actor_id uuid references users(id),
  corpus_revision text not null,
  query_hash text not null,
  packet_hash text not null,
  request jsonb not null,
  packet jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create table audit_events (
  id bigserial primary key,
  organization_id uuid references organizations(id),
  space_id uuid references spaces(id),
  actor_id uuid references users(id),
  action text not null,
  resource_type text not null,
  resource_id text,
  metadata jsonb not null default '{}'::jsonb,
  trace_id text,
  created_at timestamptz not null default now()
);

create table eval_cases (
  id text primary key,
  space_id uuid references spaces(id),
  category text not null,
  query text not null,
  expected jsonb not null,
  critical boolean not null default false,
  active boolean not null default true
);

create table eval_runs (
  id uuid primary key default gen_random_uuid(),
  corpus_revision text not null,
  retrieval_config jsonb not null,
  metrics jsonb not null,
  status text not null,
  created_at timestamptz not null default now()
);
