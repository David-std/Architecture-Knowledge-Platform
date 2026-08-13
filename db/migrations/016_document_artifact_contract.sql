-- Canonical, provider-neutral document-intelligence result. Legacy flattened
-- artifacts remain readable, but new ingestion persists one deterministic
-- DocumentArtifact row and links derived evidence/knowledge units to it.
alter table source_artifacts
  add column document_artifact jsonb,
  add column artifact_schema_version text,
  add column configuration_hash text,
  add column structured_content_hash text;

alter table source_artifacts
  add constraint source_artifacts_document_artifact_shape_check check (
    kind <> 'document-artifact'
    or (
      jsonb_typeof(document_artifact) = 'object'
      and artifact_schema_version is not null
      and artifact_schema_version ~ '^[0-9]+[.][0-9]+$'
      and configuration_hash ~ '^[a-f0-9]{64}$'
      and structured_content_hash ~ '^[a-f0-9]{64}$'
      and document_artifact->>'source_id' = source_id::text
      and document_artifact->>'source_hash' = source_hash
      and jsonb_typeof(document_artifact->'configuration') = 'object'
      and coalesce(document_artifact->>'media_type','') <> ''
      and document_artifact->>'extractor' = extractor
      and document_artifact->>'extractor_version' = extractor_version
    )
  );

create unique index source_artifacts_document_artifact_idx
  on source_artifacts(source_id, extractor, extractor_version, configuration_hash)
  where kind = 'document-artifact';

create index source_artifacts_document_artifact_source_idx
  on source_artifacts(source_id, created_at desc)
  where kind = 'document-artifact';

comment on column source_artifacts.document_artifact is
  'Sanitized provider-neutral DocumentArtifact; never a raw licensed blob or host path.';
comment on column source_artifacts.configuration_hash is
  'SHA-256 of canonicalized extractor configuration after secret/path redaction.';
comment on column source_artifacts.structured_content_hash is
  'SHA-256 of the complete sanitized canonical DocumentArtifact JSON.';
