import type {
  KnowledgeProfileCompatibility,
  KnowledgeProfileRevisionStatus,
} from "@akp/contracts/knowledge-profile";
import type { Postgres } from "./index.js";
import {
  getKnowledgeProfileRevision,
  type KnowledgeProfileRevisionRecord,
} from "./knowledge-profile-registry.js";

export interface RecordKnowledgeProfileDryRunInput {
  spaceId: string;
  vaultId: string;
  revisionId: string;
  actorId: string | null;
  expectedCorpusRevision: string;
  compatibilityClass: KnowledgeProfileCompatibility;
  affectedDocumentCount: number;
  report: Record<string, unknown>;
  corpusFingerprintBefore: string;
  corpusFingerprintAfter: string;
}

export interface RecordedKnowledgeProfileDryRun {
  id: string;
  createdAt: Date;
  revision: KnowledgeProfileRevisionRecord;
}

function validationStatus(
  compatibilityClass: KnowledgeProfileCompatibility,
): Extract<KnowledgeProfileRevisionStatus, "VALIDATED" | "REVIEW_REQUIRED"> {
  return compatibilityClass === "NON_BREAKING"
    ? "VALIDATED"
    : "REVIEW_REQUIRED";
}

function legacyCompatibilityStatus(
  compatibilityClass: KnowledgeProfileCompatibility,
): "COMPATIBLE" | "MIGRATION_REQUIRED" {
  return compatibilityClass === "MIGRATION_REQUIRED" ||
    compatibilityClass === "UNSAFE"
    ? "MIGRATION_REQUIRED"
    : "COMPATIBLE";
}

/**
 * Atomically persist profile validation and its dry-run evidence. The semantic
 * profile revision is corpus-independent; the validation evidence is pinned to
 * the explicit corpus revision and fingerprints supplied by the read snapshot.
 */
export async function recordKnowledgeProfileDryRun(
  db: Postgres,
  input: RecordKnowledgeProfileDryRunInput,
): Promise<RecordedKnowledgeProfileDryRun> {
  const targetStatus = validationStatus(input.compatibilityClass);
  const client = await db.pool.connect();
  let dryRun: { id: string; created_at: Date } | undefined;
  try {
    await client.query("begin isolation level serializable");
    const current = await client.query<{ revision: string }>(
      `
      select coalesce(r.corpus_revision,v.current_revision,'unknown') revision
        from vaults v
        left join vault_index_revisions r
          on r.space_id=v.space_id and r.vault_id=v.id
       where v.space_id=$1 and v.id=$2
       for update of v
      `,
      [input.spaceId, input.vaultId],
    );
    if (!current.rows[0]) throw new Error("VAULT_NOT_FOUND_OR_SCOPE_MISMATCH");
    if (current.rows[0].revision !== input.expectedCorpusRevision) {
      throw new Error("CONTEXT_REVISION_CHANGED");
    }
    if (input.corpusFingerprintBefore !== input.corpusFingerprintAfter) {
      throw new Error("CONTEXT_REVISION_CHANGED");
    }

    const updated = await client.query<{ version: string; profile_hash: string }>(
      `
      update knowledge_profile_revisions
         set status=$4,
             compatibility_class=$5,
             validation_report=$6::jsonb,
             validated_at=now(),
             updated_at=now()
       where id=$3 and space_id=$1 and vault_id=$2
         and status in ('DRAFT','VALIDATED','REVIEW_REQUIRED')
      returning version,profile_hash
      `,
      [
        input.spaceId,
        input.vaultId,
        input.revisionId,
        targetStatus,
        input.compatibilityClass,
        JSON.stringify(input.report),
      ],
    );
    const revision = updated.rows[0];
    if (!revision) {
      const existing = await client.query<{ status: string }>(
        `
        select status from knowledge_profile_revisions
         where id=$3 and space_id=$1 and vault_id=$2
        `,
        [input.spaceId, input.vaultId, input.revisionId],
      );
      if (!existing.rows[0]) {
        throw new Error("KNOWLEDGE_PROFILE_REVISION_NOT_FOUND");
      }
      throw new Error("KNOWLEDGE_PROFILE_REVISION_NOT_VALIDATABLE");
    }

    const inserted = await client.query<{ id: string; created_at: Date }>(
      `
      insert into schema_dry_runs(
        space_id,vault_id,actor_id,candidate_version,candidate_hash,
        corpus_revision,affected_document_count,compatibility_status,
        compatibility_class,profile_revision_id,report,
        corpus_fingerprint_before,corpus_fingerprint_after
      ) values(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13
      ) returning id,created_at
      `,
      [
        input.spaceId,
        input.vaultId,
        input.actorId,
        revision.version,
        revision.profile_hash,
        input.expectedCorpusRevision,
        input.affectedDocumentCount,
        legacyCompatibilityStatus(input.compatibilityClass),
        input.compatibilityClass,
        input.revisionId,
        JSON.stringify(input.report),
        input.corpusFingerprintBefore,
        input.corpusFingerprintAfter,
      ],
    );
    dryRun = inserted.rows[0];
    if (!dryRun) throw new Error("KNOWLEDGE_PROFILE_DRY_RUN_PERSISTENCE_FAILED");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const revision = await getKnowledgeProfileRevision(
    db,
    input.spaceId,
    input.vaultId,
    input.revisionId,
  );
  if (!revision) throw new Error("KNOWLEDGE_PROFILE_REVISION_NOT_FOUND");
  return { id: dryRun.id, createdAt: dryRun.created_at, revision };
}
