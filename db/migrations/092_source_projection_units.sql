-- Source passages are derived from immutable machine-extracted Markdown.
-- They are revision-pinned evidence, NOT approved managed-Git knowledge.
create table source_projection_units (
  source_artifact_id uuid not null references source_artifacts(id) on delete cascade,
  source_id uuid not null references sources(id) on delete cascade,
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  markdown_sha256 text not null check (markdown_sha256 ~ '^[a-f0-9]{64}$'),
  unit_key text not null,
  parent_unit_key text,
  unit_type text not null,
  heading_path text[] not null,
  body text not null,
  body_sha256 text not null,
  source_span_sha256 text not null,
  locator jsonb not null,
  structural_order int not null,
  primary key (source_artifact_id, unit_key),
  constraint source_projection_units_body_hash_check
    check (body_sha256 = encode(digest(convert_to(body,'UTF8'),'sha256'),'hex')),
  constraint source_projection_units_span_hash_check
    check (source_span_sha256 ~ '^[a-f0-9]{64}$'),
  constraint source_projection_units_locator_check
    check (jsonb_typeof(locator)='object')
);
create index source_projection_units_revision_order_idx
  on source_projection_units(source_id,source_sha256,markdown_sha256,structural_order);
comment on table source_projection_units is
  'Revision-pinned source passages; separate from reviewed Git knowledge.';
