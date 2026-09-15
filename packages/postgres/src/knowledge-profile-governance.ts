import type {
  KnowledgeProfileCompatibility,
  KnowledgeProfileRevisionStatus,
} from "@akp/contracts/knowledge-profile";
import type { Postgres } from "./index.js";
import {
  getKnowledgeProfileRevision,
  type KnowledgeProfileRevisionRecord,
} from "./knowledge-profile-registry.js";

export interface RecordKnowledgeProfileValidationInput {
  spaceId: string;
  vaultId: string;
  revisionId: string;
  compatibilityClass: KnowledgeProfileCompatibility;
  validationReport: Record<string, unknown>;
}

function validationStatus(
  compatibilityClass: KnowledgeProfileCompatibility,
): Extract<KnowledgeProfileRevisionStatus, "VALIDATED" | "REVIEW_REQUIRED"> {
  return compatibilityClass === "NON_BREAKING"
    ? "VALIDATED"
    : "REVIEW_REQUIRED";
}

/**
 * Persist validation only while the corpus revision captured by the immutable
 * draft still matches the vault's current corpus revision. This prevents a
 * profile from being validated against one snapshot and later presented as if
 * it were validated against a different corpus.
 */
export async function recordKnowledgeProfileValidation(
  db: Postgres,
  input: RecordKnowledgeProfileValidationInput,
): Promise<KnowledgeProfileRevisionRecord> {
  const targetStatus = validationStatus(input.compatibilityClass);
  const result = await db.pool.query<{ id: string }>(
    `
    update knowledge_profile_revisions p
       set status=$4,
           compatibility_class=$5,
           validation_report=$6::jsonb,
           validated_at=coalesce(p.validated_at,now()),
           updated_at=now()
      from vaults v
      left join vault_index_revisions r
        on r.space_id=v.space_id and r.vault_id=v.id
     where p.id=$3
       and p.space_id=$1
       and p.vault_id=$2
       and p.status='DRAFT'
       and v.space_id=p.space_id
       and v.id=p.vault_id
       and p.corpus_revision=coalesce(r.corpus_revision,v.current_revision,'unknown')
    returning p.id
    `,
    [
      input.spaceId,
      input.vaultId,
      input.revisionId,
      targetStatus,
      input.compatibilityClass,
      JSON.stringify(input.validationReport),
    ],
  );

  if (result.rows[0]) {
    const revision = await getKnowledgeProfileRevision(
      db,
      input.spaceId,
      input.vaultId,
      input.revisionId,
    );
    if (!revision) throw new Error("KNOWLEDGE_PROFILE_REVISION_NOT_FOUND");
    return revision;
  }

  const existing = await getKnowledgeProfileRevision(
    db,
    input.spaceId,
    input.vaultId,
    input.revisionId,
  );
  if (!existing) throw new Error("KNOWLEDGE_PROFILE_REVISION_NOT_FOUND");

  if (
    existing.status === targetStatus &&
    existing.compatibilityClass === input.compatibilityClass
  ) {
    return existing;
  }
  if (existing.status !== "DRAFT") {
    throw new Error("KNOWLEDGE_PROFILE_REVISION_NOT_DRAFT");
  }
  throw new Error("CONTEXT_REVISION_CHANGED");
}
