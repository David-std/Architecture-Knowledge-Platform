-- S2 opt-in only: versioned human-reviewed natural-language/SOURCE relation.
-- This table is not a model prediction cache, answer gold or default admission.
create table s2_reviewed_source_propositions (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id),
  vault_id uuid not null references vaults(id),
  document_id uuid not null references knowledge_documents(id),
  unit_id uuid references knowledge_units(id),
  document_path text not null,
  document_revision text not null,
  source_id uuid not null references sources(id),
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  question_text text not null check (char_length(question_text) between 1 and 4096),
  question_sha256 text not null check (question_sha256 ~ '^[a-f0-9]{64}$'),
  excerpt text not null check (char_length(excerpt) between 1 and 8192),
  excerpt_sha256 text not null check (excerpt_sha256 ~ '^[a-f0-9]{64}$'),
  query_proposition jsonb not null check (jsonb_typeof(query_proposition)='object'),
  source_proposition jsonb not null check (jsonb_typeof(source_proposition)='object'),
  proposed_by uuid not null references users(id),
  approved_by uuid references users(id),
  revoked_by uuid references users(id),
  revoked_at timestamptz,
  status text not null default 'PROPOSED'
    check (status in ('PROPOSED','APPROVED','REVOKED')),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  constraint s2_distinct_human_reviewers check (
    approved_by is null or approved_by <> proposed_by
  ),
  constraint s2_approval_state check (
    (status='PROPOSED' and approved_by is null and approved_at is null
      and revoked_by is null and revoked_at is null)
    or (status='APPROVED' and approved_by is not null and approved_at is not null
      and revoked_by is null and revoked_at is null)
    or (status='REVOKED' and revoked_by is not null and revoked_at is not null)
  )
);
create index s2_reviewed_source_propositions_lookup
  on s2_reviewed_source_propositions
  (space_id,vault_id,document_id,question_sha256,status);
comment on table s2_reviewed_source_propositions is
  'Non-generative, two-human-reviewed projections. Never production gold; original SOURCE and request scope must be reverified on each resolve.';
