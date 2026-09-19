import { createHash } from "node:crypto";
import type { Postgres } from "@akp/postgres";
import {
  DEFAULT_COMMUNITY_RANDOM_SEED,
  DEFAULT_COMMUNITY_RESOLUTION,
  detectLeidenCommunities,
  type CommunityGraphEdge,
  type CommunityGraphNode,
} from "@akp/retrieval";

const DERIVED_INDEX_LIFECYCLE = "DERIVED_INDEX";

interface CommunityDocumentRow {
  id: string;
  title: string;
  external_id: string;
  path: string;
}

interface CommunityRelationRow {
  id: string;
  from_document_id: string;
  to_document_id: string;
  relation_type: string;
  weight: number | string | null;
  provenance: string;
}

export interface RebuildCommunityIndexOptions {
  spaceId: string;
  vaultId: string;
  graphRevision: string;
  scopeId?: string;
  resolution?: number;
  randomSeed?: number;
}

export interface RebuildCommunityIndexResult {
  revisionId: string;
  communityRevision: string;
  graphRevision: string;
  communities: number;
  memberships: number;
  quality: number;
  reused: boolean;
}

function communityRevisionFor(input: {
  graphRevision: string;
  scopeId: string;
  resolution: number;
  randomSeed: number;
  nodes: readonly CommunityGraphNode[];
  edges: readonly CommunityGraphEdge[];
}): string {
  const canonical = {
    graphRevision: input.graphRevision,
    scopeId: input.scopeId,
    algorithm: "LEIDEN",
    algorithmVersion: "ngraph.leiden@0.3.0",
    objective: "CPM",
    resolution: input.resolution,
    randomSeed: input.randomSeed,
    nodes: [...input.nodes].map((node) => node.id).sort(),
    edges: [...input.edges]
      .map((edge) => ({
        key: edge.id,
        from: edge.from,
        to: edge.to,
        weight: edge.weight ?? 1,
      }))
      .sort((left, right) =>
        [left.from, left.to, left.key, String(left.weight)]
          .join("\0")
          .localeCompare(
            [right.from, right.to, right.key, String(right.weight)].join(
              "\0",
            ),
          ),
      ),
  };
  return `community:${createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")}`;
}

function derivedSummary(
  titles: readonly string[],
  totalMembers: number,
): string {
  const sample = titles
    .map((title) => title.trim())
    .filter(Boolean)
    .slice(0, 5);
  if (sample.length === 0) {
    return `Derived community containing ${totalMembers} knowledge item(s).`;
  }
  const suffix = totalMembers > sample.length ? "; …" : "";
  return `Derived community containing ${totalMembers} knowledge item(s): ${sample.join("; ")}${suffix}`;
}

function numericWeight(value: number | string | null): number {
  const parsed = Number(value ?? 1);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 1;
}

/**
 * Rebuild the vault-scoped community index from the current typed document
 * relation graph. The generated summaries are navigation aids only and are
 * persisted as DERIVED_INDEX, never as source authority.
 */
export async function rebuildCommunityIndex(
  db: Postgres,
  options: RebuildCommunityIndexOptions,
): Promise<RebuildCommunityIndexResult> {
  const scopeId = options.scopeId?.trim() || `vault:${options.vaultId}`;
  const resolution = options.resolution ?? DEFAULT_COMMUNITY_RESOLUTION;
  const randomSeed = options.randomSeed ?? DEFAULT_COMMUNITY_RANDOM_SEED;

  const documents = await db.pool.query<CommunityDocumentRow>(
    `
    select id,title,external_id,path
      from knowledge_documents
     where space_id=$1 and vault_id=$2
       and lifecycle not in (
         'ARCHIVED','DELETED_TOMBSTONE','SUPERSEDED','INVALID'
       )
     order by id
    `,
    [options.spaceId, options.vaultId],
  );
  const documentIds = new Set(documents.rows.map((document) => document.id));

  const relations = await db.pool.query<CommunityRelationRow>(
    `
    select r.id,r.from_document_id,r.to_document_id,r.relation_type,r.weight,
           r.provenance
      from knowledge_relations r
      join knowledge_documents source on source.id=r.from_document_id
      join knowledge_documents target on target.id=r.to_document_id
     where r.space_id=$1
       and source.vault_id=$2 and target.vault_id=$2
       and source.lifecycle not in (
         'ARCHIVED','DELETED_TOMBSTONE','SUPERSEDED','INVALID'
       )
       and target.lifecycle not in (
         'ARCHIVED','DELETED_TOMBSTONE','SUPERSEDED','INVALID'
       )
     order by r.from_document_id,r.to_document_id,r.relation_type,r.id
    `,
    [options.spaceId, options.vaultId],
  );

  const nodes: CommunityGraphNode[] = documents.rows.map((document) => ({
    id: document.id,
  }));
  const edges: CommunityGraphEdge[] = relations.rows
    .filter(
      (relation) =>
        documentIds.has(relation.from_document_id) &&
        documentIds.has(relation.to_document_id),
    )
    .map((relation) => ({
      id: [
        relation.from_document_id,
        relation.relation_type,
        relation.to_document_id,
        relation.provenance,
      ].join(":"),
      from: relation.from_document_id,
      to: relation.to_document_id,
      weight: numericWeight(relation.weight),
    }));

  const partition = detectLeidenCommunities(nodes, edges, {
    resolution,
    randomSeed,
  });
  const communityRevision = communityRevisionFor({
    graphRevision: options.graphRevision,
    scopeId,
    resolution,
    randomSeed,
    nodes,
    edges,
  });

  const existing = await db.pool.query<{
    id: string;
    status: string;
    stale: boolean;
  }>(
    `
    select id,status,stale
      from community_index_revisions
     where space_id=$1 and vault_id=$2 and scope_id=$3
       and community_revision=$4
    `,
    [options.spaceId, options.vaultId, scopeId, communityRevision],
  );
  const current = existing.rows[0];
  if (current?.status === "ACTIVE" && current.stale === false) {
    return {
      revisionId: current.id,
      communityRevision,
      graphRevision: options.graphRevision,
      communities: partition.communities.length,
      memberships: partition.memberships.length,
      quality: partition.quality,
      reused: true,
    };
  }

  const documentById = new Map(
    documents.rows.map((document) => [document.id, document] as const),
  );
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `
      update community_index_revisions
         set status='STALE',stale=true,updated_at=now()
       where space_id=$1 and vault_id=$2 and scope_id=$3
         and status='ACTIVE' and stale=false
      `,
      [options.spaceId, options.vaultId, scopeId],
    );

    const inserted = await client.query<{ id: string }>(
      `
      insert into community_index_revisions(
        space_id,vault_id,scope_id,community_revision,graph_revision,
        algorithm,algorithm_version,objective,resolution,random_seed,quality,
        hierarchy,lifecycle,status,stale,activated_at,error
      ) values(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,
        'DERIVED_INDEX','ACTIVE',false,now(),null
      )
      on conflict(space_id,vault_id,scope_id,community_revision) do update set
        graph_revision=excluded.graph_revision,
        algorithm=excluded.algorithm,
        algorithm_version=excluded.algorithm_version,
        objective=excluded.objective,
        resolution=excluded.resolution,
        random_seed=excluded.random_seed,
        quality=excluded.quality,
        hierarchy=excluded.hierarchy,
        lifecycle='DERIVED_INDEX',
        status='ACTIVE',
        stale=false,
        activated_at=now(),
        error=null,
        updated_at=now()
      returning id
      `,
      [
        options.spaceId,
        options.vaultId,
        scopeId,
        communityRevision,
        options.graphRevision,
        partition.algorithm,
        partition.algorithmVersion,
        partition.objective,
        partition.resolution,
        partition.randomSeed,
        partition.quality,
        JSON.stringify(partition.hierarchy),
      ],
    );
    const revisionId = inserted.rows[0]?.id;
    if (!revisionId) throw new Error("COMMUNITY_REVISION_WRITE_FAILED");

    await client.query(
      "delete from community_index_memberships where revision_id=$1",
      [revisionId],
    );
    await client.query(
      "delete from community_index_communities where revision_id=$1",
      [revisionId],
    );

    for (const community of partition.communities) {
      const memberDocuments = community.memberNodeIds
        .map((id) => documentById.get(id))
        .filter((document): document is CommunityDocumentRow => Boolean(document));
      const supportSet = {
        documentIds: community.memberNodeIds,
        relationKeys: community.supportEdgeIds,
      };
      await client.query(
        `
        insert into community_index_communities(
          revision_id,community_key,ordinal,member_count,summary,
          summary_lifecycle,citable,support_set,hierarchy
        ) values($1,$2,$3,$4,$5,'DERIVED_INDEX',false,$6::jsonb,$7::jsonb)
        `,
        [
          revisionId,
          community.communityKey,
          community.ordinal,
          community.memberNodeIds.length,
          derivedSummary(
            memberDocuments.map((document) => document.title),
            community.memberNodeIds.length,
          ),
          JSON.stringify(supportSet),
          JSON.stringify(community.hierarchy),
        ],
      );
    }

    for (const membership of partition.memberships) {
      const community = partition.communities.find(
        (candidate) => candidate.communityKey === membership.communityKey,
      );
      await client.query(
        `
        insert into community_index_memberships(
          revision_id,document_id,community_key,hierarchy
        ) values($1,$2,$3,$4::jsonb)
        `,
        [
          revisionId,
          membership.nodeId,
          membership.communityKey,
          JSON.stringify({
            ...(community?.hierarchy ?? {}),
            rawCommunity: membership.rawCommunity,
          }),
        ],
      );
    }

    await client.query("commit");
    return {
      revisionId,
      communityRevision,
      graphRevision: options.graphRevision,
      communities: partition.communities.length,
      memberships: partition.memberships.length,
      quality: partition.quality,
      reused: false,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export const communitySummaryLifecycle = DERIVED_INDEX_LIFECYCLE;
