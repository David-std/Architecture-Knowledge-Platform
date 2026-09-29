-- Durable linkage between authenticated provider projections and session refs.
-- Clients never choose MIRRORED_PROJECTION authority or provider metadata.
create table external_object_provider_links (
  external_ref_id uuid primary key
    references external_object_refs(id) on delete cascade,
  connector_id uuid not null
    references source_connector_registrations(id) on delete restrict,
  object_id text not null,
  linked_at timestamptz not null default now(),
  unique(connector_id,object_id,external_ref_id),
  foreign key(connector_id,object_id)
    references source_connector_objects(connector_id,object_id)
    on delete restrict
);

create index external_object_provider_links_object_idx
  on external_object_provider_links(connector_id,object_id);

comment on table external_object_provider_links is
  'Server-established linkage from an authenticated provider projection to a session external reference.';
