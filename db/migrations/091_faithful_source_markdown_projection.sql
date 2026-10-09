-- Keep a deterministic complete Markdown projection alongside its one
-- canonical sanitized DocumentArtifact. Prior rows remain explicitly
-- UNAVAILABLE_LEGACY until a controlled reprocessing/backfill is performed.
-- Do not infer an approved knowledge document from this machine projection.
alter table source_artifacts
  add column source_markdown text,
  add column source_markdown_hash text,
  add column source_markdown_renderer_version text;

alter table source_artifacts
  add constraint source_artifacts_source_markdown_integrity_check check (
    (
      source_markdown is null
      and source_markdown_hash is null
      and source_markdown_renderer_version is null
    ) or (
      kind = 'document-artifact'
      and source_markdown is not null
      and source_markdown_hash ~ '^[a-f0-9]{64}$'
      and source_markdown_hash =
        encode(digest(convert_to(source_markdown, 'UTF8'), 'sha256'), 'hex')
      and source_markdown_renderer_version ~ '^[0-9]+[.][0-9]+$'
    )
  );

comment on column source_artifacts.source_markdown is
  'Complete deterministic Markdown projection of this sanitized DocumentArtifact, not approved Git knowledge.';
comment on column source_artifacts.source_markdown_hash is
  'Verified SHA-256 of UTF-8 source_markdown bytes. NULL means legacy projection unavailable.';
comment on column source_artifacts.source_markdown_renderer_version is
  'Version of the deterministic DocumentArtifact Markdown renderer.';
