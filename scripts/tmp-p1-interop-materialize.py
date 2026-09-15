from pathlib import Path


def write(path: str, content: str) -> None:
    file = Path(path)
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(content)


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}")
    file.write_text(text.replace(old, new, 1))


write(
    "apps/api/src/interoperability.ts",
    r'''import { createHash } from "node:crypto";
import { z } from "zod";
import { TrustTier } from "@akp/contracts";
import {
  deriveProfileKnowledgePath,
  type CompilerKnowledgeProfileContext,
} from "@akp/compiler";

const SHA256 = /^[a-f0-9]{64}$/;
const RESERVED_FOREIGN_ROOTS = new Set([
  ".akp",
  ".obsidian",
  "10-sources",
  "docs",
  "README.md",
]);

const PortableId = z.string().trim().min(1).max(500);
const PortableSemanticName = z.string().trim().min(1).max(200);

export const OkfEvidenceV02 = z
  .object({
    id: PortableId,
    relationType: z.string().trim().min(1).max(100).default("supported_by"),
    sourceId: PortableId.optional(),
    sourceHash: z.string().regex(SHA256).optional(),
    locator: z.unknown().optional(),
    contentHash: z.string().regex(SHA256).optional(),
    excerpt: z.string().max(20_000).optional(),
    trust: TrustTier.optional(),
    sourceReviewStatus: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export type OkfEvidenceV02 = z.infer<typeof OkfEvidenceV02>;

export const OkfDocumentV02 = z
  .object({
    id: PortableId,
    externalId: PortableId.nullable().optional(),
    aliases: z.array(PortableId).max(200).default([]),
    sourcePath: z.string().trim().min(1).max(1_000).optional(),
    title: z.string().trim().min(1).max(500),
    kind: PortableSemanticName,
    lifecycle: PortableSemanticName,
    trust: TrustTier,
    body: z.string().min(1).max(2_000_000),
    currentRevision: z.string().trim().min(1).max(500).optional(),
    contentHash: z.string().regex(SHA256).optional(),
    frontmatter: z.record(z.string(), z.unknown()).default({}),
    evidence: z.array(OkfEvidenceV02).max(500).default([]),
    provenance: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type OkfDocumentV02 = z.infer<typeof OkfDocumentV02>;

export const OkfRelationV02 = z
  .object({
    fromId: PortableId,
    toId: PortableId,
    type: PortableSemanticName,
    weight: z.number().finite().min(0).max(1_000).default(1),
    provenance: z.string().trim().min(1).max(1_000),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type OkfRelationV02 = z.infer<typeof OkfRelationV02>;

export const OkfBundleV02 = z
  .object({
    format: z.literal("OKF"),
    version: z.literal("0.2"),
    bundleId: PortableId,
    exportedAt: z.string().datetime(),
    source: z
      .object({
        system: z.string().trim().min(1).max(200),
        spaceId: PortableId.optional(),
        vaultId: PortableId.optional(),
        corpusRevision: z.string().trim().min(1).max(500).optional(),
        profileId: PortableId.optional(),
        profileVersion: z.string().trim().min(1).max(100).optional(),
        profileHash: z.string().regex(SHA256).optional(),
      })
      .strict(),
    documents: z.array(OkfDocumentV02).max(5_000),
    relations: z.array(OkfRelationV02).max(20_000).default([]),
  })
  .strict()
  .superRefine((bundle, context) => {
    const ids = new Set<string>();
    for (const [index, document] of bundle.documents.entries()) {
      if (ids.has(document.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["documents", index, "id"],
          message: `duplicate OKF document id: ${document.id}`,
        });
      }
      ids.add(document.id);
    }
    for (const [index, relation] of bundle.relations.entries()) {
      if (!ids.has(relation.fromId) || !ids.has(relation.toId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["relations", index],
          message: "OKF relation endpoint is not present in the bundle",
        });
      }
    }
  });
export type OkfBundleV02 = z.infer<typeof OkfBundleV02>;

export const OkfImportMapping = z
  .object({
    kinds: z.record(z.string(), z.string().trim().min(1)).default({}),
    lifecycles: z.record(z.string(), z.string().trim().min(1)).default({}),
    relations: z.record(z.string(), z.string().trim().min(1)).default({}),
  })
  .strict();
export type OkfImportMapping = z.infer<typeof OkfImportMapping>;

export class OkfInteropError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, details: Record<string, unknown> = {}) {
    super(code);
    this.name = "OkfInteropError";
    this.code = code;
    this.details = details;
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

export function canonicalOkfJson(bundle: OkfBundleV02): string {
  return JSON.stringify(stableValue(OkfBundleV02.parse(bundle)));
}

export function assertSafeForeignSourcePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const root = segments[0] ?? "";
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    /^[A-Za-z]:\//.test(normalized) ||
    /[\u0000-\u001f]/.test(normalized) ||
    segments.some((segment) => !segment || segment === "." || segment === "..") ||
    RESERVED_FOREIGN_ROOTS.has(root)
  ) {
    throw new OkfInteropError("OKF_FOREIGN_PATH_UNSAFE", { path });
  }
  return normalized;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function urn(id: string): string {
  return `urn:okf:${encodeURIComponent(id)}`;
}

export function okfToJsonLd(bundleInput: OkfBundleV02): Record<string, unknown> {
  const bundle = OkfBundleV02.parse(bundleInput);
  return {
    "@context": {
      akp: "https://architecture-knowledge-platform.local/ns/okf/0.2#",
      title: "akp:title",
      kind: "akp:kind",
      lifecycle: "akp:lifecycle",
      trust: "akp:trust",
      body: "akp:body",
      relationType: "akp:relationType",
      from: { "@id": "akp:from", "@type": "@id" },
      to: { "@id": "akp:to", "@type": "@id" },
    },
    "@id": urn(bundle.bundleId),
    "@type": "akp:KnowledgeBundle",
    version: bundle.version,
    source: bundle.source,
    "@graph": [
      ...bundle.documents.map((document) => ({
        "@id": urn(document.id),
        "@type": "akp:KnowledgeDocument",
        title: document.title,
        kind: document.kind,
        lifecycle: document.lifecycle,
        trust: document.trust,
        body: document.body,
        aliases: document.aliases,
        evidence: document.evidence,
        provenance: document.provenance,
      })),
      ...bundle.relations.map((relation, index) => ({
        "@id": `${urn(bundle.bundleId)}:relation:${index}`,
        "@type": "akp:KnowledgeRelation",
        relationType: relation.type,
        from: urn(relation.fromId),
        to: urn(relation.toId),
        weight: relation.weight,
        provenance: relation.provenance,
        metadata: relation.metadata,
      })),
    ],
  };
}

export function okfToGraphMl(bundleInput: OkfBundleV02): string {
  const bundle = OkfBundleV02.parse(bundleInput);
  const nodes = bundle.documents
    .map(
      (document) => `    <node id="${xmlEscape(document.id)}">
      <data key="title">${xmlEscape(document.title)}</data>
      <data key="kind">${xmlEscape(document.kind)}</data>
      <data key="lifecycle">${xmlEscape(document.lifecycle)}</data>
      <data key="trust">${xmlEscape(document.trust)}</data>
      <data key="provenance">${xmlEscape(JSON.stringify(document.provenance))}</data>
    </node>`,
    )
    .join("\n");
  const edges = bundle.relations
    .map(
      (relation, index) => `    <edge id="e${index}" source="${xmlEscape(relation.fromId)}" target="${xmlEscape(relation.toId)}">
      <data key="relationType">${xmlEscape(relation.type)}</data>
      <data key="weight">${relation.weight}</data>
      <data key="provenance">${xmlEscape(relation.provenance)}</data>
    </edge>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns">
  <key id="title" for="node" attr.name="title" attr.type="string"/>
  <key id="kind" for="node" attr.name="kind" attr.type="string"/>
  <key id="lifecycle" for="node" attr.name="lifecycle" attr.type="string"/>
  <key id="trust" for="node" attr.name="trust" attr.type="string"/>
  <key id="provenance" for="all" attr.name="provenance" attr.type="string"/>
  <key id="relationType" for="edge" attr.name="relationType" attr.type="string"/>
  <key id="weight" for="edge" attr.name="weight" attr.type="double"/>
  <graph id="${xmlEscape(bundle.bundleId)}" edgedefault="directed">
${nodes}${nodes && edges ? "\n" : ""}${edges}
  </graph>
</graphml>`;
}

function localIdentity(bundleId: string, documentId: string): string {
  return `OKF-${createHash("sha256")
    .update(`${bundleId}\0${documentId}`)
    .digest("hex")
    .slice(0, 16)
    .toUpperCase()}`;
}

function mapKind(
  foreignKind: string,
  mapping: OkfImportMapping,
  profile: CompilerKnowledgeProfileContext,
): string {
  const local = mapping.kinds[foreignKind] ?? foreignKind;
  if (!profile.profile.knowledgeKinds[local]) {
    throw new OkfInteropError("OKF_KIND_MAPPING_REQUIRED", {
      foreignKind,
      requestedLocalKind: local,
    });
  }
  return local;
}

function mapLifecycle(
  foreignLifecycle: string,
  localKind: string,
  mapping: OkfImportMapping,
  profile: CompilerKnowledgeProfileContext,
): string {
  const local = mapping.lifecycles[foreignLifecycle] ?? foreignLifecycle;
  const kind = profile.profile.knowledgeKinds[localKind];
  if (!kind) {
    throw new OkfInteropError("OKF_KIND_MAPPING_REQUIRED", { localKind });
  }
  const lifecycle = profile.profile.lifecycles[kind.lifecycle];
  if (!lifecycle?.states.includes(local)) {
    throw new OkfInteropError("OKF_LIFECYCLE_MAPPING_REQUIRED", {
      foreignLifecycle,
      requestedLocalLifecycle: local,
      localKind,
    });
  }
  return local;
}

interface LocalDocumentMapping {
  foreign: OkfDocumentV02;
  localId: string;
  localKind: string;
  localLifecycle: string;
  targetPath: string;
}

interface LocalRelationMapping {
  fromId: string;
  toId: string;
  foreignType: string;
  localType: string;
  provenance: string;
  weight: number;
  metadata: Record<string, unknown>;
}

function mapRelations(
  bundle: OkfBundleV02,
  mapping: OkfImportMapping,
  profile: CompilerKnowledgeProfileContext,
  documents: ReadonlyMap<string, LocalDocumentMapping>,
): LocalRelationMapping[] {
  return bundle.relations.map((relation) => {
    const localType = mapping.relations[relation.type] ?? relation.type;
    const definition = profile.profile.relationTypes[localType];
    if (!definition) {
      throw new OkfInteropError("OKF_RELATION_MAPPING_REQUIRED", {
        foreignRelation: relation.type,
        requestedLocalRelation: localType,
      });
    }
    const from = documents.get(relation.fromId);
    const to = documents.get(relation.toId);
    if (!from || !to) {
      throw new OkfInteropError("OKF_RELATION_ENDPOINT_MISSING", {
        fromId: relation.fromId,
        toId: relation.toId,
      });
    }
    const forward =
      definition.from.includes(from.localKind) &&
      definition.to.includes(to.localKind);
    const reverse =
      definition.symmetric &&
      definition.from.includes(to.localKind) &&
      definition.to.includes(from.localKind);
    if (!forward && !reverse) {
      throw new OkfInteropError("OKF_RELATION_MAPPING_INCOMPATIBLE", {
        foreignRelation: relation.type,
        localRelation: localType,
        fromKind: from.localKind,
        toKind: to.localKind,
      });
    }
    return {
      fromId: from.localId,
      toId: to.localId,
      foreignType: relation.type,
      localType,
      provenance: relation.provenance,
      weight: relation.weight,
      metadata: relation.metadata,
    };
  });
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function renderImportCandidate(
  bundle: OkfBundleV02,
  document: LocalDocumentMapping,
  relations: readonly LocalRelationMapping[],
): string {
  const foreignAliases = [
    document.foreign.id,
    ...(document.foreign.externalId ? [document.foreign.externalId] : []),
    ...document.foreign.aliases,
  ];
  const aliases = [...new Set(foreignAliases)].filter(Boolean);
  const documentRelations = relations.filter(
    (relation) =>
      relation.fromId === document.localId || relation.toId === document.localId,
  );
  const provenance = {
    format: "OKF",
    version: "0.2",
    bundleId: bundle.bundleId,
    source: bundle.source,
    foreignDocumentId: document.foreign.id,
    ...(document.foreign.externalId
      ? { foreignExternalId: document.foreign.externalId }
      : {}),
    ...(document.foreign.sourcePath
      ? { foreignSourcePath: document.foreign.sourcePath }
      : {}),
    ...(document.foreign.currentRevision
      ? { foreignRevision: document.foreign.currentRevision }
      : {}),
    foreignProvenance: document.foreign.provenance,
  };
  return `---
type: ${json(document.localKind)}
title: ${json(document.foreign.title)}
status: ${json(document.localLifecycle)}
knowledge_layer: "interop-import-candidate"
id: ${json(document.localId)}
aliases: ${json(aliases)}
trust: "UNVERIFIED"
foreign_trust: ${json(document.foreign.trust)}
foreign_provenance: ${json(provenance)}
foreign_frontmatter: ${json(document.foreign.frontmatter)}
foreign_evidence: ${json(document.foreign.evidence)}
okf_relations: ${json(documentRelations)}
---

${document.foreign.body.trim()}\n`;
}

export interface OkfImportPlan {
  reviewKinds: string[];
  changes: Array<{
    path: string;
    content: string;
    reason: string;
    foreignDocumentId: string;
    localId: string;
  }>;
  mapping: OkfImportMapping;
  source: OkfBundleV02["source"];
  bundleId: string;
  foreignTrustTiers: string[];
  trustDisposition: "LOCAL_UNVERIFIED_REVIEW_REQUIRED";
}

export function planOkfReviewImport(input: {
  bundle: OkfBundleV02;
  mapping?: OkfImportMapping;
  knowledgeProfile: CompilerKnowledgeProfileContext;
  schemaProfile?: Record<string, unknown>;
}): OkfImportPlan {
  const bundle = OkfBundleV02.parse(input.bundle);
  const mapping = OkfImportMapping.parse(input.mapping ?? {});
  const documents = new Map<string, LocalDocumentMapping>();
  const usedPaths = new Set<string>();

  for (const foreign of bundle.documents) {
    if (foreign.sourcePath) assertSafeForeignSourcePath(foreign.sourcePath);
    const localKind = mapKind(foreign.kind, mapping, input.knowledgeProfile);
    const localLifecycle = mapLifecycle(
      foreign.lifecycle,
      localKind,
      mapping,
      input.knowledgeProfile,
    );
    const localId = localIdentity(bundle.bundleId, foreign.id);
    const targetPath = deriveProfileKnowledgePath({
      title: foreign.title,
      kind: localKind,
      candidateId: localId,
      knowledgeProfile: input.knowledgeProfile,
      ...(input.schemaProfile ? { schemaProfile: input.schemaProfile } : {}),
    });
    if (usedPaths.has(targetPath)) {
      throw new OkfInteropError("OKF_TARGET_PATH_COLLISION", {
        path: targetPath,
      });
    }
    usedPaths.add(targetPath);
    documents.set(foreign.id, {
      foreign,
      localId,
      localKind,
      localLifecycle,
      targetPath,
    });
  }

  const relations = mapRelations(
    bundle,
    mapping,
    input.knowledgeProfile,
    documents,
  );
  const mappedDocuments = [...documents.values()];
  return {
    reviewKinds: [...new Set(mappedDocuments.map((entry) => entry.localKind))],
    changes: mappedDocuments.map((entry) => ({
      path: entry.targetPath,
      content: renderImportCandidate(bundle, entry, relations),
      reason: `OKF v0.2 review-first import of ${entry.foreign.id}`,
      foreignDocumentId: entry.foreign.id,
      localId: entry.localId,
    })),
    mapping,
    source: bundle.source,
    bundleId: bundle.bundleId,
    foreignTrustTiers: [...new Set(bundle.documents.map((entry) => entry.trust))],
    trustDisposition: "LOCAL_UNVERIFIED_REVIEW_REQUIRED",
  };
}
''',
)

write(
    "apps/api/src/review-draft.ts",
    r'''import { randomUUID } from "node:crypto";
import { GitKnowledgeStore } from "@akp/git-store";
import type { Postgres } from "@akp/postgres";

export interface ReviewDraftChange {
  path: string;
  content: string;
  reason?: string;
}

export async function createReviewDraft(
  db: Postgres,
  input: {
    repositoryPath: string;
    spaceId: string;
    vaultId: string;
    authorId: string | null;
    summary: string;
    changes: readonly ReviewDraftChange[];
    impactManifest: Record<string, unknown>;
    validationReport: Record<string, unknown>;
    defaultReason: string;
  },
): Promise<{
  reviewId: string;
  branchName: string;
  baseRevision: string;
  headCommit: string;
  proposedChanges: Array<{
    path: string;
    operation: "CREATE" | "UPDATE";
    reasons: string[];
  }>;
}> {
  const reviewId = randomUUID();
  const store = new GitKnowledgeStore(input.repositoryPath);
  const baseRevision = await store.ensureRepository(
    process.env.AKP_GIT_AUTHOR_NAME ?? "Architecture Knowledge Platform",
    process.env.AKP_GIT_AUTHOR_EMAIL ?? "akp@localhost",
  );
  const branchName = await store.createDraftBranch(reviewId, baseRevision);
  try {
    const proposedChanges = await Promise.all(
      input.changes.map(async (change) => ({
        path: change.path,
        operation: (await store.hasFileAtRevision(baseRevision, change.path))
          ? ("UPDATE" as const)
          : ("CREATE" as const),
        reasons: [change.reason ?? input.defaultReason],
      })),
    );
    for (const change of input.changes) {
      await store.writeDraftFile(change.path, change.content);
    }
    const headCommit = await store.commitAll(
      input.summary,
      process.env.AKP_GIT_AUTHOR_NAME ?? "Architecture Knowledge Platform",
      process.env.AKP_GIT_AUTHOR_EMAIL ?? "akp@localhost",
    );
    await db.pool.query(
      `
      insert into reviews(id,space_id,vault_id,branch_name,base_commit,head_commit,status,author_id,
                          impact_manifest,validation_report)
      values($1,$2,$3,$4,$5,$6,'PENDING',$7,$8::jsonb,$9::jsonb)
      `,
      [
        reviewId,
        input.spaceId,
        input.vaultId,
        branchName,
        baseRevision,
        headCommit,
        input.authorId,
        JSON.stringify({ ...input.impactManifest, proposedChanges }),
        JSON.stringify(input.validationReport),
      ],
    );
    return {
      reviewId,
      branchName,
      baseRevision,
      headCommit,
      proposedChanges,
    };
  } catch (error) {
    await store.cleanupDraft(branchName).catch(() => undefined);
    throw error;
  }
}
''',
)

write(
    "apps/api/src/routes/interoperability.ts",
    r'''import { createHash } from "node:crypto";
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
          visible.flatMap((document) => [document.id, document.external_id ?? ""]),
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
      const binding = await resolveKnowledgeProfileBinding(db, spaceId, vaultId);
      const vault = await db.pool.query<{ current_revision: string | null }>(
        "select current_revision from vaults where id=$1 and space_id=$2",
        [vaultId, spaceId],
      );
      const bundle = OkfBundleV02.parse({
        format: "OKF",
        version: "0.2",
        bundleId: `akp-${vaultId}-${createHash("sha256")
          .update(visible.map((document) => `${document.id}:${document.current_revision}`).join("\n"))
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
          ...(document.content_hash ? { contentHash: document.content_hash } : {}),
          frontmatter: asRecord(document.frontmatter),
          evidence: evidenceByDocument.get(document.id) ?? [],
          provenance: {
            akpDocumentId: document.id,
            exportedPath: document.path,
          },
        })),
        relations: relationRows.rows.flatMap((relation): OkfRelationV02[] => {
          const fromId = portableIdByInternal.get(String(relation.from_document_id));
          const toId = portableIdByInternal.get(String(relation.to_document_id));
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
      const parsedMapping = OkfImportMapping.safeParse(request.body?.mapping ?? {});
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
''',
)

write(
    "apps/api/test/interoperability.test.ts",
    r'''import { describe, expect, it } from "vitest";
import {
  NEUTRAL_KNOWLEDGE_PROFILE_V1,
  canonicalKnowledgeProfileJson,
} from "@akp/contracts/knowledge-profile";
import { durableCompilerKnowledgeProfileContext } from "@akp/compiler";
import { createHash } from "node:crypto";
import {
  OkfBundleV02,
  OkfInteropError,
  canonicalOkfJson,
  okfToGraphMl,
  okfToJsonLd,
  planOkfReviewImport,
} from "../src/interoperability.js";

const canonical = canonicalKnowledgeProfileJson(NEUTRAL_KNOWLEDGE_PROFILE_V1);
const profile = durableCompilerKnowledgeProfileContext({
  revisionId: "00000000-0000-4000-8000-000000000901",
  profileHash: createHash("sha256").update(canonical).digest("hex"),
  profile: NEUTRAL_KNOWLEDGE_PROFILE_V1,
});

function bundle(overrides: Record<string, unknown> = {}) {
  return OkfBundleV02.parse({
    format: "OKF",
    version: "0.2",
    bundleId: "foreign-bundle-1",
    exportedAt: "2026-09-15T00:00:00.000Z",
    source: { system: "Foreign Knowledge System" },
    documents: [
      {
        id: "FOREIGN-1",
        externalId: "ADR-77",
        aliases: ["cache-note"],
        sourcePath: "knowledge/notes/cache.md",
        title: "Cache invalidation guidance",
        kind: "note",
        lifecycle: "DRAFT",
        trust: "ATTESTED",
        body: "# Cache invalidation\n\nForeign evidence says cache invalidation must be reviewed before it becomes local canonical knowledge. This body is intentionally substantive for validation.",
        frontmatter: { owner: "foreign-team", trust: "ATTESTED" },
        evidence: [
          {
            id: "E-1",
            trust: "ATTESTED",
            sourceReviewStatus: "ATTESTED",
          },
        ],
        provenance: { origin: "foreign-system" },
      },
    ],
    relations: [],
    ...overrides,
  });
}

describe("OKF v0.2 interoperability", () => {
  it("canonicalizes OKF and emits JSON-LD plus GraphML with provenance", () => {
    const source = bundle();
    expect(JSON.parse(canonicalOkfJson(source))).toMatchObject({
      format: "OKF",
      version: "0.2",
      bundleId: "foreign-bundle-1",
    });
    const jsonLd = okfToJsonLd(source);
    expect(jsonLd).toMatchObject({
      "@type": "akp:KnowledgeBundle",
      version: "0.2",
    });
    const graphMl = okfToGraphMl(source);
    expect(graphMl).toContain("<graphml");
    expect(graphMl).toContain("Cache invalidation guidance");
    expect(graphMl).toContain("foreign-system");
  });

  it("preserves foreign high trust but always produces an unverified review candidate", () => {
    const plan = planOkfReviewImport({
      bundle: bundle(),
      knowledgeProfile: profile,
      schemaProfile: {},
    });
    expect(plan.trustDisposition).toBe("LOCAL_UNVERIFIED_REVIEW_REQUIRED");
    expect(plan.reviewKinds).toEqual(["note"]);
    expect(plan.changes[0]?.path).toBe("knowledge/note/OKF-4E44DC153642E5DA.md");
    expect(plan.changes[0]?.content).toContain('trust: "UNVERIFIED"');
    expect(plan.changes[0]?.content).toContain('foreign_trust: "ATTESTED"');
    expect(plan.changes[0]?.content).toContain('"foreignDocumentId":"FOREIGN-1"');
  });

  it("requires explicit mapping for unknown kinds and lifecycles", () => {
    const unknownKind = bundle({
      documents: [
        {
          ...bundle().documents[0],
          kind: "foreign-decision",
        },
      ],
    });
    expect(() =>
      planOkfReviewImport({ bundle: unknownKind, knowledgeProfile: profile }),
    ).toThrowError(OkfInteropError);
    try {
      planOkfReviewImport({ bundle: unknownKind, knowledgeProfile: profile });
    } catch (error) {
      expect((error as OkfInteropError).code).toBe("OKF_KIND_MAPPING_REQUIRED");
    }

    const badLifecycle = bundle({
      documents: [
        {
          ...bundle().documents[0],
          lifecycle: "PUBLISHED",
        },
      ],
    });
    try {
      planOkfReviewImport({ bundle: badLifecycle, knowledgeProfile: profile });
    } catch (error) {
      expect((error as OkfInteropError).code).toBe(
        "OKF_LIFECYCLE_MAPPING_REQUIRED",
      );
    }
  });

  it("rejects unsafe foreign paths and never lets a bundle choose a target path", () => {
    const unsafe = bundle({
      documents: [
        {
          ...bundle().documents[0],
          sourcePath: "../escape.md",
        },
      ],
    });
    try {
      planOkfReviewImport({ bundle: unsafe, knowledgeProfile: profile });
      throw new Error("expected unsafe path rejection");
    } catch (error) {
      expect((error as OkfInteropError).code).toBe("OKF_FOREIGN_PATH_UNSAFE");
    }
    expect(
      OkfBundleV02.safeParse({
        ...bundle(),
        documents: [
          {
            ...bundle().documents[0],
            targetPath: "/tmp/owned.md",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("validates and preserves mapped relation semantics", () => {
    const second = {
      ...bundle().documents[0]!,
      id: "FOREIGN-2",
      externalId: "ADR-78",
      title: "Second note",
      sourcePath: "knowledge/notes/second.md",
    };
    const related = bundle({
      documents: [bundle().documents[0], second],
      relations: [
        {
          fromId: "FOREIGN-1",
          toId: "FOREIGN-2",
          type: "supports",
          weight: 1,
          provenance: "foreign-explicit",
        },
      ],
    });
    const plan = planOkfReviewImport({
      bundle: related,
      knowledgeProfile: profile,
    });
    expect(plan.changes[0]?.content).toContain('"localType":"supports"');
    expect(plan.changes[1]?.content).toContain('"localType":"supports"');
  });
});
''',
)

write(
    "apps/api/test/interoperability.integration.test.ts",
    r'''import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  NEUTRAL_KNOWLEDGE_PROFILE_V1,
  canonicalKnowledgeProfileJson,
} from "@akp/contracts/knowledge-profile";
import { GitKnowledgeStore } from "@akp/git-store";
import { Postgres, grantVaultMembership } from "@akp/postgres";

const spaceId = "00000000-0000-0000-0000-000000000003";
const adminId = "00000000-0000-0000-0000-000000000002";
const vaultId = randomUUID();
const token = `interop-admin-${randomUUID()}`;
const headers = { authorization: `Bearer ${token}` };
const tokenHash = createHash("sha256").update(token).digest("hex");
const profileRevisionId = randomUUID();

let app: FastifyInstance;
let db: Postgres;
let fixtureRoot: string;
const previousManagedRepository = process.env.AKP_MANAGED_REPO;
const reviewIds = new Set<string>();

function bundle(overrides: Record<string, unknown> = {}) {
  return {
    format: "OKF",
    version: "0.2",
    bundleId: "integration-foreign-bundle",
    exportedAt: "2026-09-15T00:00:00.000Z",
    source: { system: "Foreign Knowledge System" },
    documents: [
      {
        id: "FOREIGN-ATTESTED-1",
        externalId: "FOREIGN-ADR-1",
        aliases: ["foreign-cache-guidance"],
        sourcePath: "knowledge/notes/cache-guidance.md",
        title: "Foreign cache guidance",
        kind: "note",
        lifecycle: "DRAFT",
        trust: "ATTESTED",
        body: "# Foreign cache guidance\n\nThis externally attested statement remains an unverified local candidate until AKP review policy approves it. The text is intentionally substantive enough to exercise the actual Markdown validation path.",
        frontmatter: { trust: "ATTESTED" },
        evidence: [{ id: "FOREIGN-E-1", trust: "ATTESTED" }],
        provenance: { origin: "foreign-authority" },
      },
    ],
    relations: [],
    ...overrides,
  };
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests.");
  }
  process.env.NODE_ENV = "test";
  fixtureRoot = await mkdtemp(path.join(tmpdir(), "akp-interop-"));
  process.env.AKP_MANAGED_REPO = path.join(fixtureRoot, "managed");
  db = new Postgres(process.env.DATABASE_URL);

  await db.pool.query(
    `insert into api_tokens(user_id,token_hash,label)
     values($1,$2,'interop-integration') on conflict(token_hash) do nothing`,
    [adminId, tokenHash],
  );
  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,vault_key,
       git_repository,default_branch,local_path,content_roots,source_roots,
       schema_profile,eval_pack,retrieval_config,permissions,visibility,enabled
     ) values($1,$2,$3,'Interop Vault',true,'interop:source','interop-vault',null,'main',$3,
       array['.']::text[],array[]::text[],'{}'::jsonb,
       '{"name":"generic","version":"1","enabled":true,"criticalCases":[]}'::jsonb,
       '{}'::jsonb,'{}'::jsonb,'PRIVATE',true)`,
    [vaultId, spaceId, path.join(fixtureRoot, "readonly-vault")],
  );
  await grantVaultMembership(db, {
    userId: adminId,
    vaultId,
    role: "ADMIN",
    permissions: [
      "knowledge:read",
      "source:read",
      "source:write",
      "knowledge:propose",
      "knowledge:review",
      "eval:run",
      "admin",
    ],
  });
  const canonical = canonicalKnowledgeProfileJson(NEUTRAL_KNOWLEDGE_PROFILE_V1);
  const hash = createHash("sha256").update(canonical).digest("hex");
  await db.pool.query(
    `insert into knowledge_profile_revisions(
       id,space_id,vault_id,profile_id,version,profile_hash,canonical_profile,
       status,compatibility_class,created_by,validation_report,validated_at,activated_at
     ) values($1,$2,$3,$4,$5,$6,$7,'ACTIVE','NON_BREAKING',$8,'{}'::jsonb,now(),now())`,
    [
      profileRevisionId,
      spaceId,
      vaultId,
      NEUTRAL_KNOWLEDGE_PROFILE_V1.profileId,
      NEUTRAL_KNOWLEDGE_PROFILE_V1.version,
      hash,
      canonical,
      adminId,
    ],
  );
  await db.pool.query(
    "update vaults set active_knowledge_profile_revision_id=$2 where id=$1",
    [vaultId, profileRevisionId],
  );
  const module = await import(`../src/server.js?interop=${randomUUID()}`);
  app = module.buildServer();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  if (db) {
    if (reviewIds.size) {
      await db.pool.query("delete from reviews where id=any($1::uuid[])", [
        [...reviewIds],
      ]);
    }
    await db.pool.query(
      "update vaults set active_knowledge_profile_revision_id=null where id=$1",
      [vaultId],
    );
    await db.pool.query("delete from knowledge_profile_revisions where vault_id=$1", [
      vaultId,
    ]);
    await db.pool.query("delete from vault_memberships where vault_id=$1", [vaultId]);
    await db.pool.query("delete from knowledge_relations where space_id=$1 and (from_document_id in (select id from knowledge_documents where vault_id=$2) or to_document_id in (select id from knowledge_documents where vault_id=$2))", [spaceId, vaultId]);
    await db.pool.query("delete from knowledge_documents where vault_id=$1", [vaultId]);
    await db.pool.query("delete from vaults where id=$1", [vaultId]);
    await db.pool.query("delete from api_tokens where token_hash=$1", [tokenHash]);
    await db.close();
  }
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  if (previousManagedRepository === undefined) delete process.env.AKP_MANAGED_REPO;
  else process.env.AKP_MANAGED_REPO = previousManagedRepository;
});

describe("P1 OKF interoperability", () => {
  it("creates a review-first candidate and never promotes foreign trust", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/interoperability/import/okf",
      headers,
      payload: { spaceId, vaultId, bundle: bundle() },
    });
    expect(response.statusCode).toBe(201);
    const created = response.json() as {
      reviewId: string;
      headCommit: string;
      trustDisposition: string;
    };
    reviewIds.add(created.reviewId);
    expect(created.trustDisposition).toBe("LOCAL_UNVERIFIED_REVIEW_REQUIRED");
    const review = await db.pool.query<{
      status: string;
      head_commit: string;
      impact_manifest: {
        proposedChanges: Array<{ path: string }>;
        interoperability: Record<string, unknown>;
      };
    }>("select status,head_commit,impact_manifest from reviews where id=$1", [
      created.reviewId,
    ]);
    expect(review.rows[0]?.status).toBe("PENDING");
    expect(review.rows[0]?.impact_manifest.interoperability).toMatchObject({
      format: "OKF",
      version: "0.2",
      reviewRequired: true,
      targetPathsDerivedFromProfile: true,
      trustDisposition: "LOCAL_UNVERIFIED_REVIEW_REQUIRED",
    });
    const targetPath = review.rows[0]?.impact_manifest.proposedChanges[0]?.path;
    expect(targetPath).toMatch(/^knowledge\/note\/OKF-[A-F0-9]{16}\.md$/);
    const store = new GitKnowledgeStore(process.env.AKP_MANAGED_REPO!);
    const draft = await store.showFile(created.headCommit, targetPath!);
    expect(draft).toContain('trust: "UNVERIFIED"');
    expect(draft).toContain('foreign_trust: "ATTESTED"');
    const canonical = await db.pool.query(
      "select id from knowledge_documents where vault_id=$1 and path=$2",
      [vaultId, `managed/${targetPath}`],
    );
    expect(canonical.rowCount).toBe(0);
  });

  it("rejects unsafe imported paths before creating a review", async () => {
    const unsafeBundle = bundle({
      documents: [
        {
          ...(bundle().documents as Array<Record<string, unknown>>)[0],
          sourcePath: "../escape.md",
        },
      ],
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/interoperability/import/okf",
      headers,
      payload: { spaceId, vaultId, bundle: unsafeBundle },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "OKF_FOREIGN_PATH_UNSAFE" });
  });

  it("requires an explicit foreign type mapping", async () => {
    const foreign = bundle({
      documents: [
        {
          ...(bundle().documents as Array<Record<string, unknown>>)[0],
          kind: "foreign-decision",
        },
      ],
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/interoperability/import/okf",
      headers,
      payload: { spaceId, vaultId, bundle: foreign },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "OKF_KIND_MAPPING_REQUIRED" });
  });

  it("exports OKF, JSON-LD and GraphML from authorized canonical knowledge", async () => {
    const documentId = randomUUID();
    await db.pool.query(
      `insert into knowledge_documents(
         id,space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,
         current_revision,body_cache,frontmatter,aliases,layer,content_hash,token_estimate,raw_links
       ) values($1,$2,$3,$4,'LOCAL-EXPORT-1','Local export','note','ACTIVE','HUMAN_REVIEWED',
         'export:1',$5,$6::jsonb,array['export-alias']::text[],'knowledge',$7,64,'[]'::jsonb)`,
      [
        documentId,
        spaceId,
        vaultId,
        "knowledge/note/local-export.md",
        "# Local export\n\nThis canonical local note is exported through the governed interoperability route with its identity, lifecycle and trust preserved.",
        JSON.stringify({
          type: "note",
          title: "Local export",
          status: "ACTIVE",
          knowledge_layer: "knowledge",
        }),
        createHash("sha256").update("local-export").digest("hex"),
      ],
    );
    const okf = await app.inject({
      method: "POST",
      url: "/v1/interoperability/export",
      headers,
      payload: { spaceId, vaultId, format: "OKF_0_2", documentIds: [documentId] },
    });
    expect(okf.statusCode).toBe(200);
    expect(okf.json()).toMatchObject({
      format: "OKF",
      version: "0.2",
      documents: [
        {
          id: "LOCAL-EXPORT-1",
          kind: "note",
          lifecycle: "ACTIVE",
          trust: "HUMAN_REVIEWED",
        },
      ],
    });
    const jsonLd = await app.inject({
      method: "POST",
      url: "/v1/interoperability/export",
      headers,
      payload: { spaceId, vaultId, format: "JSON_LD", documentIds: [documentId] },
    });
    expect(jsonLd.statusCode).toBe(200);
    expect(jsonLd.json()).toMatchObject({ "@type": "akp:KnowledgeBundle" });
    const graphMl = await app.inject({
      method: "POST",
      url: "/v1/interoperability/export",
      headers,
      payload: { spaceId, vaultId, format: "GRAPHML", documentIds: [documentId] },
    });
    expect(graphMl.statusCode).toBe(200);
    expect(graphMl.body).toContain("<graphml");
    expect(graphMl.body).toContain("LOCAL-EXPORT-1");
  });
});
''',
)

replace_once(
    "apps/api/src/routes/reviews.ts",
    '''import {\n  claimReviewForPublication,\n  recordReviewApproval,\n  resolveProposalReviewPolicy,\n  reviewApprovalStatus,\n} from "../review-policy.js";\n''',
    '''import {\n  claimReviewForPublication,\n  recordReviewApproval,\n  resolveProposalReviewPolicy,\n  reviewApprovalStatus,\n} from "../review-policy.js";\nimport { createReviewDraft } from "../review-draft.js";\n''',
)

replace_once(
    "apps/api/src/routes/reviews.ts",
    '''      const reviewId = randomUUID();\n      const store = new GitKnowledgeStore(repositoryPath());\n      const baseRevision = await store.ensureRepository(\n        process.env.AKP_GIT_AUTHOR_NAME ?? "Architecture Knowledge Platform",\n        process.env.AKP_GIT_AUTHOR_EMAIL ?? "akp@localhost",\n      );\n      const branchName = await store.createDraftBranch(reviewId, baseRevision);\n      const proposedChanges = await Promise.all(\n        changes.map(async (change) => ({\n          path: change.path,\n          operation: (await store.hasFileAtRevision(baseRevision, change.path))\n            ? ("UPDATE" as const)\n            : ("CREATE" as const),\n          reasons: [change.reason ?? "Direct proposal"],\n        })),\n      );\n      for (const change of changes)\n        await store.writeDraftFile(change.path, change.content);\n      const headCommit = await store.commitAll(\n        request.body.summary ?? "knowledge: direct proposal",\n        process.env.AKP_GIT_AUTHOR_NAME ?? "Architecture Knowledge Platform",\n        process.env.AKP_GIT_AUTHOR_EMAIL ?? "akp@localhost",\n      );\n      try {\n        await db.pool.query(\n          `\n          insert into reviews(id,space_id,vault_id,branch_name,base_commit,head_commit,status,author_id,\n                              impact_manifest,validation_report)\n          values($1,$2,$3,$4,$5,$6,'PENDING',$7,$8::jsonb,$9::jsonb)\n          `,\n          [\n            reviewId,\n            spaceId,\n            vaultId,\n            branchName,\n            baseRevision,\n            headCommit,\n            actorOf(request)?.id ?? null,\n            JSON.stringify({\n              summary: request.body.summary ?? "",\n              proposedChanges,\n              reviewKinds: [...new Set(reviewKinds as string[])],\n              reviewPolicy: resolvedReviewPolicy.policy,\n              reviewPolicyPinned: resolvedReviewPolicy.pinned,\n            }),\n            JSON.stringify({ issues, errors: 0 }),\n          ],\n        );\n      } catch (error) {\n        await store.cleanupDraft(branchName).catch(() => undefined);\n        throw error;\n      }\n      await audit(\n        db,\n        request,\n        "knowledge.propose",\n        "review",\n        reviewId,\n        { vaultId },\n        spaceId,\n      );\n      return reply\n        .code(201)\n        .send({ reviewId, status: "PENDING", branchName, headCommit });\n''',
    '''      const created = await createReviewDraft(db, {\n        repositoryPath: repositoryPath(),\n        spaceId,\n        vaultId,\n        authorId: actorOf(request)?.id ?? null,\n        summary: request.body.summary ?? "knowledge: direct proposal",\n        changes,\n        defaultReason: "Direct proposal",\n        impactManifest: {\n          summary: request.body.summary ?? "",\n          reviewKinds: [...new Set(reviewKinds as string[])],\n          reviewPolicy: resolvedReviewPolicy.policy,\n          reviewPolicyPinned: resolvedReviewPolicy.pinned,\n        },\n        validationReport: { issues, errors: 0 },\n      });\n      await audit(\n        db,\n        request,\n        "knowledge.propose",\n        "review",\n        created.reviewId,\n        { vaultId },\n        spaceId,\n      );\n      return reply.code(201).send({\n        reviewId: created.reviewId,\n        status: "PENDING",\n        branchName: created.branchName,\n        headCommit: created.headCommit,\n      });\n''',
)

replace_once(
    "apps/api/src/server.ts",
    '''import { registerAuditExportRoutes } from "./routes/audit-export.js";\n''',
    '''import { registerAuditExportRoutes } from "./routes/audit-export.js";\nimport { registerInteroperabilityRoutes } from "./routes/interoperability.js";\n''',
)
replace_once(
    "apps/api/src/server.ts",
    '''  registerAuditExportRoutes(app, db, rawObjectStore);\n  registerProviderTaskRoutes(app, db);\n''',
    '''  registerAuditExportRoutes(app, db, rawObjectStore);\n  registerInteroperabilityRoutes(app, db);\n  registerProviderTaskRoutes(app, db);\n''',
)
