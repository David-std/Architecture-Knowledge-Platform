alter table reviews
  add column review_round integer not null default 1
  check (review_round > 0);

create table review_approvals (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references reviews(id) on delete cascade,
  review_round integer not null check (review_round > 0),
  head_commit text not null check (length(btrim(head_commit)) > 0),
  policy_fingerprint text not null
    check (policy_fingerprint ~ '^[a-f0-9]{64}$'),
  profile_source text not null
    check (profile_source in ('DURABLE_REVISION', 'V03_DEFAULT')),
  profile_revision_id uuid references knowledge_profile_revisions(id),
  profile_hash text not null check (profile_hash ~ '^[a-f0-9]{64}$'),
  reviewer_id uuid not null references users(id),
  reviewer_role text not null check (length(btrim(reviewer_role)) > 0),
  reason text not null check (length(btrim(reason)) > 0),
  created_at timestamptz not null default now(),
  constraint review_approvals_profile_source_shape check (
    (profile_source='V03_DEFAULT' and profile_revision_id is null) or
    (profile_source='DURABLE_REVISION' and profile_revision_id is not null)
  ),
  unique (
    review_id,review_round,head_commit,policy_fingerprint,reviewer_id
  )
);

create index review_approvals_quorum_idx
  on review_approvals(review_id,review_round,head_commit,policy_fingerprint,created_at);
create index review_approvals_reviewer_idx
  on review_approvals(reviewer_id,created_at desc);

comment on table review_approvals is
  'Append-only approval facts. Quorum is counted only for the exact review round, draft head and effective KnowledgeProfile review-policy fingerprint.';
