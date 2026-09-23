import { GraphNodeIdentity } from "@akp/contracts";
import { PostgresFederatedGraphStore, type Postgres } from "@akp/postgres";

type GraphBuildArtifact = Parameters<PostgresFederatedGraphStore["build"]>[0];
import type { EventHandlers } from "./event-worker.js";

interface LinkRow {
  id: string;
  space_id: string;
  vault_id: string;
  project_id: string;
  document_id: string;
  review_id: string;
  relation_type: "rationale_ref" | "applies_to";
  knowledge_revision: string;
  code_repository: string;
  code_commit_sha: string;
  code_node_identity: unknown;
  code_selector: Record<string, unknown>;
  mapping_hash: string;
  created_at: Date | string;
  project_metadata: Record<string, unknown>;
  document_path: string;
  external_id: string | null;
  document_title: string;
  document_lifecycle: string;
}

function currentProjectCommit(
  metadata: Record<string, unknown>,
): string | null {
  const value = metadata.commit;
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export function createCodeKnowledgeLinkHandlers(
  db: Postgres,
): Pick<EventHandlers, "CodeKnowledgeLinkApproved"> {
  return {
    CodeKnowledgeLinkApproved: async (event) => {
      const mappingId = String(event.payload.mappingId ?? event.resourceId);
      const result = await db.pool.query<LinkRow>(
        `select l.*,
                p.metadata project_metadata,
                d.path document_path,
                d.external_id,
                d.title document_title,
                d.lifecycle document_lifecycle
           from code_knowledge_links l
           join projects p on p.id=l.project_id
           join knowledge_documents d on d.id=l.document_id
          where l.id=$1
          limit 1`,
        [mappingId],
      );
      const link = result.rows[0];
      if (!link) throw new Error("CODE_KNOWLEDGE_LINK_NOT_FOUND");
      if (event.spaceId !== link.space_id || event.vaultId !== link.vault_id) {
        throw new Error("CODE_KNOWLEDGE_LINK_SCOPE_MISMATCH");
      }
      if (
        currentProjectCommit(link.project_metadata) !==
        link.code_commit_sha.toLowerCase()
      ) {
        throw new Error("CODE_KNOWLEDGE_LINK_SOURCE_REVISION_CHANGED");
      }
      if (!["ACTIVE", "DISPUTED"].includes(link.document_lifecycle)) {
        throw new Error("CODE_KNOWLEDGE_LINK_KNOWLEDGE_INACTIVE");
      }

      const targetIdentity = GraphNodeIdentity.parse(link.code_node_identity);
      const store = new PostgresFederatedGraphStore(db);
      const activeTargets = await store.findNodes({
        authorization: {
          spaceId: link.space_id,
          vaults: [{ vaultId: link.vault_id, pathPrefix: null }],
          allowSpaceScoped: false,
        },
        domains: ["CODE"],
        kinds: [targetIdentity.kind],
        canonicalKeys: [targetIdentity.canonicalKey],
        freshnessPolicy: "FRESH_ONLY",
        limit: 100,
      });
      const target = activeTargets.find(
        (candidate) =>
          candidate.identity.scopeId === targetIdentity.scopeId &&
          candidate.identity.revision === targetIdentity.revision,
      );
      if (!target) {
        throw new Error("CODE_KNOWLEDGE_LINK_TARGET_STALE");
      }

      const scopeId = `knowledge-link:${link.id}`;
      const revision = `link:${link.id}`;
      const knowledgeIdentity = {
        graphDomain: "EPISTEMIC" as const,
        scopeId,
        kind: "knowledge-document",
        canonicalKey: link.document_id,
        revision,
      };
      const artifact: GraphBuildArtifact = {
        graphDomain: "EPISTEMIC",
        spaceId: link.space_id,
        vaultId: link.vault_id,
        scopeId,
        revision,
        sourceRevision: link.knowledge_revision,
        sourceHash: link.mapping_hash,
        provider: "human-reviewed-code-link",
        providerVersion: "1",
        configurationVersion: "rule-decision-bridge-v1",
        nodes: [
          {
            identity: knowledgeIdentity,
            vaultId: link.vault_id,
            authorizationPath: link.document_path,
            payload: {
              mappingId: link.id,
              documentId: link.document_id,
              externalId: link.external_id,
              title: link.document_title,
              path: link.document_path,
              reviewId: link.review_id,
              knowledgeRevision: link.knowledge_revision,
              relationType: link.relation_type,
            },
          },
        ],
        edges: [
          {
            from: knowledgeIdentity,
            relation: link.relation_type,
            to: targetIdentity,
            authorizationPath: link.document_path,
            provenance: {
              derivation: "HUMAN_ASSERTED",
              sourceIds: [`document:${link.document_id}`],
              evidenceIds: [`review:${link.review_id}`, `mapping:${link.id}`],
              locatorRefs: [
                `knowledge:${link.document_id}@${link.knowledge_revision}`,
                `code:${link.code_commit_sha}:${targetIdentity.kind}:${targetIdentity.canonicalKey}`.slice(
                  0,
                  2048,
                ),
              ],
              revision,
              recordedAt: iso(link.created_at),
            },
          },
        ],
      };
      await store.build(artifact);
    },
  };
}
