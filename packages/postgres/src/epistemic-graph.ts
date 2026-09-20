import { createHash } from "node:crypto";
import type { Postgres } from "./index.js";
import {
  PostgresFederatedGraphStore,
  type GraphProjectionRevision,
} from "./federated-graph.js";

type FederatedProjectionArtifact = Parameters<
  PostgresFederatedGraphStore["build"]
>[0];
type GraphNodeIdentity =
  FederatedProjectionArtifact["nodes"][number]["identity"];
type GraphRelationshipLifecycle = NonNullable<
  FederatedProjectionArtifact["edges"][number]["assertionLifecycle"]
>;

const EPISTEMIC_PROVIDER = "legacy-knowledge-relations";
const EPISTEMIC_PROVIDER_VERSION = "v0.3-envelope-1";
const EPISTEMIC_CONFIGURATION_VERSION = createHash("sha256")
  .update("epistemic-legacy-v0.3-envelope-v1")
  .digest("hex");

interface LegacyDocumentRow {
  id: string;
  path: string;
  external_id: string | null;
  title: string;
  type: string;
  lifecycle: string;
  trust_tier: string;
  current_revision: string;
  updated_at: Date | string;
}

interface LegacyRelationRow {
  id: string;
  from_document_id: string;
  to_document_id: string;
  relation_type: string;
  weight: number;
  provenance: string;
  metadata: Record<string, unknown>;
}

export interface LegacyEpistemicProjectionInput {
  spaceId: string;
  vaultId: string;
  scopeId?: string;
}

export interface LegacyEpistemicProjectionPlan {
  artifact: FederatedProjectionArtifact;
  sourceDocumentCount: number;
  sourceRelationCount: number;
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

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function identity(
  document: LegacyDocumentRow,
  scopeId: string,
): GraphNodeIdentity {
  return {
    graphDomain: "EPISTEMIC",
    scopeId,
    kind: document.type.trim() || "knowledge",
    canonicalKey: document.path,
    revision: document.current_revision,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, 256)
    : [];
}

function optionalString(value: unknown, maxLength = 1024): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return undefined;
  return normalized;
}

function optionalDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : undefined;
}

function assertionLifecycle(
  metadata: Record<string, unknown>,
): GraphRelationshipLifecycle {
  const value = metadata.lifecycle;
  return value === "ACTIVE" ||
    value === "DISPUTED" ||
    value === "SUPERSEDED" ||
    value === "RETIRED"
    ? value
    : "ACTIVE";
}

export async function planLegacyEpistemicGraphProjection(
  db: Postgres,
  input: LegacyEpistemicProjectionInput,
): Promise<LegacyEpistemicProjectionPlan> {
  const vault = await db.pool.query<{ current_revision: string }>(
    `select current_revision
       from vaults
      where id=$1 and space_id=$2 and enabled=true
      limit 1`,
    [input.vaultId, input.spaceId],
  );
  const sourceRevision = vault.rows[0]?.current_revision?.trim();
  if (!sourceRevision) {
    throw new Error("EPISTEMIC_SOURCE_VAULT_NOT_FOUND");
  }

  const documents = await db.pool.query<LegacyDocumentRow>(
    `select id::text,path,external_id,title,type,lifecycle,trust_tier,
            current_revision,updated_at
       from knowledge_documents
      where space_id=$1 and vault_id=$2
        and lifecycle in ('ACTIVE','DISPUTED')
      order by path,id`,
    [input.spaceId, input.vaultId],
  );
  const relations = await db.pool.query<LegacyRelationRow>(
    `select r.id::text,r.from_document_id::text,r.to_document_id::text,
            r.relation_type,r.weight,r.provenance,r.metadata
       from knowledge_relations r
       join knowledge_documents source
         on source.id=r.from_document_id and source.space_id=r.space_id
       join knowledge_documents target
         on target.id=r.to_document_id and target.space_id=r.space_id
      where r.space_id=$1
        and source.vault_id=$2
        and target.vault_id=$2
        and source.lifecycle in ('ACTIVE','DISPUTED')
        and target.lifecycle in ('ACTIVE','DISPUTED')
      order by r.from_document_id,r.to_document_id,r.relation_type,r.id`,
    [input.spaceId, input.vaultId],
  );

  const scopeId = input.scopeId?.trim() || `epistemic:vault:${input.vaultId}`;
  const documentsById = new Map(documents.rows.map((row) => [row.id, row]));
  const identityById = new Map(
    documents.rows.map((row) => [row.id, identity(row, scopeId)]),
  );
  const sourceHash = sha256(
    stableJson({
      sourceRevision,
      documents: documents.rows.map((row) => ({
        id: row.id,
        path: row.path,
        externalId: row.external_id,
        title: row.title,
        type: row.type,
        lifecycle: row.lifecycle,
        trustTier: row.trust_tier,
        revision: row.current_revision,
        updatedAt: iso(row.updated_at),
      })),
      relations: relations.rows.map((row) => ({
        id: row.id,
        from: row.from_document_id,
        to: row.to_document_id,
        relation: row.relation_type,
        weight: Number(row.weight),
        provenance: row.provenance,
        metadata: row.metadata,
      })),
    }),
  );
  const revision = `epistemic:${sourceHash}`;

  const artifact: FederatedProjectionArtifact = {
    graphDomain: "EPISTEMIC",
    spaceId: input.spaceId,
    vaultId: input.vaultId,
    scopeId,
    revision,
    sourceRevision,
    sourceHash,
    provider: EPISTEMIC_PROVIDER,
    providerVersion: EPISTEMIC_PROVIDER_VERSION,
    configurationVersion: EPISTEMIC_CONFIGURATION_VERSION,
    nodes: documents.rows.map((row) => ({
      identity: identityById.get(row.id)!,
      vaultId: input.vaultId,
      authorizationPath: row.path,
      payload: {
        legacyDocumentId: row.id,
        externalId: row.external_id,
        title: row.title,
        path: row.path,
        type: row.type,
        lifecycle: row.lifecycle,
        trustTier: row.trust_tier,
      },
    })),
    edges: relations.rows.map((row) => {
      const from = identityById.get(row.from_document_id);
      const to = identityById.get(row.to_document_id);
      const source = documentsById.get(row.from_document_id);
      const target = documentsById.get(row.to_document_id);
      if (!from || !to || !source || !target) {
        throw new Error("EPISTEMIC_RELATION_ENDPOINT_MISSING");
      }
      const metadata = row.metadata ?? {};
      const evidenceIds = stringArray(
        metadata.evidenceIds ?? metadata.evidence_ids,
      );
      const supportSetId = optionalString(
        metadata.supportSetId ?? metadata.support_set_id,
      );
      const confidence =
        typeof metadata.confidence === "number" &&
        metadata.confidence >= 0 &&
        metadata.confidence <= 1
          ? metadata.confidence
          : undefined;
      const validFrom = optionalDate(metadata.validFrom ?? metadata.valid_from);
      const validTo = optionalDate(metadata.validTo ?? metadata.valid_to);
      const recordedAt =
        Date.parse(iso(source.updated_at)) >= Date.parse(iso(target.updated_at))
          ? iso(source.updated_at)
          : iso(target.updated_at);
      return {
        from,
        relation: row.relation_type,
        to,
        authorizationPath: source.path,
        assertionLifecycle: assertionLifecycle(metadata),
        provenance: {
          derivation: "SOURCE_EXPLICIT",
          sourceIds: [
            `knowledge-relation:${row.id}`,
            `legacy-provenance:${row.provenance}`,
          ],
          evidenceIds,
          locatorRefs: [source.path, target.path],
          revision: sourceRevision,
          ...(supportSetId ? { supportSetId } : {}),
          ...(confidence === undefined ? {} : { confidence }),
          ...(validFrom ? { validFrom } : {}),
          ...(validTo ? { validTo } : {}),
          recordedAt,
        },
      };
    }),
  };

  return {
    artifact,
    sourceDocumentCount: documents.rowCount ?? documents.rows.length,
    sourceRelationCount: relations.rowCount ?? relations.rows.length,
  };
}

export async function rebuildLegacyEpistemicGraphProjection(
  db: Postgres,
  input: LegacyEpistemicProjectionInput,
): Promise<GraphProjectionRevision> {
  const plan = await planLegacyEpistemicGraphProjection(db, input);
  return await new PostgresFederatedGraphStore(db).build(plan.artifact);
}
