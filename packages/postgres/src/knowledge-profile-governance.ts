import type { Postgres } from "./index.js";
import {
  getKnowledgeProfileRevision,
  type KnowledgeProfileCompatibility,
  type KnowledgeProfileRevisionRecord,
  type KnowledgeProfileRevisionStatus,
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

export interface ActivateKnowledgeProfileInput {
  spaceId: string;
  vaultId: string;
  revisionId: string;
  dryRunId: string;
  expectedProfileHash: string;
  expectedCorpusRevision: string;
  actorId: string;
  traceId: string;
}

export interface ActivatedKnowledgeProfile {
  revision: KnowledgeProfileRevisionRecord;
  previousRevisionId: string | null;
  corpusRevision: string;
  dryRunId: string;
  alreadyActive: boolean;
}

export interface RollbackKnowledgeProfileInput {
  spaceId: string;
  vaultId: string;
  targetRevisionId: string;
  dryRunId: string;
  expectedProfileHash: string;
  expectedCorpusRevision: string;
  expectedActiveRevisionId: string;
  actorId: string;
  traceId: string;
}

export interface RolledBackKnowledgeProfile {
  revision: KnowledgeProfileRevisionRecord;
  rolledBackFromRevisionId: string | null;
  corpusRevision: string;
  dryRunId: string;
  alreadyActive: boolean;
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
 *
 * A SUPERSEDED revision may be revalidated as a rollback target. Its historical
 * lifecycle metadata is not rewritten by validation; the fresh compatibility
 * evidence lives in schema_dry_runs and is consumed only by the rollback path.
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

    const updated = await client.query<{
      version: string;
      profile_hash: string;
    }>(
      `
      update knowledge_profile_revisions
         set status=case when status='SUPERSEDED' then status else $4 end,
             compatibility_class=case
               when status='SUPERSEDED' then compatibility_class else $5
             end,
             validation_report=case
               when status='SUPERSEDED' then validation_report else $6::jsonb
             end,
             validated_at=case
               when status='SUPERSEDED' then validated_at else now()
             end,
             updated_at=case
               when status='SUPERSEDED' then updated_at else now()
             end
       where id=$3 and space_id=$1 and vault_id=$2
         and status in ('DRAFT','VALIDATED','REVIEW_REQUIRED','SUPERSEDED')
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
    if (!dryRun)
      throw new Error("KNOWLEDGE_PROFILE_DRY_RUN_PERSISTENCE_FAILED");
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

/**
 * Activate only a non-breaking profile that was validated against the exact
 * current corpus snapshot. Breaking profiles intentionally remain blocked at
 * REVIEW_REQUIRED until a dedicated profile-review workflow exists.
 */
export async function activateKnowledgeProfile(
  db: Postgres,
  input: ActivateKnowledgeProfileInput,
): Promise<ActivatedKnowledgeProfile> {
  const client = await db.pool.connect();
  let previousRevisionId: string | null = null;
  let alreadyActive = false;
  try {
    await client.query("begin isolation level serializable");
    const vaultResult = await client.query<{
      active_revision_id: string | null;
      corpus_revision: string;
    }>(
      `
      select v.active_knowledge_profile_revision_id active_revision_id,
             coalesce(r.corpus_revision,v.current_revision,'unknown') corpus_revision
        from vaults v
        left join vault_index_revisions r
          on r.space_id=v.space_id and r.vault_id=v.id
       where v.space_id=$1 and v.id=$2
       for update of v
      `,
      [input.spaceId, input.vaultId],
    );
    const vault = vaultResult.rows[0];
    if (!vault) throw new Error("VAULT_NOT_FOUND_OR_SCOPE_MISMATCH");
    if (vault.corpus_revision !== input.expectedCorpusRevision) {
      throw new Error("CONTEXT_REVISION_CHANGED");
    }
    previousRevisionId = vault.active_revision_id;

    const fingerprintResult = await client.query<{ fingerprint: string }>(
      `
      select encode(digest(coalesce(string_agg(
        id::text||':'||coalesce(content_hash,'')||':'||current_revision,
        '|' order by id
      ),''),'sha256'),'hex') fingerprint
        from knowledge_documents where space_id=$1 and vault_id=$2
      `,
      [input.spaceId, input.vaultId],
    );
    const currentFingerprint = String(
      fingerprintResult.rows[0]?.fingerprint ?? "",
    );

    const candidateResult = await client.query<{
      id: string;
      profile_hash: string;
      status: KnowledgeProfileRevisionStatus;
      compatibility_class: KnowledgeProfileCompatibility | null;
      supersedes_revision_id: string | null;
    }>(
      `
      select id,profile_hash,status,compatibility_class,supersedes_revision_id
        from knowledge_profile_revisions
       where id=$3 and space_id=$1 and vault_id=$2
       for update
      `,
      [input.spaceId, input.vaultId, input.revisionId],
    );
    const candidate = candidateResult.rows[0];
    if (!candidate) throw new Error("KNOWLEDGE_PROFILE_REVISION_NOT_FOUND");
    if (candidate.profile_hash !== input.expectedProfileHash) {
      throw new Error("CONTEXT_REVISION_CHANGED");
    }

    const dryRunResult = await client.query<{
      id: string;
      candidate_hash: string;
      corpus_revision: string;
      compatibility_class: KnowledgeProfileCompatibility;
      corpus_fingerprint_before: string;
      corpus_fingerprint_after: string;
    }>(
      `
      select id,candidate_hash,corpus_revision,compatibility_class,
             corpus_fingerprint_before,corpus_fingerprint_after
        from schema_dry_runs
       where id=$3 and space_id=$1 and vault_id=$2 and profile_revision_id=$4
       for share
      `,
      [input.spaceId, input.vaultId, input.dryRunId, input.revisionId],
    );
    const dryRun = dryRunResult.rows[0];
    if (!dryRun) throw new Error("KNOWLEDGE_PROFILE_DRY_RUN_REQUIRED");
    if (
      dryRun.candidate_hash !== candidate.profile_hash ||
      dryRun.corpus_revision !== input.expectedCorpusRevision ||
      dryRun.corpus_fingerprint_before !== dryRun.corpus_fingerprint_after ||
      dryRun.corpus_fingerprint_after !== currentFingerprint
    ) {
      throw new Error("CONTEXT_REVISION_CHANGED");
    }

    if (candidate.status === "ACTIVE" && previousRevisionId === candidate.id) {
      if (
        candidate.compatibility_class !== "NON_BREAKING" ||
        dryRun.compatibility_class !== "NON_BREAKING"
      ) {
        throw new Error("ACTIVE_KNOWLEDGE_PROFILE_BINDING_INVALID");
      }
      alreadyActive = true;
      await client.query("commit");
    } else {
      if (
        candidate.status === "REVIEW_REQUIRED" ||
        candidate.compatibility_class !== "NON_BREAKING" ||
        dryRun.compatibility_class !== "NON_BREAKING"
      ) {
        throw new Error("PROFILE_REVIEW_REQUIRED");
      }
      if (candidate.status !== "VALIDATED") {
        throw new Error("KNOWLEDGE_PROFILE_NOT_VALIDATED");
      }

      if (previousRevisionId) {
        if (candidate.supersedes_revision_id !== previousRevisionId) {
          throw new Error("KNOWLEDGE_PROFILE_SUPERSESSION_REQUIRED");
        }
        const previous = await client.query<{ status: string }>(
          `
          select status from knowledge_profile_revisions
           where id=$3 and space_id=$1 and vault_id=$2
           for update
          `,
          [input.spaceId, input.vaultId, previousRevisionId],
        );
        if (previous.rows[0]?.status !== "ACTIVE") {
          throw new Error("ACTIVE_KNOWLEDGE_PROFILE_BINDING_INVALID");
        }
        await client.query(
          `
          update knowledge_profile_revisions
             set status='SUPERSEDED',superseded_at=now(),updated_at=now()
           where id=$3 and space_id=$1 and vault_id=$2 and status='ACTIVE'
          `,
          [input.spaceId, input.vaultId, previousRevisionId],
        );
      } else if (candidate.supersedes_revision_id !== null) {
        throw new Error("KNOWLEDGE_PROFILE_SUPERSESSION_REQUIRED");
      }

      const activated = await client.query(
        `
        update knowledge_profile_revisions
           set status='ACTIVE',activated_at=now(),updated_at=now()
         where id=$3 and space_id=$1 and vault_id=$2 and status='VALIDATED'
         returning id
        `,
        [input.spaceId, input.vaultId, input.revisionId],
      );
      if (!activated.rowCount) {
        throw new Error("KNOWLEDGE_PROFILE_ACTIVATION_CONFLICT");
      }
      await client.query(
        `
        update vaults
           set active_knowledge_profile_revision_id=$3
         where space_id=$1 and id=$2
        `,
        [input.spaceId, input.vaultId, input.revisionId],
      );
      const audit = await client.query(
        `
        insert into audit_events(
          organization_id,space_id,actor_id,action,resource_type,resource_id,
          metadata,trace_id,vault_id
        )
        select s.organization_id,s.id,$3,'schema.profile_activate',
               'knowledge_profile_revision',$4,$5::jsonb,$6,$2
          from spaces s where s.id=$1
        returning id
        `,
        [
          input.spaceId,
          input.vaultId,
          input.actorId,
          input.revisionId,
          JSON.stringify({
            vaultId: input.vaultId,
            profileRevisionId: input.revisionId,
            previousRevisionId,
            profileHash: candidate.profile_hash,
            corpusRevision: input.expectedCorpusRevision,
            dryRunId: input.dryRunId,
          }),
          input.traceId,
        ],
      );
      if (!audit.rowCount) throw new Error("AUDIT_ORGANIZATION_UNRESOLVED");
      await client.query("commit");
    }
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
  if (!revision || revision.status !== "ACTIVE") {
    throw new Error("ACTIVE_KNOWLEDGE_PROFILE_BINDING_INVALID");
  }
  return {
    revision,
    previousRevisionId,
    corpusRevision: input.expectedCorpusRevision,
    dryRunId: input.dryRunId,
    alreadyActive,
  };
}

/**
 * Roll back only to the exact immediate predecessor of the currently active
 * profile. The historical revision is immutable; a fresh dry-run proves that
 * the reverse transition is still NON_BREAKING for the current corpus before
 * the binding is changed. Ordinary activation remains forward-only.
 */
export async function rollbackKnowledgeProfile(
  db: Postgres,
  input: RollbackKnowledgeProfileInput,
): Promise<RolledBackKnowledgeProfile> {
  const client = await db.pool.connect();
  let rolledBackFromRevisionId: string | null = null;
  let alreadyActive = false;
  try {
    await client.query("begin isolation level serializable");
    const vaultResult = await client.query<{
      active_revision_id: string | null;
      corpus_revision: string;
    }>(
      `
      select v.active_knowledge_profile_revision_id active_revision_id,
             coalesce(r.corpus_revision,v.current_revision,'unknown') corpus_revision
        from vaults v
        left join vault_index_revisions r
          on r.space_id=v.space_id and r.vault_id=v.id
       where v.space_id=$1 and v.id=$2
       for update of v
      `,
      [input.spaceId, input.vaultId],
    );
    const vault = vaultResult.rows[0];
    if (!vault) throw new Error("VAULT_NOT_FOUND_OR_SCOPE_MISMATCH");
    if (vault.corpus_revision !== input.expectedCorpusRevision) {
      throw new Error("CONTEXT_REVISION_CHANGED");
    }

    const targetResult = await client.query<{
      id: string;
      profile_hash: string;
      status: KnowledgeProfileRevisionStatus;
    }>(
      `
      select id,profile_hash,status
        from knowledge_profile_revisions
       where id=$3 and space_id=$1 and vault_id=$2
       for update
      `,
      [input.spaceId, input.vaultId, input.targetRevisionId],
    );
    const target = targetResult.rows[0];
    if (!target) throw new Error("KNOWLEDGE_PROFILE_REVISION_NOT_FOUND");
    if (target.profile_hash !== input.expectedProfileHash) {
      throw new Error("CONTEXT_REVISION_CHANGED");
    }

    if (vault.active_revision_id === target.id && target.status === "ACTIVE") {
      alreadyActive = true;
      await client.query("commit");
    } else {
      if (vault.active_revision_id !== input.expectedActiveRevisionId) {
        throw new Error("CONTEXT_REVISION_CHANGED");
      }
      if (target.status !== "SUPERSEDED") {
        throw new Error("KNOWLEDGE_PROFILE_ROLLBACK_TARGET_INVALID");
      }
      rolledBackFromRevisionId = vault.active_revision_id;
      if (!rolledBackFromRevisionId) {
        throw new Error("ACTIVE_KNOWLEDGE_PROFILE_BINDING_INVALID");
      }

      const activeResult = await client.query<{
        id: string;
        status: KnowledgeProfileRevisionStatus;
        supersedes_revision_id: string | null;
      }>(
        `
        select id,status,supersedes_revision_id
          from knowledge_profile_revisions
         where id=$3 and space_id=$1 and vault_id=$2
         for update
        `,
        [input.spaceId, input.vaultId, rolledBackFromRevisionId],
      );
      const active = activeResult.rows[0];
      if (!active || active.status !== "ACTIVE") {
        throw new Error("ACTIVE_KNOWLEDGE_PROFILE_BINDING_INVALID");
      }
      if (active.supersedes_revision_id !== target.id) {
        throw new Error("KNOWLEDGE_PROFILE_ROLLBACK_TARGET_NOT_PREDECESSOR");
      }

      const fingerprintResult = await client.query<{ fingerprint: string }>(
        `
        select encode(digest(coalesce(string_agg(
          id::text||':'||coalesce(content_hash,'')||':'||current_revision,
          '|' order by id
        ),''),'sha256'),'hex') fingerprint
          from knowledge_documents where space_id=$1 and vault_id=$2
        `,
        [input.spaceId, input.vaultId],
      );
      const currentFingerprint = String(
        fingerprintResult.rows[0]?.fingerprint ?? "",
      );

      const dryRunResult = await client.query<{
        candidate_hash: string;
        corpus_revision: string;
        compatibility_class: KnowledgeProfileCompatibility;
        corpus_fingerprint_before: string;
        corpus_fingerprint_after: string;
        current_profile_revision_id: string | null;
      }>(
        `
        select candidate_hash,corpus_revision,compatibility_class,
               corpus_fingerprint_before,corpus_fingerprint_after,
               report->'currentProfile'->>'revisionId' current_profile_revision_id
          from schema_dry_runs
         where id=$3 and space_id=$1 and vault_id=$2 and profile_revision_id=$4
         for share
        `,
        [input.spaceId, input.vaultId, input.dryRunId, target.id],
      );
      const dryRun = dryRunResult.rows[0];
      if (!dryRun) throw new Error("KNOWLEDGE_PROFILE_DRY_RUN_REQUIRED");
      if (
        dryRun.candidate_hash !== target.profile_hash ||
        dryRun.corpus_revision !== input.expectedCorpusRevision ||
        dryRun.corpus_fingerprint_before !== dryRun.corpus_fingerprint_after ||
        dryRun.corpus_fingerprint_after !== currentFingerprint ||
        dryRun.current_profile_revision_id !== rolledBackFromRevisionId
      ) {
        throw new Error("CONTEXT_REVISION_CHANGED");
      }
      if (dryRun.compatibility_class !== "NON_BREAKING") {
        throw new Error("PROFILE_ROLLBACK_REVIEW_REQUIRED");
      }

      const superseded = await client.query(
        `
        update knowledge_profile_revisions
           set status='SUPERSEDED',superseded_at=now(),updated_at=now()
         where id=$3 and space_id=$1 and vault_id=$2 and status='ACTIVE'
         returning id
        `,
        [input.spaceId, input.vaultId, rolledBackFromRevisionId],
      );
      if (!superseded.rowCount) {
        throw new Error("KNOWLEDGE_PROFILE_ROLLBACK_CONFLICT");
      }
      const restored = await client.query(
        `
        update knowledge_profile_revisions
           set status='ACTIVE',activated_at=coalesce(activated_at,now()),
               superseded_at=null,updated_at=now()
         where id=$3 and space_id=$1 and vault_id=$2 and status='SUPERSEDED'
         returning id
        `,
        [input.spaceId, input.vaultId, target.id],
      );
      if (!restored.rowCount) {
        throw new Error("KNOWLEDGE_PROFILE_ROLLBACK_CONFLICT");
      }
      await client.query(
        `
        update vaults
           set active_knowledge_profile_revision_id=$3
         where space_id=$1 and id=$2
        `,
        [input.spaceId, input.vaultId, target.id],
      );
      const audit = await client.query(
        `
        insert into audit_events(
          organization_id,space_id,actor_id,action,resource_type,resource_id,
          metadata,trace_id,vault_id
        )
        select s.organization_id,s.id,$3,'schema.profile_rollback',
               'knowledge_profile_revision',$4,$5::jsonb,$6,$2
          from spaces s where s.id=$1
        returning id
        `,
        [
          input.spaceId,
          input.vaultId,
          input.actorId,
          target.id,
          JSON.stringify({
            vaultId: input.vaultId,
            targetRevisionId: target.id,
            rolledBackFromRevisionId,
            profileHash: target.profile_hash,
            corpusRevision: input.expectedCorpusRevision,
            dryRunId: input.dryRunId,
          }),
          input.traceId,
        ],
      );
      if (!audit.rowCount) throw new Error("AUDIT_ORGANIZATION_UNRESOLVED");
      await client.query("commit");
    }
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
    input.targetRevisionId,
  );
  if (!revision || revision.status !== "ACTIVE") {
    throw new Error("ACTIVE_KNOWLEDGE_PROFILE_BINDING_INVALID");
  }
  return {
    revision,
    rolledBackFromRevisionId,
    corpusRevision: input.expectedCorpusRevision,
    dryRunId: input.dryRunId,
    alreadyActive,
  };
}
