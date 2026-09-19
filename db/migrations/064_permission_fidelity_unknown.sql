-- P8.6/P8.11 explicit unknown permission fidelity.
--
-- UNKNOWN is deliberately distinct from NONE:
-- NONE says the source declares no reusable ACL fidelity;
-- UNKNOWN says AKP cannot establish the fidelity at all.
-- Both must remain fail-closed for policies that require faithful ACLs.

alter table context_fabric_peers
  drop constraint if exists context_fabric_peers_capability_contract_v1;

alter table context_fabric_peers
  add constraint context_fabric_peers_capability_contract_v1
  check (
    jsonb_typeof(capabilities)='object'
    and capabilities->>'schemaVersion'='1'
    and capabilities->>'accessMode' in (
      'MIRROR_INDEXED','REMOTE_FEDERATED','REFERENCE_LIVE','HYBRID_CACHE'
    )
    and capabilities->>'permissionFidelity' in (
      'SOURCE_ACL_EXACT','SOURCE_ACL_MAPPED','WORKSPACE_WIDE','NONE','UNKNOWN'
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
    and capabilities->>'sourceAuthority' in (
      'SYSTEM_OF_RECORD','REFERENCE','DERIVED'
    )
    and capabilities->>'writeBack' in ('NONE','BOUNDED_ACTIONS','FULL')
    and capabilities->>'identityMapping' in ('EXACT','MAPPED','NONE')
    and capabilities->>'dataResidency' in ('LOCAL','ORG','EXTERNAL')
    and jsonb_typeof(capabilities->'replayable')='boolean'
    and capabilities->>'auditTrail' in ('FULL','METADATA_ONLY','NONE')
    and capabilities->>'health' in (
      'HEALTHY','DEGRADED','STALE','UNAVAILABLE'
    )
    and jsonb_typeof(capabilities->'rateLimit')='object'
    and (
      capabilities#>>'{rateLimit,kind}'='NONE'
      or (
        capabilities#>>'{rateLimit,kind}'='DECLARED'
        and jsonb_typeof(
          capabilities#>'{rateLimit,requestsPerMinute}'
        )='number'
        and (
          capabilities#>>'{rateLimit,requestsPerMinute}'
        )::numeric > 0
        and (
          not ((capabilities->'rateLimit') ? 'burst')
          or (
            jsonb_typeof(capabilities#>'{rateLimit,burst}')='number'
            and (capabilities#>>'{rateLimit,burst}')::numeric > 0
          )
        )
        and capabilities#>>'{rateLimit,onExceeded}' in (
          'BACKOFF','QUEUE','FAIL_CLOSED'
        )
      )
    )
    and jsonb_typeof(capabilities->'degradation')='object'
    and capabilities#>>'{degradation,onUnavailable}' in (
      'FAIL_CLOSED','STALE_READ'
    )
    and (
      (
        capabilities#>>'{degradation,onUnavailable}'='FAIL_CLOSED'
        and not ((capabilities->'degradation') ? 'maxStaleSeconds')
      )
      or (
        capabilities#>>'{degradation,onUnavailable}'='STALE_READ'
        and jsonb_typeof(
          capabilities#>'{degradation,maxStaleSeconds}'
        )='number'
        and (
          capabilities#>>'{degradation,maxStaleSeconds}'
        )::numeric >= 0
        and capabilities->>'accessMode' in (
          'MIRROR_INDEXED','HYBRID_CACHE'
        )
      )
    )
    and (
      capabilities->>'permissionFidelity'<>'SOURCE_ACL_MAPPED'
      or capabilities->>'identityMapping'<>'NONE'
    )
  );

alter table source_connector_events
  drop constraint if exists source_connector_events_permission_fidelity_check;

alter table source_connector_events
  add constraint source_connector_events_permission_fidelity_check
  check (
    permission_fidelity in (
      'SOURCE_ACL_EXACT','SOURCE_ACL_MAPPED','WORKSPACE_WIDE','NONE','UNKNOWN'
    )
  );

alter table source_connector_objects
  drop constraint if exists source_connector_objects_permission_fidelity_check;

alter table source_connector_objects
  add constraint source_connector_objects_permission_fidelity_check
  check (
    permission_fidelity in (
      'SOURCE_ACL_EXACT','SOURCE_ACL_MAPPED','WORKSPACE_WIDE','NONE','UNKNOWN'
    )
  );

comment on constraint context_fabric_peers_capability_contract_v1
  on context_fabric_peers is
  'ConnectorCapabilities v1; UNKNOWN permission fidelity is explicit and never satisfies a faithful-ACL policy.';
