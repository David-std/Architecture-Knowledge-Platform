import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  defaultCompilerKnowledgeProfileContext,
  durableCompilerKnowledgeProfileContext,
} from "@akp/compiler";
import {
  resolveAuthorizedVaultScope,
  resolveKnowledgeProfileBinding,
  type Postgres,
} from "@akp/postgres";
import { validateMarkdownDocument } from "@akp/validation";
import {
  OkfBundleV02,
  OkfImportMapping,
  OkfInteropError,
  okfToGraphMl,
  okfToJsonLd,
  planOkfReviewImport,
  type OkfBundleV02 as OkfBundleType,
  type OkfDocumentV02,
  type OkfEvidenceV02,
  type OkfRelationV02,
} from "../interoperability.js";
import { createReviewDraft } from "../review-draft.js";
import {
  actorOf,
  audit,
  hasPathAccess,
  hasSpaceAccess,
  requirePermission,
} from "../auth.js";
import { assertManagedRepositoryBoundary } from "../projections.js";
import { resolveProposalReviewPolicy } from "../review-policy.js";

function repositoryPath(): string {
  const managed =
    process.env.AKP_MANAGED_REPO ||
    path.join(tmpdir(), "akp-managed-knowledge");
  assertManagedRepositoryBoundary(managed);
  return managed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function evidenceTrust(status: string): OkfEvidenceV02["trust"] {
  if (status === "ATTESTED") return "ATTESTED";
  if (status === "HUMAN_REVIEWED") return "HUMAN_REVIEWED";
  if (status === "MACHINE_SUPPORTED") return "MACHINE_SUPPORTED";
  return "UNVERIFIED";
}

async function resolveCompilerProfile(
  db: Postgres,
  spaceId: string,
  vaultId: string,
) {
  const binding = await resolveKnowledgeProfileBinding(db, spaceId, vaultId);
  if (binding.source === "LEGACY_UNBOUND") {
    return {
      context: defaultCompilerKnowledgeProfileContext(),
      schemaProfile: binding.legacySchemaProfile,
    };
  }
  const revision = binding.revision;
  if (!revision) throw new Error("ACTIVE_KNOWLEDGE_PROFILE_BINDING_INVALID");
  return {
    context: durableCompilerKnowledgeProfileContext({
      revisionId: revision.id,
      profileHash: revision.profileHash,
      profile: revision.profile,
    }),
    schemaProfile: binding.legacySchemaProfile,
  };
}

function interopErrorStatus(code: string): 400 | 409 | 422 {
  if (code === "ACTIVE_KNOWLEDGE_PROFILE_BINDING_INVALID") return 409;
  if (code === "OKF_FORMAT_INVALID") return 400;
  return 422;
}

interface ExportDocumentRow {
  id: string;
  external_id: string | null;
  aliases: string[];
  path: string;
  title: string;
  type: string;
  lifecycle: string;
  trust_tier: OkfDocumentV02["trust"];
  current_revision: string;
  body_cache: string;
  content_hash: string | null;
  frontmatter: Record<string, unknown>;
}

export function registerInteroperabilityRoutes(
  app: FastifyInstance,
  db: Postgres,
): void {
  app.post<{
    Body: {
      spaceId?: string;
      vaultId?: string;
      format?: "OKF_0_2" | "JSON_LD" | "GRAPHML";
      documentIds?: string[];
    };
  }>(
    "/v1/interoperability/export",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const actor = actorOf(request);
      const spaceId = request.body?.spaceId;
      const vaultId = request.body?.vaultId;
      if (!spaceId || !vaultId) {
        return reply.code(400).send({ code: "VAULT_SCOPE_REQUIRED" });
      }
      if (!hasSpaceAccess(actor, spaceId, "knowledge:read")) {
        return reply.code(403).send({ code: "SPACE_ACCESS_DENIED" });
      }
      let access: { pathPrefix: string | null } | null = null;
      try {
        const scope = await resolveAuthorizedVaultScope(db, {
          userId: actor?.id ?? "",
          spaceId,
          vaultId,
          permission: "knowledge:read",
          federated: false,
        });
        access = scope.accessByVault[vaultId] ?? null;
      } catch (error) {
        const code =
          error instanceof Error ? error.message : "VAULT_ACCESS_DENIED";
        return reply
          .code(code === "VAULT_SCOPE_NOT_FOUND" ? 404 : 403)
          .send({ code });
      }
      if (!access) return reply.code(403).send({ code: "VAULT_ACCESS_DENIED" });
      const requestedIds = [...new Set(request.body?.documentIds ?? [])];
      const documents = await db.pool.query<ExportDocumentRow>(
        `
        select id,external_id,aliases,path,title,type,lifecycle,trust_tier,
               current_revision,body_cache,content_hash,frontmatter
          from knowledge_documents
         where space_id=$1 and vault_id=$2
           and lifecycle not in ('DELETED_TOMBSTONE','INVALID')
           and ($3::text is null or path=$3 or path like $3 || '/%')
           and (cardinality($4::text[])=0 or id::text=any($4::text[]) or external_id=any($4::text[]))
         order by path,id
        `,
        [spaceId, vaultId, access.pathPrefix, requestedIds],
      );
      const visible = documents.rows.filter((document) =>
        hasPathAccess(actor, spaceId, "knowledge:read", document.path),
      );
      if (requestedIds.length) {
        const matched = new Set(
          visible.flatMap((document) => [
            document.id,
            document.external_id ?? "",
          ]),
        );
        if (requestedIds.some((id) => !matched.has(id))) {
          return reply.code(404).send({ code: "INTEROP_DOCUMENT_NOT_FOUND" });
        }
      }
      const internalIds = visible.map((document) => document.id);
      const evidenceRows = internalIds.length
        ? await db.pool.query<{
            document_id: string;
            relation_type: string;
            evidence_id: string;
            source_id: string;
            source_hash: string;
            locator: unknown;
            content_hash: string;
            excerpt: string | null;
            review_status: string;
          }>(
            `
            select de.document_id,de.relation_type,e.id evidence_id,e.source_id,
                   s.sha256 source_hash,e.locator,e.content_hash,e.excerpt,e.review_status
              from document_evidence de
              join evidence e on e.id=de.evidence_id and e.space_id=$2 and e.vault_id=$3
              join sources s on s.id=e.source_id and s.space_id=$2 and s.vault_id=$3
             where de.document_id=any($1::uuid[])
             order by de.document_id,e.id
            `,
            [internalIds, spaceId, vaultId],
          )
        : { rows: [] as Array<Record<string, never>> };
      const evidenceByDocument = new Map<string, OkfEvidenceV02[]>();
      for (const row of evidenceRows.rows) {
        const evidence: OkfEvidenceV02 = {
          id: String(row.evidence_id),
          relationType: String(row.relation_type),
          sourceId: String(row.source_id),
          sourceHash: String(row.source_hash),
          locator: row.locator,
          contentHash: String(row.content_hash),
          trust: evidenceTrust(String(row.review_status)),
          sourceReviewStatus: String(row.review_status),
          ...(row.excerpt ? { excerpt: String(row.excerpt) } : {}),
        };
        const current = evidenceByDocument.get(String(row.document_id)) ?? [];
        current.push(evidence);
        evidenceByDocument.set(String(row.document_id), current);
      }
      const portableIdByInternal = new Map(
        visible.map((document) => [
          document.id,
          document.external_id || document.id,
        ]),
      );
      const relationRows = internalIds.length
        ? await db.pool.query<{
            from_document_id: string;
            to_document_id: string;
            relation_type: string;
            weight: number;
            provenance: string;
            metadata: Record<string, unknown>;
          }>(
            `
            select from_document_id,to_document_id,relation_type,weight,provenance,metadata
              from knowledge_relations
             where space_id=$1
               and from_document_id=any($2::uuid[])
               and to_document_id=any($2::uuid[])
             order by from_document_id,to_document_id,relation_type,provenance
            `,
            [spaceId, internalIds],
          )
        : { rows: [] as Array<Record<string, never>> };
      const binding = await resolveKnowledgeProfileBinding(
        db,
        spaceId,
        vaultId,
      );
      const vault = await db.pool.query<{ current_revision: string | null }>(
        "select current_revision from vaults where id=$1 and space_id=$2",
        [vaultId, spaceId],
      );
      const bundle = OkfBundleV02.parse({
        format: "OKF",
        version: "0.2",
        bundleId: `akp-${vaultId}-${createHash("sha256")
          .update(
            visible
              .map((document) => `${document.id}:${document.current_revision}`)
              .join("\n"),
          )
          .digest("hex")
          .slice(0, 16)}`,
        exportedAt: new Date().toISOString(),
        source: {
          system: "Architecture Knowledge Platform",
          spaceId,
          vaultId,
          ...(vault.rows[0]?.current_revision
            ? { corpusRevision: vault.rows[0].current_revision }
            : {}),
          ...(binding.revision
            ? {
                profileId: binding.revision.profileId,
                profileVersion: binding.revision.version,
                profileHash: binding.revision.profileHash,
              }
            : {
                profileId: "default",
                profileVersion: "0.3-compat",
              }),
        },
        documents: visible.map((document) => ({
          id: portableIdByInternal.get(document.id) ?? document.id,
          ...(document.external_id ? { externalId: document.external_id } : {}),
          aliases: document.aliases ?? [],
          sourcePath: document.path,
          title: document.title,
          kind: document.type,
          lifecycle: document.lifecycle,
          trust: document.trust_tier,
          body: document.body_cache,
          currentRevision: document.current_revision,
          ...(document.content_hash
            ? { contentHash: document.content_hash }
            : {}),
          frontmatter: asRecord(document.frontmatter),
          evidence: evidenceByDocument.get(document.id) ?? [],
          provenance: {
            akpDocumentId: document.id,
            exportedPath: document.path,
          },
        })),
        relations: relationRows.rows.flatMap((relation): OkfRelationV02[] => {
          const fromId = portableIdByInternal.get(
            String(relation.from_document_id),
          );
          const toId = portableIdByInternal.get(
            String(relation.to_document_id),
          );
          if (!fromId || !toId) return [];
          return [
            {
              fromId,
              toId,
              type: String(relation.relation_type),
              weight: Number(relation.weight),
              provenance: String(relation.provenance),
              metadata: asRecord(relation.metadata),
            },
          ];
        }),
      });
      await audit(
        db,
        request,
        "interop.export",
        "vault",
        vaultId,
        {
          format: request.body?.format ?? "OKF_0_2",
          documentCount: bundle.documents.length,
          relationCount: bundle.relations.length,
        },
        spaceId,
      );
      const format = request.body?.format ?? "OKF_0_2";
      if (format === "JSON_LD") return okfToJsonLd(bundle);
      if (format === "GRAPHML") {
        return reply.type("application/graphml+xml").send(okfToGraphMl(bundle));
      }
      return bundle;
    },
  );

  app.post<{
    Body: {
      spaceId?: string;
      vaultId?: string;
      bundle?: unknown;
      mapping?: unknown;
      summary?: string;
    };
  }>(
    "/v1/interoperability/import/okf",
    { preHandler: requirePermission("knowledge:propose") },
    async (request, reply) => {
      const actor = actorOf(request);
      const spaceId = request.body?.spaceId;
      const vaultId = request.body?.vaultId;
      if (!spaceId || !vaultId) {
        return reply.code(400).send({ code: "VAULT_SCOPE_REQUIRED" });
      }
      if (!hasSpaceAccess(actor, spaceId, "knowledge:propose")) {
        return reply.code(403).send({ code: "SPACE_ACCESS_DENIED" });
      }
      const parsedBundle = OkfBundleV02.safeParse(request.body?.bundle);
      const parsedMapping = OkfImportMapping.safeParse(
        request.body?.mapping ?? {},
      );
      if (!parsedBundle.success || !parsedMapping.success) {
        return reply.code(400).send({
          code: "OKF_FORMAT_INVALID",
          issues: [
            ...(parsedBundle.success ? [] : parsedBundle.error.issues),
            ...(parsedMapping.success ? [] : parsedMapping.error.issues),
          ],
        });
      }
      let access: { pathPrefix: string | null } | null = null;
      try {
        const scope = await resolveAuthorizedVaultScope(db, {
          userId: actor?.id ?? "",
          spaceId,
          vaultId,
          permission: "knowledge:propose",
          federated: false,
        });
        access = scope.accessByVault[vaultId] ?? null;
      } catch (error) {
        const code =
          error instanceof Error ? error.message : "VAULT_ACCESS_DENIED";
        return reply
          .code(code === "VAULT_SCOPE_NOT_FOUND" ? 404 : 403)
          .send({ code });
      }
      if (!access) return reply.code(403).send({ code: "VAULT_ACCESS_DENIED" });
      try {
        const profile = await resolveCompilerProfile(db, spaceId, vaultId);
        const plan = planOkfReviewImport({
          bundle: parsedBundle.data,
          mapping: parsedMapping.data,
          knowledgeProfile: profile.context,
          schemaProfile: profile.schemaProfile,
        });
        if (!plan.changes.length) {
          return reply.code(422).send({ code: "OKF_IMPORT_EMPTY" });
        }
        const denied = plan.changes.find(
          (change) =>
            !hasPathAccess(actor, spaceId, "knowledge:propose", change.path) ||
            (access?.pathPrefix !== null &&
              change.path !== access?.pathPrefix &&
              !change.path.startsWith(`${access?.pathPrefix}/`)),
        );
        if (denied) {
          return reply
            .code(403)
            .send({ code: "PATH_SCOPE_DENIED", path: denied.path });
        }
        const issues = plan.changes.flatMap((change) =>
          validateMarkdownDocument(change.content).map((issue) => ({
            ...issue,
            path: change.path,
          })),
        );
        if (issues.some((issue) => issue.severity === "ERROR")) {
          return reply
            .code(422)
            .send({ code: "DRAFT_VALIDATION_FAILED", issues });
        }
        const policy = await resolveProposalReviewPolicy(
          db,
          spaceId,
          vaultId,
          plan.reviewKinds,
        );
        const created = await createReviewDraft(db, {
          repositoryPath: repositoryPath(),
          spaceId,
          vaultId,
          authorId: actor?.id ?? null,
          summary:
            request.body?.summary?.trim() ||
            `interop: import OKF bundle ${plan.bundleId}`,
          changes: plan.changes,
          defaultReason: "OKF v0.2 review-first import",
          impactManifest: {
            summary:
              request.body?.summary?.trim() ||
              `OKF v0.2 review-first import ${plan.bundleId}`,
            reviewKinds: plan.reviewKinds,
            reviewPolicy: policy.policy,
            reviewPolicyPinned: policy.pinned,
            interoperability: {
              format: "OKF",
              version: "0.2",
              bundleId: plan.bundleId,
              source: plan.source,
              mapping: plan.mapping,
              foreignTrustTiers: plan.foreignTrustTiers,
              trustDisposition: plan.trustDisposition,
              reviewRequired: true,
              targetPathsDerivedFromProfile: true,
            },
          },
          validationReport: { issues, errors: 0 },
        });
        await audit(
          db,
          request,
          "interop.import.propose",
          "review",
          created.reviewId,
          {
            vaultId,
            bundleId: plan.bundleId,
            documentCount: plan.changes.length,
            trustDisposition: plan.trustDisposition,
          },
          spaceId,
        );
        return reply.code(201).send({
          reviewId: created.reviewId,
          status: "PENDING",
          branchName: created.branchName,
          headCommit: created.headCommit,
          documentCount: plan.changes.length,
          reviewKinds: plan.reviewKinds,
          trustDisposition: plan.trustDisposition,
        });
      } catch (error) {
        const code =
          error instanceof OkfInteropError
            ? error.code
            : error instanceof Error
              ? error.message
              : String(error);
        if (
          code.startsWith("COMPILER_PROFILE_KIND_NOT_DECLARED:") ||
          code.startsWith("COMPILER_REVIEW_POLICY_NOT_FOUND:") ||
          code === "COMPILER_REVIEW_POLICY_ROLE_CONFLICT"
        ) {
          return reply.code(422).send({ code });
        }
        if (
          error instanceof OkfInteropError ||
          code === "ACTIVE_KNOWLEDGE_PROFILE_BINDING_INVALID"
        ) {
          return reply.code(interopErrorStatus(code)).send({
            code,
            ...(error instanceof OkfInteropError ? error.details : {}),
          });
        }
        throw error;
      }
    },
  );
}
