import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";
import { TrustTier } from "@akp/contracts";
import {
  deriveProfileKnowledgePath,
  type CompilerKnowledgeProfileContext,
} from "@akp/compiler";

const SHA256 = /^[a-f0-9]{64}$/;
export const MAX_OKF_BUNDLE_BYTES = 8 * 1024 * 1024;
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

function assertOkfBundleSize(bundle: OkfBundleV02): void {
  const actualBytes = Buffer.byteLength(canonicalOkfJson(bundle), "utf8");
  if (actualBytes > MAX_OKF_BUNDLE_BYTES) {
    throw new OkfInteropError("OKF_BUNDLE_TOO_LARGE", {
      actualBytes,
      maxBytes: MAX_OKF_BUNDLE_BYTES,
    });
  }
}

function portablePathCollisionKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
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
    segments.some(
      (segment) => !segment || segment === "." || segment === "..",
    ) ||
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

export function okfToJsonLd(
  bundleInput: OkfBundleV02,
): Record<string, unknown> {
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
      (
        relation,
        index,
      ) => `    <edge id="e${index}" source="${xmlEscape(relation.fromId)}" target="${xmlEscape(relation.toId)}">
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
      relation.fromId === document.localId ||
      relation.toId === document.localId,
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
  assertOkfBundleSize(bundle);
  const mapping = OkfImportMapping.parse(input.mapping ?? {});
  const documents = new Map<string, LocalDocumentMapping>();
  const usedPaths = new Set<string>();
  const foreignSourcePaths = new Map<
    string,
    { path: string; foreignDocumentId: string }
  >();

  for (const foreign of bundle.documents) {
    if (foreign.sourcePath) {
      const normalizedForeignPath = assertSafeForeignSourcePath(
        foreign.sourcePath,
      );
      const collisionKey = portablePathCollisionKey(normalizedForeignPath);
      const previous = foreignSourcePaths.get(collisionKey);
      if (previous && previous.foreignDocumentId !== foreign.id) {
        throw new OkfInteropError("OKF_FOREIGN_PATH_COLLISION", {
          path: normalizedForeignPath,
          conflictsWith: previous.path,
          foreignDocumentId: foreign.id,
          conflictingDocumentId: previous.foreignDocumentId,
        });
      }
      foreignSourcePaths.set(collisionKey, {
        path: normalizedForeignPath,
        foreignDocumentId: foreign.id,
      });
    }
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
    foreignTrustTiers: [
      ...new Set(bundle.documents.map((entry) => entry.trust)),
    ],
    trustDisposition: "LOCAL_UNVERIFIED_REVIEW_REQUIRED",
  };
}
