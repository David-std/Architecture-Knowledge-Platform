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
  expectedCorpusRevision: string;
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
 * Persist validation only while the caller's corpus revision still matches the
 * vault. Corpus identity belongs to the validation evidence, not to the
 * semantic profile revision, so the same immutable profile can be revalidated
 * after corpus changes without creating a duplicate profile revision.
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
           validated_at=now(),
           updated_at=now()
      from vaults v
      left join vault_index_revisions r
        on r.space_id=v.space_id and r.vault_id=v.id
     where p.id=$3
       and p.space_id=$1
       and p.vault_id=$2
       and p.status in ('DRAFT','VALIDATED','REVIEW_REQUIRED')
       and v.space_id=p.space_id
       and v.id=p.vault_id
       and coalesce(r.corpus_revision,v.current_revision,'unknown')=$7
    returning p.id
    `,
    [
      input.spaceId,
      input.vaultId,
      input.revisionId,
      targetStatus,
      input.compatibilityClass,
      JSON.stringify(input.validationReport),
      input.expectedCorpusRevision,
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
  if (!["DRAFT", "VALIDATED", "REVIEW_REQUIRED"].includes(existing.status)) {
    throw new Error("KNOWLEDGE_PROFILE_REVISION_NOT_VALIDATABLE");
  }
  throw new Error("CONTEXT_REVISION_CHANGED");
}
