import type { Postgres } from "./index.js";

export type KnowledgeProfileRevisionStatus =
  | "DRAFT"
  | "VALIDATED"
  | "REVIEW_REQUIRED"
  | "ACTIVE"
  | "SUPERSEDED"
  | "RETIRED";

export type KnowledgeProfileCompatibility =
  | "NON_BREAKING"
  | "REINDEX_REQUIRED"
  | "RECOMPILE_REQUIRED"
  | "MIGRATION_REQUIRED"
  | "UNSAFE";

interface KnowledgeProfileRevisionRow {
  id: string;
  space_id: string;
  vault_id: string;
  profile_id: string;
  version: string;
  profile_hash: string;
  canonical_profile: string;
  status: KnowledgeProfileRevisionStatus;
  compatibility_class: KnowledgeProfileCompatibility | null;
  supersedes_revision_id: string | null;
  created_by: string | null;
  validation_report: unknown;
  validated_at: Date | null;
  activated_at: Date | null;
  superseded_at: Date | null;
  retired_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface KnowledgeProfileRevisionRecord {
  id: string;
  spaceId: string;
  vaultId: string;
  profileId: string;
  version: string;
  profileHash: string;
  canonicalProfile: string;
  profile: Record<string, unknown>;
  status: KnowledgeProfileRevisionStatus;
  compatibilityClass: KnowledgeProfileCompatibility | null;
  supersedesRevisionId: string | null;
  createdBy: string | null;
  validationReport: Record<string, unknown>;
  validatedAt: Date | null;
  activatedAt: Date | null;
  supersededAt: Date | null;
  retiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateKnowledgeProfileDraftInput {
  spaceId: string;
  vaultId: string;
  profileId: string;
  version: string;
  canonicalProfile: string;
  profileHash: string;
  supersedesRevisionId?: string | null;
  createdBy?: string | null;
}

export interface KnowledgeProfileBinding {
  source: "DURABLE_REVISION" | "LEGACY_UNBOUND";
  revision: KnowledgeProfileRevisionRecord | null;
  legacySchemaProfile: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function parseCanonicalProfile(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  const record = asRecord(parsed);
  if (Object.keys(record).length === 0) {
    throw new Error("KNOWLEDGE_PROFILE_CANONICAL_OBJECT_REQUIRED");
  }
  return record;
}

function mapRevision(
  row: KnowledgeProfileRevisionRow,
): KnowledgeProfileRevisionRecord {
  return {
    id: row.id,
    spaceId: row.space_id,
    vaultId: row.vault_id,
    profileId: row.profile_id,
    version: row.version,
    profileHash: row.profile_hash,
    canonicalProfile: row.canonical_profile,
    profile: parseCanonicalProfile(row.canonical_profile),
    status: row.status,
    compatibilityClass: row.compatibility_class,
    supersedesRevisionId: row.supersedes_revision_id,
    createdBy: row.created_by,
    validationReport: asRecord(row.validation_report),
    validatedAt: row.validated_at,
    activatedAt: row.activated_at,
    supersededAt: row.superseded_at,
    retiredAt: row.retired_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Persist an immutable semantic draft that has already been validated and
 * canonicalized by the contracts layer. PostgreSQL independently verifies the
 * canonical JSON shape and SHA-256 through migration constraints.
 */
export async function createKnowledgeProfileDraft(
  db: Postgres,
  input: CreateKnowledgeProfileDraftInput,
): Promise<KnowledgeProfileRevisionRecord> {
  const result = await db.pool.query<KnowledgeProfileRevisionRow>(
    `
    with inserted as (
      insert into knowledge_profile_revisions(
        space_id,vault_id,profile_id,version,profile_hash,canonical_profile,
        status,compatibility_class,supersedes_revision_id,created_by
      )
      select v.space_id,v.id,$3,$4,$5,$6,'DRAFT',null,$7,$8
        from vaults v
       where v.space_id=$1 and v.id=$2
      on conflict (vault_id,profile_hash) do nothing
      returning *
    )
    select * from inserted
    union all
    select p.*
      from knowledge_profile_revisions p
     where p.space_id=$1 and p.vault_id=$2 and p.profile_hash=$5
       and not exists (select 1 from inserted)
    limit 1
    `,
    [
      input.spaceId,
      input.vaultId,
      input.profileId,
      input.version,
      input.profileHash,
      input.canonicalProfile,
      input.supersedesRevisionId ?? null,
      input.createdBy ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("VAULT_NOT_FOUND_OR_SCOPE_MISMATCH");
  return mapRevision(row);
}

export async function getKnowledgeProfileRevision(
  db: Postgres,
  spaceId: string,
  vaultId: string,
  revisionId: string,
): Promise<KnowledgeProfileRevisionRecord | null> {
  const result = await db.pool.query<KnowledgeProfileRevisionRow>(
    `
    select *
      from knowledge_profile_revisions
     where space_id=$1 and vault_id=$2 and id=$3
    `,
    [spaceId, vaultId, revisionId],
  );
  return result.rows[0] ? mapRevision(result.rows[0]) : null;
}

export async function getActiveKnowledgeProfileRevision(
  db: Postgres,
  spaceId: string,
  vaultId: string,
): Promise<KnowledgeProfileRevisionRecord | null> {
  const result = await db.pool.query<KnowledgeProfileRevisionRow>(
    `
    select p.*
      from vaults v
      join knowledge_profile_revisions p
        on p.vault_id=v.id and p.id=v.active_knowledge_profile_revision_id
     where v.space_id=$1 and v.id=$2 and p.status='ACTIVE'
    `,
    [spaceId, vaultId],
  );
  return result.rows[0] ? mapRevision(result.rows[0]) : null;
}

/**
 * Resolve only the durable persistence binding. The contracts/application
 * layer supplies the v0.3-compatible semantic default when no revision is
 * active, so PostgreSQL does not become a second profile-definition authority.
 */
export async function resolveKnowledgeProfileBinding(
  db: Postgres,
  spaceId: string,
  vaultId: string,
): Promise<KnowledgeProfileBinding> {
  const vault = await db.pool.query<{
    schema_profile: unknown;
    active_knowledge_profile_revision_id: string | null;
  }>(
    `
    select schema_profile,active_knowledge_profile_revision_id
      from vaults where space_id=$1 and id=$2
    `,
    [spaceId, vaultId],
  );
  const vaultRow = vault.rows[0];
  if (!vaultRow) throw new Error("VAULT_NOT_FOUND_OR_SCOPE_MISMATCH");

  if (vaultRow.active_knowledge_profile_revision_id) {
    const active = await getActiveKnowledgeProfileRevision(
      db,
      spaceId,
      vaultId,
    );
    if (!active) throw new Error("ACTIVE_KNOWLEDGE_PROFILE_BINDING_INVALID");
    return {
      source: "DURABLE_REVISION",
      revision: active,
      legacySchemaProfile: asRecord(vaultRow.schema_profile),
    };
  }

  return {
    source: "LEGACY_UNBOUND",
    revision: null,
    legacySchemaProfile: asRecord(vaultRow.schema_profile),
  };
}
