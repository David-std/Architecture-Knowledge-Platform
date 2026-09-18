import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CodeGraphQueryService,
  projectCodeGraphIdentity,
  type CodeSymbolSelector,
} from "@akp/project-adapter";
import {
  PostgresFederatedGraphStore,
  appendOutboxEvent,
  pathMatchesVaultPrefix,
  resolveAuthorizedVaultScope,
  type Postgres,
} from "@akp/postgres";
import {
  actorOf,
  audit,
  hasPathAccess,
  hasSpaceAccess,
  requirePermission,
} from "../auth.js";

const LinkRequest = z
  .object({
    projectId: z.string().uuid(),
    documentId: z.string().uuid(),
    reviewId: z.string().uuid(),
    relationType: z.enum(["rationale_ref", "applies_to"]),
    selector: z
      .object({
        path: z.string().trim().min(1).max(4096).optional(),
        qualifiedName: z.string().trim().min(1).max(2048).optional(),
        name: z.string().trim().min(1).max(1024).optional(),
        kind: z.string().trim().min(1).max(120).optional(),
        signature: z.string().trim().min(1).max(4096).optional(),
      })
      .strict()
      .refine(
        (value) =>
          Boolean(
            value.path || value.qualifiedName || value.name || value.signature,
          ),
        { message: "A code symbol locator is required." },
      ),
  })
  .strict();

interface ProjectRow {
  id: string;
  space_id: string;
  vault_id: string | null;
  slug: string;
  metadata: Record<string, unknown>;
}

interface DocumentRow {
  id: string;
  space_id: string;
  vault_id: string | null;
  path: string;
  external_id: string | null;
  title: string;
  lifecycle: string;
  current_revision: string;
}

interface ReviewRow {
  id: string;
  space_id: string;
  vault_id: string | null;
  status: string;
  merged_commit: string | null;
  impact_manifest: Record<string, unknown>;
}

function approvedPath(manifest: Record<string, unknown>, documentPath: string) {
  const changes = Array.isArray(manifest.proposedChanges)
    ? manifest.proposedChanges
    : [];
  return changes.some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return false;
    const value = entry as Record<string, unknown>;
    return (
      String(value.path ?? "") === documentPath &&
      String(value.operation ?? "UPDATE").toUpperCase() !== "DELETE"
    );
  });
}

function currentProjectCommit(
  metadata: Record<string, unknown>,
): string | null {
  const commit = metadata.commit;
  return typeof commit === "string" && /^[a-f0-9]{40}$/i.test(commit)
    ? commit.toLowerCase()
    : null;
}

function mappingHash(input: {
  documentId: string;
  reviewId: string;
  projectId: string;
  relationType: string;
  codeIdentity: {
    graphDomain: string;
    scopeId: string;
    kind: string;
    canonicalKey: string;
    revision: string;
  };
}) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.documentId,
        input.reviewId,
        input.projectId,
        input.relationType,
        input.codeIdentity.graphDomain,
        input.codeIdentity.scopeId,
        input.codeIdentity.kind,
        input.codeIdentity.canonicalKey,
        input.codeIdentity.revision,
      ]),
    )
    .digest("hex");
}

export function registerCodeKnowledgeLinkRoutes(
  app: FastifyInstance,
  db: Postgres,
) {
  app.post(
    "/v1/code/knowledge-links",
    { preHandler: requirePermission("knowledge:review") },
    async (request, reply) => {
      if (!request.headers["idempotency-key"]) {
        return reply.code(400).send({ code: "IDEMPOTENCY_KEY_REQUIRED" });
      }
      const parsed = LinkRequest.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "INVALID_CODE_KNOWLEDGE_LINK" });
      }
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      if (actor.principalKind !== "HUMAN") {
        return reply
          .code(403)
          .send({ code: "CODE_KNOWLEDGE_LINK_HUMAN_REVIEW_REQUIRED" });
      }

      const projectResult = await db.pool.query<ProjectRow>(
        `select id,space_id,vault_id,slug,metadata
           from projects
          where id=$1
          limit 1`,
        [parsed.data.projectId],
      );
      const project = projectResult.rows[0];
      if (!project?.vault_id) {
        return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
      }
      const spaceId = project.space_id;
      const vaultId = project.vault_id;
      if (!hasSpaceAccess(actor, spaceId, "knowledge:review")) {
        return reply.code(403).send({ code: "SPACE_ACCESS_DENIED" });
      }

      let vaultScope: Awaited<ReturnType<typeof resolveAuthorizedVaultScope>>;
      try {
        vaultScope = await resolveAuthorizedVaultScope(db, {
          userId: actor.id,
          spaceId,
          permission: "knowledge:review",
          vaultId,
          vaultIds: [vaultId],
          federated: false,
        });
      } catch {
        return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
      }
      const access = vaultScope.accessByVault[vaultId];
      if (!access) return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });

      const [documentResult, reviewResult] = await Promise.all([
        db.pool.query<DocumentRow>(
          `select id,space_id,vault_id,path,external_id,title,lifecycle,current_revision
             from knowledge_documents
            where id=$1 and space_id=$2 and vault_id=$3
            limit 1`,
          [parsed.data.documentId, spaceId, vaultId],
        ),
        db.pool.query<ReviewRow>(
          `select id,space_id,vault_id,status,merged_commit,impact_manifest
             from reviews
            where id=$1 and space_id=$2 and vault_id=$3
            limit 1`,
          [parsed.data.reviewId, spaceId, vaultId],
        ),
      ]);
      const document = documentResult.rows[0];
      const review = reviewResult.rows[0];
      if (
        !document ||
        !["ACTIVE", "DISPUTED"].includes(document.lifecycle) ||
        !review ||
        review.status !== "APPROVED" ||
        !review.merged_commit ||
        !approvedPath(review.impact_manifest ?? {}, document.path)
      ) {
        return reply
          .code(409)
          .send({ code: "CODE_KNOWLEDGE_LINK_REVIEW_NOT_APPROVED" });
      }

      const projectPath = `projects/${project.slug}`;
      if (
        !hasPathAccess(actor, spaceId, "knowledge:review", document.path) ||
        !hasPathAccess(actor, spaceId, "knowledge:review", projectPath) ||
        !pathMatchesVaultPrefix(document.path, access.pathPrefix) ||
        !pathMatchesVaultPrefix(projectPath, access.pathPrefix)
      ) {
        return reply.code(404).send({ code: "CODE_KNOWLEDGE_LINK_NOT_FOUND" });
      }

      const identity = projectCodeGraphIdentity(vaultId, project.slug);
      const commit = currentProjectCommit(project.metadata ?? {});
      if (!commit) {
        return reply.code(409).send({ code: "CODE_GRAPH_NOT_READY" });
      }
      const graph = new PostgresFederatedGraphStore(db);
      const state = await graph.revisionState(
        "CODE",
        spaceId,
        identity.scopeId,
      );
      if (
        !state.active ||
        state.active.freshness !== "FRESH" ||
        state.active.sourceRevision.toLowerCase() !== commit
      ) {
        return reply
          .code(409)
          .send({ code: "CODE_GRAPH_SOURCE_REVISION_STALE" });
      }

      const selector: CodeSymbolSelector = {
        repository: identity.repository,
        commitSha: commit,
        ...parsed.data.selector,
      };
      const symbols = await new CodeGraphQueryService(graph).symbol(
        {
          authorization: {
            spaceId,
            vaults: [{ vaultId, pathPrefix: access.pathPrefix }],
            allowSpaceScoped: false,
          },
          freshnessPolicy: "FRESH_ONLY",
        },
        selector,
      );
      if (symbols.length === 0) {
        return reply.code(404).send({ code: "CODE_SYMBOL_NOT_FOUND" });
      }
      if (symbols.length !== 1) {
        return reply.code(409).send({ code: "CODE_SYMBOL_AMBIGUOUS" });
      }
      const codeNode = symbols[0]!;
      const hash = mappingHash({
        documentId: document.id,
        reviewId: review.id,
        projectId: project.id,
        relationType: parsed.data.relationType,
        codeIdentity: codeNode.identity,
      });

      const client = await db.pool.connect();
      let link: Record<string, unknown> | undefined;
      let inserted = false;
      try {
        await client.query("begin");
        const created = await client.query(
          `insert into code_knowledge_links(
             space_id,vault_id,project_id,document_id,review_id,relation_type,
             knowledge_revision,code_repository,code_commit_sha,
             code_node_identity,code_selector,mapping_hash,
             approved_by_user_id,approved_by_principal_id
           ) values(
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14
           )
           on conflict(vault_id,mapping_hash) do nothing
           returning *`,
          [
            spaceId,
            vaultId,
            project.id,
            document.id,
            review.id,
            parsed.data.relationType,
            document.current_revision,
            identity.repository,
            commit,
            JSON.stringify(codeNode.identity),
            JSON.stringify(selector),
            hash,
            actor.id,
            actor.principalId,
          ],
        );
        link = created.rows[0] as Record<string, unknown> | undefined;
        inserted = Boolean(link);
        if (!link) {
          const existing = await client.query(
            `select * from code_knowledge_links
              where vault_id=$1 and mapping_hash=$2
              limit 1`,
            [vaultId, hash],
          );
          link = existing.rows[0] as Record<string, unknown> | undefined;
        }
        if (!link) throw new Error("CODE_KNOWLEDGE_LINK_PERSISTENCE_FAILED");
        if (inserted) {
          await appendOutboxEvent(client, {
            eventType: "CodeKnowledgeLinkApproved",
            resourceId: String(link.id),
            spaceId,
            vaultId,
            correlationId: request.id,
            payload: {
              mappingId: String(link.id),
              projectId: project.id,
              documentId: document.id,
              reviewId: review.id,
              relationType: parsed.data.relationType,
            },
          });
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      await audit(
        db,
        request,
        "code.knowledge-link.approve",
        "code_knowledge_link",
        String(link.id),
        {
          vaultId,
          projectId: project.id,
          documentId: document.id,
          reviewId: review.id,
          relationType: parsed.data.relationType,
          codeCommit: commit,
          graphRevision: codeNode.identity.revision,
        },
        spaceId,
      );
      return reply.code(inserted ? 202 : 200).send({
        link,
        projectionStatus: inserted ? "REQUESTED" : "ALREADY_REQUESTED",
      });
    },
  );
}
