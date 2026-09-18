-- P2 ConnectorCapabilities contract.
--
-- Earlier P2 peers accepted arbitrary JSON. That is unsafe once connector
-- semantics participate in planning: an untyped blob must never be interpreted
-- as permission-faithful or mirror-capable merely because it existed before
-- the contract. Legacy rows are therefore converted to the most conservative
-- truthful descriptor instead of having their old JSON guessed into semantics.

update context_fabric_peers
   set capabilities = '{
     "schemaVersion": 1,
     "accessMode": "REFERENCE_LIVE",
     "permissionFidelity": "NONE",
     "syncFidelity": "APPEND",
     "incrementalSync": false,
     "deletionPropagation": "NONE",
     "cursorOrWebhook": false,
     "sourceAuthority": "REFERENCE",
     "writeBack": "NONE",
     "identityMapping": "NONE",
     "dataResidency": "EXTERNAL",
     "replayable": false,
     "auditTrail": "NONE",
     "rateLimit": {"kind": "NONE"},
     "degradation": {"onUnavailable": "FAIL_CLOSED"},
     "health": "STALE"
   }'::jsonb
 where capabilities->>'schemaVersion' is distinct from '1';

alter table context_fabric_peers
  add constraint context_fabric_peers_capability_contract_v1
  check (
    capabilities->>'schemaVersion' = '1'
    and capabilities->>'accessMode' in (
      'MIRROR_INDEXED','REMOTE_FEDERATED','REFERENCE_LIVE','HYBRID_CACHE'
    )
    and capabilities->>'permissionFidelity' in (
      'SOURCE_ACL_EXACT','SOURCE_ACL_MAPPED','WORKSPACE_WIDE','NONE'
    )
    and capabilities->>'syncFidelity' in ('APPEND','UPSERT','MIRROR')
    and capabilities->>'deletionPropagation' in ('IMMEDIATE','EVENTUAL','NONE')
    and capabilities->>'sourceAuthority' in ('SYSTEM_OF_RECORD','REFERENCE','DERIVED')
    and capabilities->>'writeBack' in ('NONE','BOUNDED_ACTIONS','FULL')
    and capabilities->>'identityMapping' in ('EXACT','MAPPED','NONE')
    and capabilities->>'dataResidency' in ('LOCAL','ORG','EXTERNAL')
    and capabilities->>'auditTrail' in ('FULL','METADATA_ONLY','NONE')
    and capabilities->>'health' in ('HEALTHY','DEGRADED','STALE','UNAVAILABLE')
  );

comment on column context_fabric_peers.capabilities is
  'ConnectorCapabilities v1 declaration. It describes guarantees; vault KnowledgeProfile connectorPolicy decides whether those guarantees are acceptable.';
