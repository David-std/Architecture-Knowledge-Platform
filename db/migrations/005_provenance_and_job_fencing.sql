create table document_evidence (
  document_id uuid not null references knowledge_documents(id) on delete cascade,
  evidence_id uuid not null references evidence(id) on delete cascade,
  relation_type text not null default 'supported_by',
  created_at timestamptz not null default now(),
  primary key(document_id,evidence_id,relation_type)
);

create index document_evidence_evidence_idx on document_evidence(evidence_id);

alter table ingest_jobs add column version bigint not null default 0;

create unique index source_artifacts_deterministic_idx
  on source_artifacts(source_id,kind,extractor_version,(metadata->'locator'));

create unique index evidence_artifact_unique_idx
  on evidence(artifact_id)
  where artifact_id is not null;
