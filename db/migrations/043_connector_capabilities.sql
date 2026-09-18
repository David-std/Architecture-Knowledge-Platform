-- P2 ConnectorCapabilities contract.
--
-- Earlier P2 peers accepted arbitrary JSON. Once capability claims participate
-- in planning, an untyped blob must never be interpreted as permission-faithful
-- or mirror-capable merely because it predates the contract. Legacy rows are
-- therefore downgraded to a conservative truthful descriptor instead of having
-- their previous JSON guessed into stronger semantics.

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
    jsonb_typeof(capabilities)='object'
    and capabilities->>'schemaVersion'='1'
    and capabilities->>'accessMode' in (
      'MIRROR_INDEXED','REMOTE_FEDERATED','REFERENCE_LIVE','HYBRID_CACHE'
    )
    and capabilities->>'permissionFidelity' in (
      'SOURCE_ACL_EXACT','SOURCE_ACL_MAPPED','WORKSPACE_WIDE','NONE'
    )
    and capabilities->>'syncFidelity' in ('APPEND','UPSERT','MIRROR')
    and jsonb_typeof(capabilities->'incrementalSync')='boolean'
    and capabilities->>'deletionPropagation' in ('IMMEDIATE','EVENTUAL','NONE')
    and (
      not (capabilities ? 'freshnessSlaSeconds')
      or (
        jsonb_typeof(capabilities->'freshnessSlaSeconds')='number'
        and (capabilities->>'freshnessSlaSeconds')::numeric > 0
      )
    )
    and jsonb_typeof(capabilities->'cursorOrWebhook')='boolean'
    and capabilities->>'sourceAuthority' in ('SYSTEM_OF_RECORD','REFERENCE','DERIVED')
    and capabilities->>'writeBack' in ('NONE','BOUNDED_ACTIONS','FULL')
    and capabilities->>'identityMapping' in ('EXACT','MAPPED','NONE')
    and capabilities->>'dataResidency' in ('LOCAL','ORG','EXTERNAL')
    and jsonb_typeof(capabilities->'replayable')='boolean'
    and capabilities->>'auditTrail' in ('FULL','METADATA_ONLY','NONE')
    and capabilities->>'health' in ('HEALTHY','DEGRADED','STALE','UNAVAILABLE')
    and jsonb_typeof(capabilities->'rateLimit')='object'
    and (
      capabilities#>>'{rateLimit,kind}'='NONE'
      or (
        capabilities#>>'{rateLimit,kind}'='DECLARED'
        and jsonb_typeof(capabilities#>'{rateLimit,requestsPerMinute}')='number'
        and (capabilities#>>'{rateLimit,requestsPerMinute}')::numeric > 0
        and (
          not ((capabilities->'rateLimit') ? 'burst')
          or (
            jsonb_typeof(capabilities#>'{rateLimit,burst}')='number'
            and (capabilities#>>'{rateLimit,burst}')::numeric > 0
          )
        )
        and capabilities#>>'{rateLimit,onExceeded}' in ('BACKOFF','QUEUE','FAIL_CLOSED')
      )
    )
    and jsonb_typeof(capabilities->'degradation')='object'
    and capabilities#>>'{degradation,onUnavailable}' in ('FAIL_CLOSED','STALE_READ')
    and (
      (
        capabilities#>>'{degradation,onUnavailable}'='FAIL_CLOSED'
        and not ((capabilities->'degradation') ? 'maxStaleSeconds')
      )
      or (
        capabilities#>>'{degradation,onUnavailable}'='STALE_READ'
        and jsonb_typeof(capabilities#>'{degradation,maxStaleSeconds}')='number'
        and (capabilities#>>'{degradation,maxStaleSeconds}')::numeric >= 0
        and capabilities->>'accessMode' in ('MIRROR_INDEXED','HYBRID_CACHE')
      )
    )
    and (
      capabilities->>'permissionFidelity'<>'SOURCE_ACL_MAPPED'
      or capabilities->>'identityMapping'<>'NONE'
    )
  );

alter table context_fabric_peers
  alter column capabilities drop default;

comment on column context_fabric_peers.capabilities is
  'ConnectorCapabilities v1 declaration. It describes guarantees; vault KnowledgeProfile connectorPolicy decides whether those guarantees are acceptable.';
