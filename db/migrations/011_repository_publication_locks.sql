-- A managed Git repository can serve more than one knowledge space.  A lock
-- keyed only by space would therefore permit concurrent merges into one main
-- branch.  Keep the legacy per-space table for historical auditability and
-- use this repository-keyed lock for all new publication and rollback paths.
create table repository_publication_locks (
  repository_key text primary key,
  owner text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
