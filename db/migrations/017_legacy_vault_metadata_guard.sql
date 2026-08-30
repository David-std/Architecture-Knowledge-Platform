create or replace function akp_is_canonical_uuid_text(value text)
returns boolean
language sql
immutable
strict
as $function$
  select value ~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
$function$;

comment on function akp_is_canonical_uuid_text(text) is
  'Validates canonical UUID text without performing a potentially failing cast.';

-- Preserve invalid legacy values for diagnosis, but do not leave them in the
-- operational vaultId field. 013 used a permissive 36-character predicate;
-- this follow-up also handles invalid JSON types and shorter malformed text.
update error_book
   set metadata=jsonb_set(
     metadata - 'vaultId',
     '{_akpLegacyInvalidVaultId017}',
     jsonb_build_object(
       'value', metadata->'vaultId',
       'previous', metadata->'_akpLegacyInvalidVaultId017'
     ),
     true
   )
 where metadata ? 'vaultId'
   and metadata->'vaultId' <> 'null'::jsonb
   and not (
     jsonb_typeof(metadata->'vaultId')='string'
     and akp_is_canonical_uuid_text(metadata->>'vaultId')
   );

update schema_dry_runs
   set report=jsonb_set(
     report - 'vaultId',
     '{_akpLegacyInvalidVaultId017}',
     jsonb_build_object(
       'value', report->'vaultId',
       'previous', report->'_akpLegacyInvalidVaultId017'
     ),
     true
   )
 where report ? 'vaultId'
   and report->'vaultId' <> 'null'::jsonb
   and not (
     jsonb_typeof(report->'vaultId')='string'
     and akp_is_canonical_uuid_text(report->>'vaultId')
   );

update audit_events
   set metadata=jsonb_set(
     metadata - 'vaultId',
     '{_akpLegacyInvalidVaultId017}',
     jsonb_build_object(
       'value', metadata->'vaultId',
       'previous', metadata->'_akpLegacyInvalidVaultId017'
     ),
     true
   )
 where metadata ? 'vaultId'
   and metadata->'vaultId' <> 'null'::jsonb
   and not (
     jsonb_typeof(metadata->'vaultId')='string'
     and akp_is_canonical_uuid_text(metadata->>'vaultId')
   );

alter table error_book
  add constraint error_book_metadata_vault_id_check
  check (
    not (metadata ? 'vaultId')
    or metadata->'vaultId' = 'null'::jsonb
    or (
      jsonb_typeof(metadata->'vaultId')='string'
      and akp_is_canonical_uuid_text(metadata->>'vaultId')
    )
  );

alter table schema_dry_runs
  add constraint schema_dry_runs_report_vault_id_check
  check (
    not (report ? 'vaultId')
    or report->'vaultId' = 'null'::jsonb
    or (
      jsonb_typeof(report->'vaultId')='string'
      and akp_is_canonical_uuid_text(report->>'vaultId')
    )
  );

alter table audit_events
  add constraint audit_events_metadata_vault_id_check
  check (
    not (metadata ? 'vaultId')
    or metadata->'vaultId' = 'null'::jsonb
    or (
      jsonb_typeof(metadata->'vaultId')='string'
      and akp_is_canonical_uuid_text(metadata->>'vaultId')
    )
  );
