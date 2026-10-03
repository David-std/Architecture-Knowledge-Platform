-- External references created through the workspace API are user/agent-relayed
-- coordination state. Before provider-authenticated adapters exist they cannot
-- claim SYSTEM_OF_RECORD authority.
update external_object_refs
   set metadata = metadata || jsonb_build_object(
         'authorityDowngradedFrom','SYSTEM_OF_RECORD',
         'authorityDowngradeReason','NO_VERIFIED_PROVIDER_PATH'
       ),
       authority = 'REFERENCE',
       updated_at = now()
 where authority = 'SYSTEM_OF_RECORD';

alter table external_object_refs
  alter column authority set default 'REFERENCE';
