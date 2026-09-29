-- A provider/work reference may legitimately participate in more than one
-- workspace session. The original vault-wide identity caused an upsert in a
-- second session to move the reference out of the first session.
alter table external_object_refs
  drop constraint if exists external_object_refs_vault_id_provider_object_type_external_id_key;

create unique index external_object_refs_session_identity_uniq
  on external_object_refs(
    vault_id,session_id,provider,object_type,external_id
  )
  where session_id is not null;

create unique index external_object_refs_unscoped_identity_uniq
  on external_object_refs(vault_id,provider,object_type,external_id)
  where session_id is null;
