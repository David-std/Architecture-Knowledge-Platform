import {
  IMPLEMENTED_ASSURANCE_DETECTORS,
  type AssuranceDetector,
  type AssuranceFindingDraft,
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

const DETECTOR_CATEGORY: Record<SupportedDetector, string> = {
  GROUNDING: "GROUNDING",
  FRESHNESS: "FRESHNESS",
  CONTRADICTION: "CONTRADICTION",
  DUPLICATE_IDENTITY: "IDENTITY",
  GRAPH_HEALTH: "GRAPH_HEALTH",
  TEMPORAL_CONSISTENCY: "TEMPORAL_CONSISTENCY",
  CODE_GRAPH_FRESHNESS: "CODE_GRAPH_FRESHNESS",
  LINK_GAP: "LINK_GAP",
  SYNTHESIS_CANDIDATE: "SYNTHESIS_CANDIDATE",
  ACCESS_BOUNDARY: "ACCESS_BOUNDARY",
  CONNECTOR_DELETION: "CONNECTOR",
  CONNECTOR_FRESHNESS: "CONNECTOR",
  CONNECTOR_ACL_DRIFT: "ACCESS_BOUNDARY",
  GRAPH_DISAGREEMENT: "GRAPH_HEALTH",
  ORPHAN_WORK: "WORKSPACE",
  EXPIRED_CLAIM: "WORKSPACE",
  STALE_HANDOFF: "WORKSPACE",
  UNSUPPORTED_CAUSALITY: "WORK_GRAPH",
};

const DETECTOR_PROPOSED_ACTION: Partial<Record<SupportedDetector, string>> = {
  GROUNDING: "RECOMPILE",
  FRESHNESS: "RECOMPILE",
  CONTRADICTION: "PROMOTION",
  DUPLICATE_IDENTITY: "PROMOTION",
  GRAPH_HEALTH: "REINDEX",
  CODE_GRAPH_FRESHNESS: "REINDEX",
  LINK_GAP: "PROMOTION",
  SYNTHESIS_CANDIDATE: "PROMOTION",
  CONNECTOR_DELETION: "REINDEX",
  CONNECTOR_FRESHNESS: "REINDEX",
  CONNECTOR_ACL_DRIFT: "REVIEW",
  GRAPH_DISAGREEMENT: "REINDEX",
  STALE_HANDOFF: "REVIEW",
};

function findingForScope(
  scopeId: string,
  detector: SupportedDetector,
  severity: AssuranceFindingDraft["severity"],
  code: string,
  subjectKind: string,
  subjectId: string,
  summary: string,
  metadata: Record<string, unknown> = {},
  evidenceIds: string[] = [],
  supportSetIds: string[] = [],
  revisionSet?: Record<string, string | null | undefined>,
): AssuranceFindingDraft {
  return {
    detector,
    detectorVersion: "1.0.0",
    severity,
    category: DETECTOR_CATEGORY[detector],
    scopeId,
    targetIds: [subjectId],
    evidenceIds,
    supportSetIds,
    code,
    summary,
    ...(DETECTOR_PROPOSED_ACTION[detector]
      ? { proposedAction: DETECTOR_PROPOSED_ACTION[detector] }
      : {}),
    ...(revisionSet ? { revisionSet } : {}),
    metadata: {
      subjectKind,
      ...metadata,
    },
  };
}

async function collectDetectorFindings(
  db: Postgres,
  run: AssuranceRun,
  detector: SupportedDetector,
): Promise<AssuranceFindingDraft[]> {
  const scope = [run.spaceId, run.vaultId];
  switch (detector) {
    case "GROUNDING": {
      const missing = await db.pool.query<{
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

      const invalidEvidence = await db.pool.query<{
        document_id: string;
        path: string;
        evidence_id: string;
        source_id: string;
        reason: string;
      }>(
        `select distinct
                d.id document_id,d.path,e.id evidence_id,s.id source_id,
                case
                  when ei.id is not null then 'EVIDENCE_INVALIDATED'
                  when nullif(e.locator->>'source_hash','') is not null
                   and e.locator->>'source_hash'<>s.sha256
                    then 'LOCATOR_SOURCE_HASH_MISMATCH'
                  when sa.id is not null and sa.source_hash<>s.sha256
                    then 'ARTIFACT_SOURCE_HASH_MISMATCH'
                  when sa.document_artifact is not null
                   and jsonb_typeof(sa.document_artifact->'locators')='array'
                   and not (
                     (sa.document_artifact->'locators')
                     @> jsonb_build_array(e.locator)
                   )
                    then 'EVIDENCE_LOCATOR_NOT_RESOLVING'
                  else 'EVIDENCE_INTEGRITY_INVALID'
                end reason
           from knowledge_documents d
           join document_evidence de on de.document_id=d.id
           join evidence e on e.id=de.evidence_id
           join sources s on s.id=e.source_id
           left join source_artifacts sa on sa.id=e.artifact_id
           left join evidence_invalidations ei
             on ei.evidence_id=e.id
            and ei.space_id=d.space_id
            and ei.vault_id=d.vault_id
          where d.space_id=$1 and d.vault_id=$2
            and d.lifecycle in ('ACTIVE','DISPUTED')
            and (
              ei.id is not null
              or (
                nullif(e.locator->>'source_hash','') is not null
                and e.locator->>'source_hash'<>s.sha256
              )
              or (sa.id is not null and sa.source_hash<>s.sha256)
              or (
                sa.document_artifact is not null
                and jsonb_typeof(sa.document_artifact->'locators')='array'
                and not (
                  (sa.document_artifact->'locators')
                  @> jsonb_build_array(e.locator)
                )
              )
            )
          order by d.id,e.id
          limit 500`,
        scope,
      );

      const invalidDerivedSupport = await db.pool.query<{
        derived_store_kind: string;
        derived_item_ref: string;
        state: string;
        support_set_id: string | null;
        truth_revision_hash: string;
      }>(
        `with latest as (
           select distinct on (i.derived_store_kind,i.derived_item_ref)
                  i.derived_store_kind,i.derived_item_ref,i.state,i.valid,
                  i.dependency_id,i.truth_revision_hash,i.truth_revision_seq,
                  i.created_at
             from derived_truth_projection_items i
            where i.space_id=$1 and i.vault_id=$2
            order by i.derived_store_kind,i.derived_item_ref,
                     i.truth_revision_seq desc,i.created_at desc
         )
         select l.derived_store_kind,l.derived_item_ref,l.state,
                d.support_set_id::text,l.truth_revision_hash
           from latest l
           left join derived_truth_dependencies d on d.id=l.dependency_id
          where l.valid=false or l.state='UNSUPPORTED'
          order by l.derived_store_kind,l.derived_item_ref
          limit 500`,
        scope,
      );

      return [
        ...missing.rows.map((row) =>
          findingForScope(
            run.vaultId,
            detector,
            "HIGH",
            "UNGROUNDED_ACTIVE_KNOWLEDGE",
            "knowledge_document",
            row.id,
            "Active knowledge has no document evidence link.",
            { path: row.path },
          ),
        ),
        ...invalidEvidence.rows.map((row) =>
          findingForScope(
            run.vaultId,
            detector,
            "CRITICAL",
            row.reason,
            "knowledge_document",
            row.document_id,
            "Approved knowledge references evidence whose provenance integrity is no longer valid.",
            {
              path: row.path,
              sourceId: row.source_id,
              integrityReason: row.reason,
            },
            [row.evidence_id],
          ),
        ),
        ...invalidDerivedSupport.rows.map((row) =>
          findingForScope(
            run.vaultId,
            detector,
            "HIGH",
            "DERIVED_SUPPORT_INVALID",
            row.derived_store_kind,
            row.derived_item_ref,
            "Derived content is backed by a truth projection whose latest support state is invalid.",
            {
              state: row.state,
              truthRevisionHash: row.truth_revision_hash,
            },
            [],
            row.support_set_id ? [row.support_set_id] : [],
            { truth: row.truth_revision_hash },
          ),
        ),
      ];
    }
    case "FRESHNESS": {
      const documents = await db.pool.query<{
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

      const removedSources = await db.pool.query<{
        document_id: string;
        path: string;
        source_id: string;
      }>(
        `select distinct d.id document_id,d.path,s.id source_id
           from knowledge_documents d
           join document_evidence de on de.document_id=d.id
           join evidence e on e.id=de.evidence_id
           join sources s on s.id=e.source_id
          where d.space_id=$1 and d.vault_id=$2
            and d.lifecycle in ('ACTIVE','DISPUTED')
            and (
              s.status<>'ACTIVE'
              or exists(
                select 1
                  from source_episodes se
                  join source_episode_withdrawals sw
                    on sw.source_episode_id=se.id
                 where se.space_id=$1 and se.vault_id=$2
                   and se.source_id=s.id
              )
            )
          order by d.id,s.id
          limit 500`,
        scope,
      );

      const profile = await db.pool.query<{
        profile_revision_id: string;
        profile_id: string;
        version: string;
        activated_at: Date | string;
        index_updated_at: Date | string | null;
      }>(
        `select p.id profile_revision_id,p.profile_id,p.version,p.activated_at,
                i.updated_at index_updated_at
           from vaults v
           join knowledge_profile_revisions p
             on p.id=v.active_knowledge_profile_revision_id
           left join vault_index_revisions i
             on i.space_id=v.space_id and i.vault_id=v.id
          where v.space_id=$1 and v.id=$2
            and p.status='ACTIVE'
            and p.activated_at is not null
            and (i.updated_at is null or p.activated_at>i.updated_at)
          limit 1`,
        scope,
      );

      const revisions = await db.pool.query<{
        corpus_revision: string;
        lexical_revision: string | null;
        vector_revision: string | null;
        graph_revision: string | null;
        context_pack_revision: string | null;
      }>(
        `select corpus_revision,lexical_revision,vector_revision,
                graph_revision,context_pack_revision
           from vault_index_revisions
          where space_id=$1 and vault_id=$2
          limit 1`,
        scope,
      );

      const communities = await db.pool.query<{
        id: string;
        community_revision: string;
        graph_revision: string;
        current_graph_revision: string;
      }>(
        `select r.id::text,r.community_revision,r.graph_revision,
                i.graph_revision current_graph_revision
           from community_index_revisions r
           join vault_index_revisions i
             on i.space_id=r.space_id and i.vault_id=r.vault_id
          where r.space_id=$1 and r.vault_id=$2
            and r.status in ('ACTIVE','STALE')
            and i.graph_revision is not null
            and (
              r.stale=true
              or r.status='STALE'
              or r.graph_revision<>i.graph_revision
            )
          order by r.updated_at desc
          limit 500`,
        scope,
      );

      const projectionFindings: AssuranceFindingDraft[] = [];
      const revision = revisions.rows[0];
      if (revision) {
        const channels: Array<[string, string | null]> = [
          ["lexical", revision.lexical_revision],
          ["vector", revision.vector_revision],
          ["graph", revision.graph_revision],
          ["contextPack", revision.context_pack_revision],
        ];
        for (const [channel, channelRevision] of channels) {
          if (
            channelRevision !== null &&
            channelRevision !== revision.corpus_revision
          ) {
            projectionFindings.push(
              findingForScope(
                run.vaultId,
                detector,
                "HIGH",
                "PROJECTION_REVISION_STALE",
                "vault_projection",
                `${run.vaultId}:${channel}`,
                "A materialized projection is behind the current corpus revision.",
                {
                  channel,
                  corpusRevision: revision.corpus_revision,
                  projectionRevision: channelRevision,
                },
              ),
            );
          }
        }
      }

      return [
        ...documents.rows.map((row) =>
          findingForScope(
            run.vaultId,
            detector,
            row.refresh_status === "INVALID" ? "HIGH" : "MEDIUM",
            "STALE_KNOWLEDGE",
            "knowledge_document",
            row.id,
            "Knowledge is not current against its governed source state.",
            {
              refreshStatus: row.refresh_status,
              staleReason: row.stale_reason,
            },
          ),
        ),
        ...removedSources.rows.map((row) =>
          findingForScope(
            run.vaultId,
            detector,
            "HIGH",
            "DEPENDENCY_SOURCE_REMOVED",
            "knowledge_document",
            row.document_id,
            "Knowledge depends on a source that is withdrawn or no longer active.",
            { path: row.path, sourceId: row.source_id },
          ),
        ),
        ...profile.rows.map((row) =>
          findingForScope(
            run.vaultId,
            detector,
            "HIGH",
            "PROFILE_CHANGED_AFTER_PROJECTION",
            "knowledge_profile_revision",
            row.profile_revision_id,
            "The active Knowledge Profile was activated after the vault projection state was last updated.",
            {
              profileId: row.profile_id,
              version: row.version,
              activatedAt: new Date(row.activated_at).toISOString(),
              indexUpdatedAt: row.index_updated_at
                ? new Date(row.index_updated_at).toISOString()
                : null,
            },
          ),
        ),
        ...projectionFindings,
        ...communities.rows.map((row) =>
          findingForScope(
            run.vaultId,
            detector,
            "HIGH",
            "COMMUNITY_BEHIND_GRAPH_REVISION",
            "community_index_revision",
            row.id,
            "A community summary revision is stale against the active graph revision.",
            {
              communityRevision: row.community_revision,
              communityGraphRevision: row.graph_revision,
              activeGraphRevision: row.current_graph_revision,
            },
            [],
            [],
            {
              community: row.community_revision,
              graph: row.current_graph_revision,
            },
          ),
        ),
      ];
    }
    case "CONTRADICTION": {
      const clusters = await db.pool.query<{
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

      const facts = await db.pool.query<{
        left_id: string;
        right_id: string;
        subject_ref: string;
        predicate: string;
        left_support_set_id: string;
        right_support_set_id: string;
      }>(
        `select f1.id::text left_id,f2.id::text right_id,
                f1.subject_ref,f1.predicate,
                f1.support_set_id::text left_support_set_id,
                f2.support_set_id::text right_support_set_id
           from temporal_facts f1
           join temporal_facts f2
             on f2.space_id=f1.space_id
            and f2.vault_id=f1.vault_id
            and f2.scope_id=f1.scope_id
            and f2.subject_ref=f1.subject_ref
            and f2.predicate=f1.predicate
            and f2.id::text>f1.id::text
            and f2.object<>f1.object
            and f1.valid_from<coalesce(f2.valid_to,'infinity'::timestamptz)
            and f2.valid_from<coalesce(f1.valid_to,'infinity'::timestamptz)
          where f1.space_id=$1 and f1.vault_id=$2
            and f1.lifecycle in ('ACTIVE','DISPUTED')
            and f2.lifecycle in ('ACTIVE','DISPUTED')
          order by f1.subject_ref,f1.predicate,f1.id,f2.id
          limit 500`,
        scope,
      );

      return [
        ...clusters.rows.map((row) =>
          findingForScope(
            run.vaultId,
            detector,
            "MEDIUM",
            "OPEN_CONTRADICTION",
            "contradiction_cluster",
            row.id,
            "Contradictory knowledge remains unresolved.",
            { topic: row.topic, status: row.status },
          ),
        ),
        ...facts.rows.map((row) => ({
          ...findingForScope(
            run.vaultId,
            detector,
            "HIGH",
            "SUPPORTED_TEMPORAL_FACT_CONTRADICTION",
            "temporal_fact_pair",
            `${row.left_id}:${row.right_id}`,
            "Supported temporal facts make incompatible claims over the same validity interval.",
            {
              subjectRef: row.subject_ref,
              predicate: row.predicate,
              winnerSelected: false,
            },
            [],
            [row.left_support_set_id, row.right_support_set_id],
          ),
          targetIds: [row.left_id, row.right_id],
        })),
      ];
    }
    case "DUPLICATE_IDENTITY": {
      const rows = await db.pool.query<{
        normalized_identity: string;
        document_ids: string[];
        signals: string[];
      }>(
        `with identities as (
           select d.id::text document_id,
                  signal.kind,
                  signal.value,
                  regexp_replace(lower(btrim(signal.value)),
                                 '[^a-z0-9]+','','g') normalized_identity
             from knowledge_documents d
             cross join lateral (
               values
                 ('external_id',coalesce(d.external_id,'')),
                 ('path',d.path),
                 ('title',d.title)
             ) signal(kind,value)
            where d.space_id=$1 and d.vault_id=$2
              and d.lifecycle in ('ACTIVE','DISPUTED')
              and btrim(signal.value)<>''
           union all
           select d.id::text,'alias',alias,
                  regexp_replace(lower(btrim(alias)),
                                 '[^a-z0-9]+','','g')
             from knowledge_documents d
             cross join lateral unnest(d.aliases) alias
            where d.space_id=$1 and d.vault_id=$2
              and d.lifecycle in ('ACTIVE','DISPUTED')
              and btrim(alias)<>''
         )
         select normalized_identity,
                array_agg(distinct document_id order by document_id)
                  document_ids,
                array_agg(distinct kind||':'||value order by kind||':'||value)
                  signals
           from identities
          where length(normalized_identity)>=4
          group by normalized_identity
         having count(distinct document_id)>1
          order by normalized_identity
          limit 500`,
        scope,
      );
      return rows.rows.map((row) => ({
        ...findingForScope(
          run.vaultId,
          detector,
          "HIGH",
          "AMBIGUOUS_KNOWLEDGE_IDENTITY",
          "knowledge_identity",
          row.normalized_identity,
          "Multiple active knowledge documents share a normalized path/title/alias identity signal.",
          { signals: row.signals },
        ),
        targetIds: row.document_ids,
      }));
    }
    case "GRAPH_HEALTH": {
      const revisionMismatch = await db.pool.query<{
        corpus_revision: string;
        graph_revision: string | null;
      }>(
        `select corpus_revision,graph_revision
           from vault_index_revisions
          where space_id=$1 and vault_id=$2
            and (graph_revision is null or graph_revision<>corpus_revision)`,
        scope,
      );

      const unhealthyProjections = await db.pool.query<{
        id: string;
        graph_domain: string;
        scope_id: string;
        revision: string;
        source_revision: string;
        lifecycle: string;
        freshness: string;
        built_at: Date | string | null;
        activated_at: Date | string | null;
      }>(
        `select id::text,graph_domain,scope_id,revision,source_revision,
                lifecycle,freshness,built_at,activated_at
           from federated_graph_projection_revisions
          where space_id=$1 and vault_id=$2
            and (
              lifecycle in ('STALE','FAILED')
              or freshness='STALE'
              or (
                lifecycle in ('BUILT','ACTIVE','STALE')
                and built_at is null
              )
              or (
                lifecycle='ACTIVE'
                and activated_at is null
              )
            )
          order by updated_at desc,id
          limit 500`,
        scope,
      );

      const orphanNodes = await db.pool.query<{
        id: string;
        graph_domain: string;
        scope_id: string;
        kind: string;
        canonical_key: string;
        projection_id: string;
      }>(
        `select n.id::text,n.graph_domain,n.scope_id,n.kind,n.canonical_key,
                p.id::text projection_id
           from federated_graph_projection_revisions p
           join federated_graph_projection_nodes pn
             on pn.projection_revision_id=p.id
           join federated_graph_nodes n on n.id=pn.node_id
          where p.space_id=$1 and p.vault_id=$2
            and p.lifecycle='ACTIVE' and p.freshness='FRESH'
            and not exists(
              select 1
                from federated_graph_projection_edges pe
                join federated_graph_edges e on e.id=pe.edge_id
               where pe.projection_revision_id=p.id
                 and (e.from_node_id=n.id or e.to_node_id=n.id)
            )
          order by n.graph_domain,n.scope_id,n.id
          limit 500`,
        scope,
      );

      const crossScopeEdges = await db.pool.query<{
        id: string;
        owner_graph_domain: string;
        from_node_id: string;
        to_node_id: string;
        from_vault_id: string | null;
        to_vault_id: string | null;
      }>(
        `select e.id::text,e.owner_graph_domain,
                e.from_node_id::text,e.to_node_id::text,
                f.vault_id::text from_vault_id,
                t.vault_id::text to_vault_id
           from federated_graph_edges e
           join federated_graph_nodes f on f.id=e.from_node_id
           join federated_graph_nodes t on t.id=e.to_node_id
          where e.space_id=$1
            and (
              f.space_id<>e.space_id
              or t.space_id<>e.space_id
              or (
                f.vault_id is not null
                and t.vault_id is not null
                and f.vault_id<>t.vault_id
              )
            )
            and (
              f.vault_id=$2
              or t.vault_id=$2
            )
          order by e.id
          limit 500`,
        scope,
      );

      const staleRelations = await db.pool.query<{
        edge_id: string;
        projection_id: string;
        projection_revision: string;
        provenance_revision: string;
        graph_domain: string;
      }>(
        `select e.id::text edge_id,p.id::text projection_id,
                p.revision projection_revision,
                e.provenance_revision,
                p.graph_domain
           from federated_graph_projection_revisions p
           join federated_graph_projection_edges pe
             on pe.projection_revision_id=p.id
           join federated_graph_edges e on e.id=pe.edge_id
          where p.space_id=$1 and p.vault_id=$2
            and p.lifecycle='ACTIVE'
            and e.owner_graph_domain=p.graph_domain
            and e.provenance_revision<>p.revision
          order by e.id
          limit 500`,
        scope,
      );

      const unresolvedBridges = await db.pool.query<{
        edge_id: string;
        target_node_id: string;
        scope_id: string;
        canonical_key: string;
      }>(
        `select e.id::text edge_id,t.id::text target_node_id,
                t.scope_id,t.canonical_key
           from federated_graph_projection_revisions bridge
           join federated_graph_projection_edges pe
             on pe.projection_revision_id=bridge.id
           join federated_graph_edges e on e.id=pe.edge_id
           join federated_graph_nodes t on t.id=e.to_node_id
          where bridge.space_id=$1 and bridge.vault_id=$2
            and bridge.lifecycle='ACTIVE'
            and bridge.provider='human-reviewed-code-link'
            and t.graph_domain='CODE'
            and not exists(
              select 1
                from federated_graph_projection_nodes target_membership
                join federated_graph_projection_revisions code_projection
                  on code_projection.id=target_membership.projection_revision_id
               where target_membership.node_id=t.id
                 and code_projection.space_id=$1
                 and code_projection.vault_id=$2
                 and code_projection.graph_domain='CODE'
                 and code_projection.lifecycle='ACTIVE'
                 and code_projection.freshness='FRESH'
            )
          order by e.id
          limit 500`,
        scope,
      );

      return [
        ...revisionMismatch.rows.map((row) =>
          findingForScope(
            run.vaultId,
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
        ),
        ...unhealthyProjections.rows.map((row) => {
          const lifecycleInvalid =
            (["BUILT", "ACTIVE", "STALE"].includes(row.lifecycle) &&
              !row.built_at) ||
            (row.lifecycle === "ACTIVE" && !row.activated_at);
          return findingForScope(
            run.vaultId,
            detector,
            row.lifecycle === "FAILED" || lifecycleInvalid
              ? "CRITICAL"
              : "HIGH",
            lifecycleInvalid
              ? "GRAPH_PROJECTION_LIFECYCLE_INVALID"
              : row.lifecycle === "FAILED"
                ? "GRAPH_PROJECTION_FAILED"
                : "GRAPH_PROJECTION_STALE",
            "graph_projection",
            row.id,
            lifecycleInvalid
              ? "A graph projection has an impossible lifecycle timestamp state."
              : "A graph projection is failed or stale and cannot be treated as current.",
            {
              graphDomain: row.graph_domain,
              scopeId: row.scope_id,
              revision: row.revision,
              sourceRevision: row.source_revision,
              lifecycle: row.lifecycle,
              freshness: row.freshness,
              builtAt: row.built_at
                ? new Date(row.built_at).toISOString()
                : null,
              activatedAt: row.activated_at
                ? new Date(row.activated_at).toISOString()
                : null,
            },
          );
        }),
        ...orphanNodes.rows.map((row) =>
          findingForScope(
            run.vaultId,
            detector,
            "MEDIUM",
            "GRAPH_ORPHAN_NODE",
            "graph_node",
            row.id,
            "An active graph node has no edge in its active projection.",
            {
              graphDomain: row.graph_domain,
              scopeId: row.scope_id,
              kind: row.kind,
              canonicalKey: row.canonical_key,
              projectionId: row.projection_id,
            },
          ),
        ),
        ...crossScopeEdges.rows.map((row) =>
          findingForScope(
            run.vaultId,
            detector,
            "CRITICAL",
            "FORBIDDEN_CROSS_VAULT_EDGE",
            "graph_edge",
            row.id,
            "A graph edge crosses vault scope without a same-vault boundary.",
            {
              ownerGraphDomain: row.owner_graph_domain,
              fromNodeId: row.from_node_id,
              toNodeId: row.to_node_id,
              fromVaultId: row.from_vault_id,
              toVaultId: row.to_vault_id,
            },
          ),
        ),
        ...staleRelations.rows.map((row) =>
          findingForScope(
            run.vaultId,
            detector,
            "HIGH",
            "STALE_GRAPH_RELATION",
            "graph_edge",
            row.edge_id,
            "An edge in an active graph projection carries provenance from a different projection revision.",
            {
              graphDomain: row.graph_domain,
              projectionId: row.projection_id,
              projectionRevision: row.projection_revision,
              provenanceRevision: row.provenance_revision,
            },
          ),
        ),
        ...unresolvedBridges.rows.map((row) =>
          findingForScope(
            run.vaultId,
            detector,
            "HIGH",
            "UNRESOLVED_CODE_BRIDGE_TARGET",
            "graph_edge",
            row.edge_id,
            "A reviewed knowledge-to-code bridge targets a node that is absent from the active fresh Code Graph.",
            {
              targetNodeId: row.target_node_id,
              scopeId: row.scope_id,
              canonicalKey: row.canonical_key,
            },
          ),
        ),
      ];
    }
    case "TEMPORAL_CONSISTENCY": {
      const heads = await db.pool.query<{
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

      const overlaps = await db.pool.query<{
        left_id: string;
        right_id: string;
        subject_ref: string;
        predicate: string;
      }>(
        `select f1.id::text left_id,f2.id::text right_id,
                f1.subject_ref,f1.predicate
           from temporal_facts f1
           join temporal_facts f2
             on f2.space_id=f1.space_id
            and f2.vault_id=f1.vault_id
            and f2.scope_id=f1.scope_id
            and f2.subject_ref=f1.subject_ref
            and f2.predicate=f1.predicate
            and f2.id::text>f1.id::text
            and f2.object<>f1.object
            and f1.valid_from<coalesce(f2.valid_to,'infinity'::timestamptz)
            and f2.valid_from<coalesce(f1.valid_to,'infinity'::timestamptz)
          where f1.space_id=$1 and f1.vault_id=$2
            and f1.lifecycle in ('ACTIVE','DISPUTED')
            and f2.lifecycle in ('ACTIVE','DISPUTED')
          order by f1.subject_ref,f1.predicate,f1.id,f2.id
          limit 500`,
        scope,
      );

      const supersessions = await db.pool.query<{
        id: string;
        old_fact_id: string;
        new_fact_id: string;
        old_subject: string;
        new_subject: string;
        old_predicate: string;
        new_predicate: string;
        old_revision_seq: number;
        new_revision_seq: number;
        supersession_revision_seq: number;
      }>(
        `select s.id::text,s.old_fact_id::text,s.new_fact_id::text,
                old.subject_ref old_subject,new.subject_ref new_subject,
                old.predicate old_predicate,new.predicate new_predicate,
                old.truth_revision_seq old_revision_seq,
                new.truth_revision_seq new_revision_seq,
                s.truth_revision_seq supersession_revision_seq
           from temporal_fact_supersessions s
           join temporal_facts old on old.id=s.old_fact_id
           join temporal_facts new on new.id=s.new_fact_id
          where s.space_id=$1 and s.vault_id=$2
            and (
              old.subject_ref<>new.subject_ref
              or old.predicate<>new.predicate
              or new.truth_revision_seq<=old.truth_revision_seq
              or s.truth_revision_seq<new.truth_revision_seq
              or s.recorded_at<old.recorded_at
              or s.recorded_at<new.recorded_at
            )
          order by s.id
          limit 500`,
        scope,
      );

      return [
        ...heads.rows.map((row) =>
          findingForScope(
            run.vaultId,
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
        ),
        ...overlaps.rows.map((row) => ({
          ...findingForScope(
            run.vaultId,
            detector,
            "CRITICAL",
            "INCOMPATIBLE_VALIDITY_OVERLAP",
            "temporal_fact_pair",
            `${row.left_id}:${row.right_id}`,
            "Incompatible temporal facts overlap for the same subject and predicate.",
            {
              subjectRef: row.subject_ref,
              predicate: row.predicate,
            },
          ),
          targetIds: [row.left_id, row.right_id],
        })),
        ...supersessions.rows.map((row) => ({
          ...findingForScope(
            run.vaultId,
            detector,
            "CRITICAL",
            "IMPOSSIBLE_FACT_SUPERSESSION",
            "temporal_fact_supersession",
            row.id,
            "A fact supersession violates subject/predicate or revision ordering invariants.",
            {
              oldSubject: row.old_subject,
              newSubject: row.new_subject,
              oldPredicate: row.old_predicate,
              newPredicate: row.new_predicate,
              oldRevisionSequence: Number(row.old_revision_seq),
              newRevisionSequence: Number(row.new_revision_seq),
              supersessionRevisionSequence: Number(
                row.supersession_revision_seq,
              ),
            },
          ),
          targetIds: [row.old_fact_id, row.new_fact_id],
        })),
      ];
    }
    case "CODE_GRAPH_FRESHNESS": {
      const projects = await db.pool.query<{
        project_id: string;
        slug: string;
        project_commit: string | null;
        code_status: string | null;
        code_error: string | null;
        active_projection_id: string | null;
        active_source_revision: string | null;
        active_freshness: string | null;
        latest_projection_id: string | null;
        latest_lifecycle: string | null;
      }>(
        `select p.id::text project_id,p.slug,
                p.metadata->>'commit' project_commit,
                p.metadata#>>'{codeGraph,status}' code_status,
                p.metadata#>>'{codeGraph,errorCode}' code_error,
                active.id::text active_projection_id,
                active.source_revision active_source_revision,
                active.freshness active_freshness,
                latest.id::text latest_projection_id,
                latest.lifecycle latest_lifecycle
           from projects p
           left join lateral (
             select g.id,g.source_revision,g.freshness,g.lifecycle
               from federated_graph_projection_revisions g
              where g.space_id=p.space_id
                and g.vault_id=p.vault_id
                and g.graph_domain='CODE'
                and g.scope_id=
                    'project:'||lower(p.vault_id::text)||':'||lower(p.slug)
                and g.lifecycle='ACTIVE'
              order by g.activated_at desc nulls last,g.updated_at desc
              limit 1
           ) active on true
           left join lateral (
             select g.id,g.lifecycle,g.updated_at
               from federated_graph_projection_revisions g
              where g.space_id=p.space_id
                and g.vault_id=p.vault_id
                and g.graph_domain='CODE'
                and g.scope_id=
                    'project:'||lower(p.vault_id::text)||':'||lower(p.slug)
              order by g.updated_at desc,g.created_at desc
              limit 1
           ) latest on true
          where p.space_id=$1 and p.vault_id=$2
            and p.metadata->>'commit' ~ '^[a-fA-F0-9]{40}$'
            and coalesce(p.metadata#>>'{codeGraph,status}','REQUESTED')
                <>'DISABLED'
          order by p.id
          limit 500`,
        scope,
      );

      const findings: AssuranceFindingDraft[] = [];
      for (const row of projects.rows) {
        const commit = row.project_commit?.toLowerCase() ?? null;
        if (
          row.code_status === "FAILED" ||
          row.code_status === "DEGRADED" ||
          row.latest_lifecycle === "FAILED"
        ) {
          findings.push(
            findingForScope(
              run.vaultId,
              detector,
              "CRITICAL",
              "CODE_GRAPH_EXTRACTOR_FAILED",
              "project",
              row.project_id,
              "The latest Code Graph extraction failed or degraded for the current project.",
              {
                slug: row.slug,
                projectCommit: commit,
                codeGraphStatus: row.code_status,
                errorCode: row.code_error,
                latestProjectionId: row.latest_projection_id,
                latestLifecycle: row.latest_lifecycle,
              },
            ),
          );
          continue;
        }
        if (!row.active_projection_id) {
          findings.push(
            findingForScope(
              run.vaultId,
              detector,
              "HIGH",
              "CODE_GRAPH_MISSING",
              "project",
              row.project_id,
              "A project with Code Graph enabled has no active indexed repository projection.",
              {
                slug: row.slug,
                projectCommit: commit,
                codeGraphStatus: row.code_status,
              },
            ),
          );
          continue;
        }
        if (
          commit &&
          row.active_source_revision?.toLowerCase() !== commit
        ) {
          findings.push(
            findingForScope(
              run.vaultId,
              detector,
              "CRITICAL",
              "CODE_GRAPH_REPO_SHA_MISMATCH",
              "project",
              row.project_id,
              "The active Code Graph source revision does not match the project's immutable repository commit.",
              {
                slug: row.slug,
                projectCommit: commit,
                activeSourceRevision: row.active_source_revision,
                activeProjectionId: row.active_projection_id,
              },
            ),
          );
          continue;
        }
        if (row.active_freshness !== "FRESH") {
          findings.push(
            findingForScope(
              run.vaultId,
              detector,
              "HIGH",
              "CODE_GRAPH_STALE",
              "graph_projection",
              row.active_projection_id,
              "The active Code Graph projection is marked stale.",
              {
                slug: row.slug,
                projectCommit: commit,
                activeSourceRevision: row.active_source_revision,
                freshness: row.active_freshness,
              },
            ),
          );
        }
      }
      return findings;
    }
    case "LINK_GAP": {
      const orphaned = await db.pool.query<{
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

      const missingRelations = await db.pool.query<{
        source_id: string;
        source_path: string;
        target_text: string;
        target_id: string;
        target_path: string;
      }>(
        `with raw as (
           select d.id source_id,d.path source_path,
                  link.target_text
             from knowledge_documents d
             cross join lateral jsonb_array_elements_text(
               case
                 when jsonb_typeof(d.raw_links)='array' then d.raw_links
                 else '[]'::jsonb
               end
             ) link(target_text)
            where d.space_id=$1 and d.vault_id=$2
              and d.lifecycle='ACTIVE'
         ),
         candidates as (
           select r.source_id,r.source_path,r.target_text,
                  c.id target_id,c.path target_path
             from raw r
             join knowledge_documents c
               on c.space_id=$1 and c.vault_id=$2
              and c.lifecycle in ('ACTIVE','DISPUTED')
              and c.id<>r.source_id
              and (
                lower(coalesce(c.external_id,''))=lower(r.target_text)
                or lower(regexp_replace(c.path,'\\.md$','','i'))=
                   lower(r.target_text)
                or exists(
                  select 1
                    from unnest(c.aliases) alias
                   where lower(alias)=lower(r.target_text)
                )
                or lower(
                     regexp_replace(
                       regexp_replace(c.path,'\\.md$','','i'),
                       '^.*/','',''
                     )
                   )=
                   lower(regexp_replace(r.target_text,'^.*/','',''))
              )
         ),
         unique_candidates as (
           select source_id,source_path,target_text,
                  min(target_id::text)::uuid target_id,
                  min(target_path) target_path
             from candidates
            group by source_id,source_path,target_text
           having count(distinct target_id)=1
         )
         select u.source_id::text,u.source_path,u.target_text,
                u.target_id::text,u.target_path
           from unique_candidates u
          where not exists(
            select 1
              from knowledge_relations relation
             where relation.space_id=$1
               and relation.from_document_id=u.source_id
               and relation.to_document_id=u.target_id
          )
          order by u.source_id,u.target_text
          limit 500`,
        scope,
      );

      return [
        ...orphaned.rows.map((row) =>
          findingForScope(
            run.vaultId,
            detector,
            "MEDIUM",
            "ORPHAN_ACTIVE_KNOWLEDGE",
            "knowledge_document",
            row.id,
            "Active knowledge is disconnected from the governed knowledge graph.",
            { path: row.path },
          ),
        ),
        ...missingRelations.rows.map((row) => ({
          ...findingForScope(
            run.vaultId,
            detector,
            "MEDIUM",
            "MISSING_RESOLVED_LINK_RELATION",
            "knowledge_link_candidate",
            `${row.source_id}:${row.target_id}`,
            "A raw knowledge link resolves uniquely to approved knowledge but has no governed relation.",
            {
              sourcePath: row.source_path,
              targetText: row.target_text,
              targetPath: row.target_path,
            },
          ),
          targetIds: [row.source_id, row.target_id],
        })),
      ];
    }
    case "SYNTHESIS_CANDIDATE": {
      const rows = await db.pool.query<{
        revision_id: string;
        community_key: string;
        member_count: number;
        community_revision: string;
        graph_revision: string;
        support_set: Record<string, unknown>;
      }>(
        `select c.revision_id::text,c.community_key,c.member_count,
                r.community_revision,r.graph_revision,c.support_set
           from community_index_communities c
           join community_index_revisions r on r.id=c.revision_id
          where r.space_id=$1 and r.vault_id=$2
            and r.status='ACTIVE' and r.stale=false
            and c.member_count>=3
          order by c.member_count desc,c.community_key
          limit 200`,
        scope,
      );
      return rows.rows.map((row) =>
        findingForScope(
          run.vaultId,
          detector,
          "INFO",
          "SYNTHESIS_CANDIDATE",
          "community",
          `${row.revision_id}:${row.community_key}`,
          "An active derived community has enough approved members to warrant human review for a synthesis document.",
          {
            communityKey: row.community_key,
            memberCount: row.member_count,
            summaryAuthority: "DERIVED_INDEX_NON_CITABLE",
          },
          [],
          [],
          {
            community: row.community_revision,
            graph: row.graph_revision,
          },
        ),
      );
    }
    case "ACCESS_BOUNDARY": {
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
        findingForScope(
          run.vaultId,
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
        findingForScope(
          run.vaultId,
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
            and r.descriptor->>'freshnessSlaSeconds' ~ '^[0-9]+$'
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
        findingForScope(
          run.vaultId,
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
        findingForScope(
          run.vaultId,
          detector,
          row.permission_uncertain ? "HIGH" : "MEDIUM",
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
        findingForScope(
          run.vaultId,
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
        findingForScope(
          run.vaultId,
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
        findingForScope(
          run.vaultId,
          detector,
          "MEDIUM",
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
        findingForScope(
          run.vaultId,
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
        findingForScope(
          run.vaultId,
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
