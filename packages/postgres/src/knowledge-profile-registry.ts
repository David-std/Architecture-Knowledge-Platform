import { createHash } from "node:crypto";
import {
  DEFAULT_KNOWLEDGE_PROFILE_V1,
  KnowledgeProfileV1,
  canonicalKnowledgeProfileJson,
  type KnowledgeProfileCompatibility,
  type KnowledgeProfileRevisionStatus,
} from "@akp/contracts/knowledge-profile";
import type { Postgres } from "./index.js";

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
  profile: KnowledgeProfileV1;
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
  profile: unknown;
  supersedesRevisionId?: string | null;
  createdBy?: string | null;
}

export interface EffectiveKnowledgeProfile {
  source: "DURABLE_REVISION" | "V03_DEFAULT";
  revisionId: string | null;
  profileHash: string;
  profile: KnowledgeProfileV1;
  legacySchemaProfile: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function hashCanonicalProfile(profile: unknown): {
  parsed: KnowledgeProfileV1;
  canonical: string;
  hash: string;
} {
  const canonical = canonicalKnowledgeProfileJson(profile);
  const parsed = KnowledgeProfileV1.parse(JSON.parse(canonical));
  return {
    parsed,
    canonical,
    hash: createHash("sha256").update(canonical).digest("hex"),
  };
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
    profile: KnowledgeProfileV1.parse(JSON.parse(row.canonical_profile)),
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
 * Persist an immutable semantic draft. The profile hash is calculated from the
 * canonical validated contract, never from caller key order. No activation or
 * compatibility claim is made here.
 */
export async function createKnowledgeProfileDraft(
  db: Postgres,
  input: CreateKnowledgeProfileDraftInput,
): Promise<KnowledgeProfileRevisionRecord> {
  const { parsed, canonical, hash } = hashCanonicalProfile(input.profile);
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
      parsed.profileId,
      parsed.version,
      hash,
      canonical,
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
 * Resolve the semantic profile without changing any v0.3 consumer. Durable
 * revisions win only after an explicit active binding exists. Otherwise the
 * built-in v0.3-compatible KnowledgeProfile is returned while the old
 * schema_profile JSON is retained only as legacy configuration metadata.
 */
export async function resolveEffectiveKnowledgeProfile(
  db: Postgres,
  spaceId: string,
  vaultId: string,
): Promise<EffectiveKnowledgeProfile> {
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
    const active = await getActiveKnowledgeProfileRevision(db, spaceId, vaultId);
    if (!active) throw new Error("ACTIVE_KNOWLEDGE_PROFILE_BINDING_INVALID");
    return {
      source: "DURABLE_REVISION",
      revisionId: active.id,
      profileHash: active.profileHash,
      profile: active.profile,
      legacySchemaProfile: asRecord(vaultRow.schema_profile),
    };
  }

  const fallback = hashCanonicalProfile(DEFAULT_KNOWLEDGE_PROFILE_V1);
  return {
    source: "V03_DEFAULT",
    revisionId: null,
    profileHash: fallback.hash,
    profile: fallback.parsed,
    legacySchemaProfile: asRecord(vaultRow.schema_profile),
  };
}
