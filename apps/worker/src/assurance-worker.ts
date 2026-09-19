import {
  IMPLEMENTED_ASSURANCE_DETECTORS,
  type AssuranceDetector,
  type AssuranceFinding,
  type AssuranceRun,
  type AssuranceSeverity,
} from "@akp/domain";
import {
  appendAssuranceFindings,
  completeAssuranceRun,
  failAssuranceRun,
  renewAssuranceRunLease,
  type Postgres,
} from "@akp/postgres";

export const SUPPORTED_ASSURANCE_DETECTORS = IMPLEMENTED_ASSURANCE_DETECTORS;

type SupportedDetector = (typeof IMPLEMENTED_ASSURANCE_DETECTORS)[number];

function finding(
  detector: SupportedDetector,
  severity: AssuranceSeverity,
  code: string,
  subjectKind: string,
  subjectId: string,
  summary: string,
  metadata: Record<string, unknown> = {},
  evidenceRefs: string[] = [],
): AssuranceFinding {
  return {
    detector,
    severity,
    code,
    subjectKind,
    subjectId,
    summary,
    evidenceRefs,
    metadata,
  };
}

async function collectDetectorFindings(
  db: Postgres,
  run: AssuranceRun,
  detector: SupportedDetector,
): Promise<AssuranceFinding[]> {
  const scope = [run.spaceId, run.vaultId];
  switch (detector) {
    case "GROUNDING": {
      const rows = await db.pool.query<{
        id: string;
        path: string;
      }>(
        `select d.id,d.path
           from knowledge_documents d
          where d.space_id=$1 and d.vault_id=$2
            and d.lifecycle in ('ACTIVE','DISPUTED')
            and d.layer not in ('source','resource','root')
            and coalesce(d.external_id,'') not like 'RAW-%'
            and not exists(
              select 1 from document_evidence de where de.document_id=d.id
            )
          order by d.id
          limit 500`,
        scope,
      );
      return rows.rows.map((row) =>
        finding(
          detector,
          "HIGH",
          "UNGROUNDED_ACTIVE_KNOWLEDGE",
          "knowledge_document",
          row.id,
          "Active knowledge has no document evidence link.",
          { path: row.path },
        ),
      );
    }
    case "FRESHNESS": {
      const rows = await db.pool.query<{
        id: string;
        refresh_status: string;
        stale_reason: string | null;
      }>(
        `select id,refresh_status,stale_reason
           from knowledge_documents
          where space_id=$1 and vault_id=$2
            and lifecycle in ('ACTIVE','DISPUTED')
            and refresh_status<>'CURRENT'
          order by id
          limit 500`,
        scope,
      );
      return rows.rows.map((row) =>
        finding(
          detector,
          row.refresh_status === "INVALID" ? "HIGH" : "WARN",
          "STALE_KNOWLEDGE",
          "knowledge_document",
          row.id,
          "Knowledge is not current against its governed source state.",
          {
            refreshStatus: row.refresh_status,
            staleReason: row.stale_reason,
          },
        ),
      );
    }
    case "CONTRADICTION": {
      const rows = await db.pool.query<{
        id: string;
        topic: string;
        status: string;
      }>(
        `select id,topic,status
           from contradiction_clusters
          where space_id=$1 and vault_id=$2 and status<>'RESOLVED'
          order by id
          limit 500`,
        scope,
      );
      return rows.rows.map((row) =>
        finding(
          detector,
          "WARN",
          "OPEN_CONTRADICTION",
          "contradiction_cluster",
          row.id,
          "Contradictory knowledge remains unresolved.",
          { topic: row.topic, status: row.status },
        ),
      );
    }
    case "DUPLICATE_IDENTITY": {
      const rows = await db.pool.query<{
        external_id: string;
        count: number;
      }>(
        `select external_id,count(*)::int count
           from knowledge_documents
          where space_id=$1 and vault_id=$2 and external_id is not null
          group by external_id
         having count(*)>1
          order by external_id
          limit 500`,
        scope,
      );
      return rows.rows.map((row) =>
        finding(
          detector,
          "HIGH",
          "DUPLICATE_EXTERNAL_ID",
          "knowledge_identity",
          row.external_id,
          "More than one knowledge document uses the same external identity.",
          { count: row.count },
        ),
      );
    }
    case "GRAPH_HEALTH": {
      const rows = await db.pool.query<{
        corpus_revision: string;
        graph_revision: string | null;
      }>(
        `select corpus_revision,graph_revision
           from vault_index_revisions
          where space_id=$1 and vault_id=$2
            and (graph_revision is null or graph_revision<>corpus_revision)`,
        scope,
      );
      return rows.rows.map((row) =>
        finding(
          detector,
          "HIGH",
          "GRAPH_REVISION_MISMATCH",
          "vault",
          run.vaultId,
          "The active graph projection does not match the current corpus revision.",
          {
            corpusRevision: row.corpus_revision,
            graphRevision: row.graph_revision,
          },
        ),
      );
    }
    case "TEMPORAL_CONSISTENCY": {
      const rows = await db.pool.query<{
        revision_seq: number;
        revision_hash: string | null;
        latest_seq: number | null;
        latest_hash: string | null;
      }>(
        `select h.revision_seq,h.revision_hash,
                latest.revision_seq latest_seq,
                latest.revision_hash latest_hash
           from truth_revision_heads h
           left join lateral (
             select revision_seq,revision_hash
               from truth_revisions r
              where r.space_id=h.space_id and r.vault_id=h.vault_id
              order by revision_seq desc
              limit 1
           ) latest on true
          where h.space_id=$1 and h.vault_id=$2
            and (
              h.revision_seq<>coalesce(latest.revision_seq,0)
              or h.revision_hash is distinct from latest.revision_hash
            )`,
        scope,
      );
      return rows.rows.map((row) =>
        finding(
          detector,
          "CRITICAL",
          "TEMPORAL_TRUTH_HEAD_MISMATCH",
          "truth_revision_head",
          run.vaultId,
          "Temporal truth head disagrees with the latest immutable truth revision.",
          {
            headSequence: row.revision_seq,
            headHash: row.revision_hash,
            latestSequence: row.latest_seq,
            latestHash: row.latest_hash,
          },
        ),
      );
    }
    case "CODE_GRAPH_FRESHNESS": {
      const rows = await db.pool.query<{
        id: string;
        scope_id: string;
        revision: string;
        source_revision: string;
        freshness: string;
      }>(
        `select id,scope_id,revision,source_revision,freshness
           from federated_graph_projection_revisions
          where space_id=$1 and vault_id=$2 and graph_domain='CODE'
            and lifecycle in ('ACTIVE','STALE') and freshness<>'FRESH'
          order by updated_at desc
          limit 500`,
        scope,
      );
      return rows.rows.map((row) =>
        finding(
          detector,
          "HIGH",
          "CODE_GRAPH_STALE",
          "graph_projection",
          row.id,
          "A code graph projection is stale against its source revision.",
          {
            scopeId: row.scope_id,
            revision: row.revision,
            sourceRevision: row.source_revision,
            freshness: row.freshness,
          },
        ),
      );
    }
    case "LINK_ORPHAN": {
      const rows = await db.pool.query<{
        id: string;
        path: string;
      }>(
        `select d.id,d.path
           from knowledge_documents d
          where d.space_id=$1 and d.vault_id=$2 and d.lifecycle='ACTIVE'
            and d.layer not in ('source','resource','root')
            and coalesce(d.external_id,'') not like 'RAW-%'
            and not exists(
              select 1
                from knowledge_relations r
               where r.space_id=$1
                 and (
                   r.from_document_id=d.id
                   or r.to_document_id=d.id
                 )
            )
          order by d.id
          limit 500`,
        scope,
      );
      return rows.rows.map((row) =>
        finding(
          detector,
          "WARN",
          "ORPHAN_ACTIVE_KNOWLEDGE",
          "knowledge_document",
          row.id,
          "Active knowledge is disconnected from the governed knowledge graph.",
          { path: row.path },
        ),
      );
    }
    case "SYNTHESIS_ACCESS_BOUNDARY": {
      const rows = await db.pool.query<{
        id: string;
        vault_id: string | null;
        scope: Record<string, unknown>;
      }>(
        `select id,vault_id,scope
           from context_packets
          where space_id=$1
            and (
              scope->>'spaceId' is distinct from $1::text
              or not (scope ? 'vaultIds')
              or jsonb_typeof(scope->'vaultIds')<>'array'
              or (
                vault_id is not null
                and not (scope->'vaultIds' @> to_jsonb(array[vault_id::text]))
              )
            )
          order by created_at desc
          limit 500`,
        [run.spaceId],
      );
      return rows.rows.map((row) =>
        finding(
          detector,
          "CRITICAL",
          "CONTEXT_PACKET_SCOPE_MISMATCH",
          "context_packet",
          row.id,
          "Persisted synthesis scope metadata is inconsistent with its database scope.",
          { vaultId: row.vault_id, scope: row.scope },
        ),
      );
    }
    case "CONNECTOR_DELETION": {
      const rows = await db.pool.query<{
        connector_id: string;
        object_id: string;
        sequence: string | number;
        lifecycle: string | null;
        source_sequence: string | number | null;
      }>(
        `with latest as (
           select distinct on (e.connector_id,e.object_id)
                  e.connector_id,e.object_id,e.sequence,e.operation
             from source_connector_events e
             join source_connector_registrations r on r.id=e.connector_id
            where r.space_id=$1 and r.vault_id=$2 and e.status='APPLIED'
            order by e.connector_id,e.object_id,e.sequence desc
         )
         select l.connector_id::text,l.object_id,l.sequence,
                o.lifecycle,o.source_sequence
           from latest l
           left join source_connector_objects o
             on o.connector_id=l.connector_id and o.object_id=l.object_id
          where l.operation='DELETE'
            and (
              o.object_id is null
              or o.lifecycle<>'DELETED_TOMBSTONE'
              or o.source_sequence<>l.sequence
            )
          order by l.connector_id,l.object_id
          limit 500`,
        scope,
      );
      return rows.rows.map((row) =>
        finding(
          detector,
          "CRITICAL",
          "CONNECTOR_DELETE_NOT_TOMBSTONED",
          "source_connector_object",
          `${row.connector_id}:${row.object_id}`,
          "The latest applied connector deletion is not represented by the matching tombstone.",
          {
            sequence: Number(row.sequence),
            lifecycle: row.lifecycle,
            sourceSequence:
              row.source_sequence === null ? null : Number(row.source_sequence),
          },
        ),
      );
    }
    case "CONNECTOR_FRESHNESS": {
      const rows = await db.pool.query<{
        id: string;
        connector_key: string;
        source_system: string;
        freshness_sla_seconds: number;
        last_applied_at: Date | string | null;
        applied_sequence: string | number;
      }>(
        `select r.id::text,r.connector_key,r.source_system,
                (r.descriptor->>'freshnessSlaSeconds')::int freshness_sla_seconds,
                max(e.occurred_at) filter (where e.status='APPLIED') last_applied_at,
                c.applied_sequence
           from source_connector_registrations r
           join source_connector_checkpoints c on c.connector_id=r.id
           left join source_connector_events e on e.connector_id=r.id
          where r.space_id=$1 and r.vault_id=$2 and r.state='ACTIVE'
            and r.descriptor ? 'freshnessSlaSeconds'
            and r.descriptor->>'freshnessSlaSeconds' ~ '^[0-9]+
      const rows = await db.pool.query<{
        graph_domain: string;
        scope_id: string;
        active_count: number;
      }>(
        `select graph_domain,scope_id,count(*)::int active_count
           from federated_graph_projection_revisions
          where space_id=$1 and vault_id=$2 and lifecycle='ACTIVE'
          group by graph_domain,scope_id
         having count(*)>1
          order by graph_domain,scope_id
          limit 500`,
        scope,
      );
      return rows.rows.map((row) =>
        finding(
          detector,
          "CRITICAL",
          "MULTIPLE_ACTIVE_GRAPH_REVISIONS",
          "graph_scope",
          `${row.graph_domain}:${row.scope_id}`,
          "More than one graph revision is active for the same graph scope.",
          { activeCount: row.active_count },
        ),
      );
    }
    case "ORPHAN_WORK": {
      const rows = await db.pool.query<{
        id: string;
        session_id: string;
        work_key: string;
        work_status: string;
      }>(
        `select c.id,c.session_id,c.work_key,
                coalesce(s.state->>'workStatus','OPEN') work_status
           from workspace_claims c
           join agent_sessions s on s.id=c.session_id
          where s.space_id=$1 and s.vault_id=$2 and c.status='ACTIVE'
            and coalesce(s.state->>'workStatus','OPEN') in ('COMPLETED','ABANDONED')
          order by c.id
          limit 500`,
        scope,
      );
      return rows.rows.map((row) =>
        finding(
          detector,
          "HIGH",
          "ORPHAN_ACTIVE_WORK",
          "workspace_claim",
          row.id,
          "An active claim remains attached to a completed or abandoned workspace.",
          {
            sessionId: row.session_id,
            workKey: row.work_key,
            workStatus: row.work_status,
          },
        ),
      );
    }
    case "EXPIRED_CLAIM": {
      const rows = await db.pool.query<{
        id: string;
        session_id: string;
        work_key: string;
        lease_expires_at: Date | string;
      }>(
        `select c.id,c.session_id,c.work_key,c.lease_expires_at
           from workspace_claims c
           join agent_sessions s on s.id=c.session_id
          where s.space_id=$1 and s.vault_id=$2 and c.status='ACTIVE'
            and c.lease_expires_at<=now()
          order by c.lease_expires_at
          limit 500`,
        scope,
      );
      return rows.rows.map((row) =>
        finding(
          detector,
          "WARN",
          "EXPIRED_WORKSPACE_CLAIM",
          "workspace_claim",
          row.id,
          "A workspace claim is still active after its lease expired.",
          {
            sessionId: row.session_id,
            workKey: row.work_key,
            leaseExpiresAt: new Date(row.lease_expires_at).toISOString(),
          },
        ),
      );
    }
    case "STALE_HANDOFF": {
      const rows = await db.pool.query<{
        id: string;
        claim_id: string;
        session_id: string;
        handoff_revision_hash: string;
        current_revision_hash: string;
      }>(
        `with latest_handoff as (
           select distinct on (e.claim_id)
                  e.id,e.claim_id,e.session_id,
                  e.payload->>'contextRevisionSetHash' handoff_revision_hash
             from workspace_events e
            where e.space_id=$1 and e.vault_id=$2
              and e.event_type='CLAIM_HANDOFF'
              and e.claim_id is not null
              and e.payload ? 'contextRevisionSetHash'
            order by e.claim_id,e.id desc
         )
         select h.id::text,h.claim_id::text,h.session_id::text,
                h.handoff_revision_hash,
                c.revision_set_hash current_revision_hash
           from latest_handoff h
           join workspace_context_revision_sets c on c.session_id=h.session_id
          where h.handoff_revision_hash<>c.revision_set_hash
          order by h.id
          limit 500`,
        scope,
      );
      return rows.rows.map((row) =>
        finding(
          detector,
          "HIGH",
          "STALE_WORKSPACE_HANDOFF",
          "workspace_event",
          row.id,
          "The latest structured handoff is pinned to an older context revision.",
          {
            claimId: row.claim_id,
            sessionId: row.session_id,
            handoffRevisionSetHash: row.handoff_revision_hash,
            currentRevisionSetHash: row.current_revision_hash,
          },
        ),
      );
    }
    case "UNSUPPORTED_CAUSALITY": {
      const rows = await db.pool.query<{
        id: string;
        derivation: string;
      }>(
        `select a.id::text,a.derivation
           from work_activity_events a
          where a.space_id=$1 and a.vault_id=$2 and a.action='CAUSED'
            and a.derivation not in (
              'SOURCE_EXPLICIT','HUMAN_ASSERTED','DYNAMICALLY_PROVEN'
            )
          order by a.id
          limit 500`,
        scope,
      );
      return rows.rows.map((row) =>
        finding(
          detector,
          "CRITICAL",
          "UNSUPPORTED_CAUSALITY",
          "work_activity_event",
          row.id,
          "A causal work-graph assertion lacks an allowed support derivation.",
          { derivation: row.derivation },
        ),
      );
    }
  }
}

function supportedDetector(
  detector: AssuranceDetector,
): detector is SupportedDetector {
  return (SUPPORTED_ASSURANCE_DETECTORS as readonly string[]).includes(
    detector,
  );
}

export async function runClaimedAssuranceRun(
  db: Postgres,
  run: AssuranceRun,
  workerId: string,
): Promise<"COMPLETED" | "RETRY" | "FAILED" | "FENCED"> {
  let detectorIndex = Math.max(0, run.cursor.detectorIndex);
  const counts: Record<string, number> = {};
  try {
    for (; detectorIndex < run.detectors.length; detectorIndex += 1) {
      const detector = run.detectors[detectorIndex]!;
      if (!supportedDetector(detector)) {
        throw new Error(`ASSURANCE_DETECTOR_NOT_IMPLEMENTED:${detector}`);
      }
      const findings = await collectDetectorFindings(db, run, detector);
      await appendAssuranceFindings(db, {
        runId: run.id,
        workerId,
        leaseToken: run.leaseToken,
        spaceId: run.spaceId,
        vaultId: run.vaultId,
        findings,
      });
      counts[detector] = findings.length;
      const renewed = await renewAssuranceRunLease(db, {
        runId: run.id,
        workerId,
        leaseToken: run.leaseToken,
        cursor: { detectorIndex: detectorIndex + 1 },
      });
      if (!renewed) return "FENCED";
    }
    const completed = await completeAssuranceRun(db, {
      runId: run.id,
      workerId,
      leaseToken: run.leaseToken,
      cursor: { detectorIndex },
      summary: {
        detectorCounts: counts,
        supportedDetectors: [...SUPPORTED_ASSURANCE_DETECTORS],
      },
    });
    return completed ? "COMPLETED" : "FENCED";
  } catch (error) {
    return failAssuranceRun(db, {
      runId: run.id,
      workerId,
      leaseToken: run.leaseToken,
      error,
      cursor: { detectorIndex },
    });
  }
}

          group by r.id,r.connector_key,r.source_system,
                   r.descriptor,c.applied_sequence
         having max(e.occurred_at) filter (where e.status='APPLIED') is null
             or max(e.occurred_at) filter (where e.status='APPLIED')
                < now()-make_interval(
                    secs => (r.descriptor->>'freshnessSlaSeconds')::int
                  )
          order by r.id
          limit 500`,
        scope,
      );
      return rows.rows.map((row) =>
        finding(
          detector,
          "HIGH",
          "CONNECTOR_FRESHNESS_SLA_EXCEEDED",
          "source_connector",
          row.id,
          "Connector data has not produced an applied event within its declared freshness SLA.",
          {
            connectorKey: row.connector_key,
            sourceSystem: row.source_system,
            freshnessSlaSeconds: row.freshness_sla_seconds,
            lastAppliedAt: row.last_applied_at
              ? new Date(row.last_applied_at).toISOString()
              : null,
            appliedSequence: Number(row.applied_sequence),
          },
        ),
      );
    }
    case "CONNECTOR_ACL_DRIFT": {
      const rows = await db.pool.query<{
        connector_id: string;
        object_id: string;
        permission_fidelity: string;
        permission_uncertain: boolean;
        declared_fidelity: string | null;
        acl_fingerprint: string | null;
      }>(
        `select o.connector_id::text,o.object_id,o.permission_fidelity,
                o.permission_uncertain,
                r.descriptor->>'permissionFidelity' declared_fidelity,
                o.acl_fingerprint
           from source_connector_objects o
           join source_connector_registrations r on r.id=o.connector_id
          where r.space_id=$1 and r.vault_id=$2 and r.state='ACTIVE'
            and o.lifecycle='ACTIVE'
            and (
              o.permission_uncertain
              or (
                r.descriptor ? 'permissionFidelity'
                and o.permission_fidelity<>
                    r.descriptor->>'permissionFidelity'
              )
            )
          order by o.connector_id,o.object_id
          limit 500`,
        scope,
      );
      return rows.rows.map((row) =>
        finding(
          detector,
          row.permission_uncertain ? "HIGH" : "WARN",
          row.permission_uncertain
            ? "CONNECTOR_ACL_UNCERTAIN"
            : "CONNECTOR_ACL_FIDELITY_DRIFT",
          "source_connector_object",
          `${row.connector_id}:${row.object_id}`,
          row.permission_uncertain
            ? "Connector object permissions are explicitly uncertain."
            : "Connector object permission fidelity differs from the registered connector contract.",
          {
            permissionFidelity: row.permission_fidelity,
            declaredFidelity: row.declared_fidelity,
            permissionUncertain: row.permission_uncertain,
            aclFingerprint: row.acl_fingerprint,
          },
        ),
      );
    }
    case "GRAPH_DISAGREEMENT": {
      const rows = await db.pool.query<{
        graph_domain: string;
        scope_id: string;
        active_count: number;
      }>(
        `select graph_domain,scope_id,count(*)::int active_count
           from federated_graph_projection_revisions
          where space_id=$1 and vault_id=$2 and lifecycle='ACTIVE'
          group by graph_domain,scope_id
         having count(*)>1
          order by graph_domain,scope_id
          limit 500`,
        scope,
      );
      return rows.rows.map((row) =>
        finding(
          detector,
          "CRITICAL",
          "MULTIPLE_ACTIVE_GRAPH_REVISIONS",
          "graph_scope",
          `${row.graph_domain}:${row.scope_id}`,
          "More than one graph revision is active for the same graph scope.",
          { activeCount: row.active_count },
        ),
      );
    }
    case "ORPHAN_WORK": {
      const rows = await db.pool.query<{
        id: string;
        session_id: string;
        work_key: string;
        work_status: string;
      }>(
        `select c.id,c.session_id,c.work_key,
                coalesce(s.state->>'workStatus','OPEN') work_status
           from workspace_claims c
           join agent_sessions s on s.id=c.session_id
          where s.space_id=$1 and s.vault_id=$2 and c.status='ACTIVE'
            and coalesce(s.state->>'workStatus','OPEN') in ('COMPLETED','ABANDONED')
          order by c.id
          limit 500`,
        scope,
      );
      return rows.rows.map((row) =>
        finding(
          detector,
          "HIGH",
          "ORPHAN_ACTIVE_WORK",
          "workspace_claim",
          row.id,
          "An active claim remains attached to a completed or abandoned workspace.",
          {
            sessionId: row.session_id,
            workKey: row.work_key,
            workStatus: row.work_status,
          },
        ),
      );
    }
    case "EXPIRED_CLAIM": {
      const rows = await db.pool.query<{
        id: string;
        session_id: string;
        work_key: string;
        lease_expires_at: Date | string;
      }>(
        `select c.id,c.session_id,c.work_key,c.lease_expires_at
           from workspace_claims c
           join agent_sessions s on s.id=c.session_id
          where s.space_id=$1 and s.vault_id=$2 and c.status='ACTIVE'
            and c.lease_expires_at<=now()
          order by c.lease_expires_at
          limit 500`,
        scope,
      );
      return rows.rows.map((row) =>
        finding(
          detector,
          "WARN",
          "EXPIRED_WORKSPACE_CLAIM",
          "workspace_claim",
          row.id,
          "A workspace claim is still active after its lease expired.",
          {
            sessionId: row.session_id,
            workKey: row.work_key,
            leaseExpiresAt: new Date(row.lease_expires_at).toISOString(),
          },
        ),
      );
    }
    case "STALE_HANDOFF": {
      const rows = await db.pool.query<{
        id: string;
        claim_id: string;
        session_id: string;
        handoff_revision_hash: string;
        current_revision_hash: string;
      }>(
        `with latest_handoff as (
           select distinct on (e.claim_id)
                  e.id,e.claim_id,e.session_id,
                  e.payload->>'contextRevisionSetHash' handoff_revision_hash
             from workspace_events e
            where e.space_id=$1 and e.vault_id=$2
              and e.event_type='CLAIM_HANDOFF'
              and e.claim_id is not null
              and e.payload ? 'contextRevisionSetHash'
            order by e.claim_id,e.id desc
         )
         select h.id::text,h.claim_id::text,h.session_id::text,
                h.handoff_revision_hash,
                c.revision_set_hash current_revision_hash
           from latest_handoff h
           join workspace_context_revision_sets c on c.session_id=h.session_id
          where h.handoff_revision_hash<>c.revision_set_hash
          order by h.id
          limit 500`,
        scope,
      );
      return rows.rows.map((row) =>
        finding(
          detector,
          "HIGH",
          "STALE_WORKSPACE_HANDOFF",
          "workspace_event",
          row.id,
          "The latest structured handoff is pinned to an older context revision.",
          {
            claimId: row.claim_id,
            sessionId: row.session_id,
            handoffRevisionSetHash: row.handoff_revision_hash,
            currentRevisionSetHash: row.current_revision_hash,
          },
        ),
      );
    }
    case "UNSUPPORTED_CAUSALITY": {
      const rows = await db.pool.query<{
        id: string;
        derivation: string;
      }>(
        `select a.id::text,a.derivation
           from work_activity_events a
          where a.space_id=$1 and a.vault_id=$2 and a.action='CAUSED'
            and a.derivation not in (
              'SOURCE_EXPLICIT','HUMAN_ASSERTED','DYNAMICALLY_PROVEN'
            )
          order by a.id
          limit 500`,
        scope,
      );
      return rows.rows.map((row) =>
        finding(
          detector,
          "CRITICAL",
          "UNSUPPORTED_CAUSALITY",
          "work_activity_event",
          row.id,
          "A causal work-graph assertion lacks an allowed support derivation.",
          { derivation: row.derivation },
        ),
      );
    }
  }
}

function supportedDetector(
  detector: AssuranceDetector,
): detector is SupportedDetector {
  return (SUPPORTED_ASSURANCE_DETECTORS as readonly string[]).includes(
    detector,
  );
}

export async function runClaimedAssuranceRun(
  db: Postgres,
  run: AssuranceRun,
  workerId: string,
): Promise<"COMPLETED" | "RETRY" | "FAILED" | "FENCED"> {
  let detectorIndex = Math.max(0, run.cursor.detectorIndex);
  const counts: Record<string, number> = {};
  try {
    for (; detectorIndex < run.detectors.length; detectorIndex += 1) {
      const detector = run.detectors[detectorIndex]!;
      if (!supportedDetector(detector)) {
        throw new Error(`ASSURANCE_DETECTOR_NOT_IMPLEMENTED:${detector}`);
      }
      const findings = await collectDetectorFindings(db, run, detector);
      await appendAssuranceFindings(db, {
        runId: run.id,
        workerId,
        leaseToken: run.leaseToken,
        spaceId: run.spaceId,
        vaultId: run.vaultId,
        findings,
      });
      counts[detector] = findings.length;
      const renewed = await renewAssuranceRunLease(db, {
        runId: run.id,
        workerId,
        leaseToken: run.leaseToken,
        cursor: { detectorIndex: detectorIndex + 1 },
      });
      if (!renewed) return "FENCED";
    }
    const completed = await completeAssuranceRun(db, {
      runId: run.id,
      workerId,
      leaseToken: run.leaseToken,
      cursor: { detectorIndex },
      summary: {
        detectorCounts: counts,
        supportedDetectors: [...SUPPORTED_ASSURANCE_DETECTORS],
      },
    });
    return completed ? "COMPLETED" : "FENCED";
  } catch (error) {
    return failAssuranceRun(db, {
      runId: run.id,
      workerId,
      leaseToken: run.leaseToken,
      error,
      cursor: { detectorIndex },
    });
  }
}
