import { createHash } from "node:crypto";
import type { ObjectStore } from "@akp/object-store";
import {
  resolveAuthorizedVaultScope,
  pathMatchesVaultPrefix,
  type Postgres,
} from "@akp/postgres";
import {
  retrievalAnswerabilityCandidateKey,
  bindGovernedLayeredPropositionInput,
  type GovernedLayeredPropositionPort,
  type GovernedLayeredPropositionProof,
  type StructuredProposition,
  type StructuredPropositionQuery,
} from "@akp/retrieval";
import { z } from "zod";
import { readAndVerifyRawEvidence } from "./routes/audit-export.js";

const MAX_SOURCE_BYTES = 2_000_000;
const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
function sourceSpanUsesCodePointBoundaries(
  text: string,
  start: number,
  end: number,
): boolean {
  const boundary = (at: number) =>
    at >= 0 &&
    at <= text.length &&
    !(
      at > 0 &&
      at < text.length &&
      text.charCodeAt(at - 1) >= 0xd800 &&
      text.charCodeAt(at - 1) <= 0xdbff &&
      text.charCodeAt(at) >= 0xdc00 &&
      text.charCodeAt(at) <= 0xdfff
    );
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    end > start &&
    boundary(start) &&
    boundary(end)
  );
}
const hex = z.string().regex(/^[a-f0-9]{64}$/u);
const optionalQualifiers = {
  temporalScope: z.string().trim().min(1).max(512).optional(),
  conditions: z.array(z.string().trim().min(1).max(512)).max(12).optional(),
  modality: z
    .enum(["REQUIRED", "PERMITTED", "PROHIBITED", "OPTIONAL"])
    .optional(),
  quantityUnit: z.string().trim().min(1).max(80).optional(),
};
export const reviewedS2QueryProposition = z
  .object({
    subject: z.string().max(512),
    predicate: z.string().trim().min(1).max(512),
    object: z.string().trim().min(1).max(512).optional(),
    polarity: z.enum(["POSITIVE", "NEGATIVE"]).optional(),
    requestedAnswerRole: z.enum(["SUBJECT", "OBJECT"]).optional(),
    ...optionalQualifiers,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.requestedAnswerRole === "SUBJECT" &&
        (value.subject.trim() || !value.object)) ||
      (value.requestedAnswerRole === "OBJECT" &&
        (!value.subject.trim() || value.object !== undefined)) ||
      (!value.requestedAnswerRole && !value.subject.trim())
    )
      context.addIssue({ code: "custom", message: "S2_QUESTION_SLOT_INVALID" });
  });
export const reviewedS2SourceProposition = z
  .object({
    subject: z.string().trim().min(1).max(512),
    predicate: z.string().trim().min(1).max(512),
    object: z.string().trim().min(1).max(512).optional(),
    polarity: z.enum(["POSITIVE", "NEGATIVE"]).optional(),
    quote: z
      .object({
        startOffset: z.number().int().nonnegative(),
        endOffset: z.number().int().positive(),
      })
      .strict(),
    ...optionalQualifiers,
  })
  .strict();

interface ReviewedRow {
  id: string;
  question_text: string;
  question_sha256: string;
  source_sha256: string;
  source_object_key: string;
  source_byte_size: string;
  source_media_type: string | null;
  excerpt: string;
  excerpt_sha256: string;
  query_proposition: unknown;
  source_proposition: unknown;
}
const eligibleMedia = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
]);

/**
 * Authenticated, read-only resolver of two-human-approved relation projections.
 * The database is a REVIEW REGISTER, never a model-generated proof of truth.
 * Every lookup rechecks CURRENT vault, document, evidence/source provenance,
 * caller membership and exact revision, then rereads immutable object bytes.
 *
 * No public payload, title, temporal-fact timestamp or Reader output can
 * fabricate an approved projection. Missing/ambiguous/stale data abstains.
 */
export function createS2ReviewedSourcePropositionPort(
  db: Postgres,
  objectStore: ObjectStore,
): GovernedLayeredPropositionPort {
  return {
    async resolve({ originalQuestion, hit, principalId, spaceId }) {
      if (
        !principalId ||
        !spaceId ||
        !originalQuestion?.trim() ||
        originalQuestion.length > 4096 ||
        !hit.documentId ||
        !hit.vaultId ||
        !hit.revision ||
        !hit.document?.path ||
        !hit.excerpt ||
        hit.excerpt.length > 8192
      )
        return null;
      try {
        // Source reads need a real vault grant, not merely a space membership.
        const scope = await resolveAuthorizedVaultScope(db, {
          userId: principalId,
          spaceId,
          permission: "source:read",
          vaultId: hit.vaultId,
          vaultIds: [hit.vaultId],
          federated: false,
        });
        const pathPrefix = scope.accessByVault[hit.vaultId]?.pathPrefix;
        if (
          pathPrefix === undefined ||
          !pathMatchesVaultPrefix(hit.document.path, pathPrefix)
        )
          return null;
        const matches = await db.pool.query<ReviewedRow>(
          `select r.id,r.question_text,r.question_sha256,r.source_sha256,
                  r.excerpt,r.excerpt_sha256,r.query_proposition,r.source_proposition,
                  s.object_key source_object_key,s.byte_size::text source_byte_size,
                  s.media_type source_media_type
             from s2_reviewed_source_propositions r
             join knowledge_documents d on d.id=r.document_id
              and d.space_id=r.space_id and d.vault_id=r.vault_id
              and d.path=r.document_path and d.current_revision=r.document_revision
              and d.lifecycle='ACTIVE'
             join vaults v on v.id=r.vault_id and v.space_id=r.space_id
              and v.enabled=true
             join sources s on s.id=r.source_id and s.space_id=r.space_id
              and s.vault_id=r.vault_id and s.sha256=r.source_sha256
              and s.status='ACTIVE'
            where r.space_id=$1 and r.vault_id=$2 and r.document_id=$3
              and r.unit_id is not distinct from $4::uuid
              and r.document_revision=$5 and r.document_path=$6
              and r.question_sha256=$7 and r.excerpt_sha256=$8
              and r.status='APPROVED' and r.approved_by<>r.proposed_by
              and (r.unit_id is null or exists (
                 select 1 from knowledge_units u where u.id=r.unit_id
                   and u.document_id=d.id and u.space_id=r.space_id
                   and u.vault_id=r.vault_id
                   and u.document_revision=d.current_revision
              ))
              and exists (
                select 1 from memberships m where m.user_id=$9
                  and m.space_id=r.space_id and m.role in
                    ('VIEWER','CONTRIBUTOR','CURATOR','REVIEWER','ARCHITECT','ADMIN','SERVICE_ACCOUNT')
                  and (m.path_prefix is null or d.path=m.path_prefix
                    or left(d.path,length(m.path_prefix)+1)=m.path_prefix||'/')
              )
              and exists (
                select 1 from document_evidence de join evidence e
                  on e.id=de.evidence_id and e.source_id=s.id
                  and e.space_id=r.space_id and e.vault_id=r.vault_id
                 where de.document_id=d.id and de.relation_type='supported_by'
                   and e.locator->>'source_hash'=s.sha256
              )
            limit 2`,
          [
            spaceId,
            hit.vaultId,
            hit.documentId,
            hit.unitId ?? null,
            hit.revision,
            hit.document.path,
            sha256(originalQuestion),
            sha256(hit.excerpt),
            principalId,
          ],
        );
        // Two competing approvals are ambiguous. Never select by timestamp.
        if (matches.rows.length !== 1) return null;
        const row = matches.rows[0]!;
        const query = reviewedS2QueryProposition.safeParse(
          row.query_proposition,
        );
        const proposition = reviewedS2SourceProposition.safeParse(
          row.source_proposition,
        );
        const bytes = Number(row.source_byte_size);
        if (
          !query.success ||
          !proposition.success ||
          row.question_text !== originalQuestion ||
          row.question_sha256 !== sha256(originalQuestion) ||
          row.excerpt !== hit.excerpt ||
          row.excerpt_sha256 !== sha256(hit.excerpt) ||
          !hex.safeParse(row.source_sha256).success ||
          !Number.isSafeInteger(bytes) ||
          bytes < 1 ||
          bytes > MAX_SOURCE_BYTES ||
          !eligibleMedia.has(
            (row.source_media_type ?? "").split(";")[0]!.trim().toLowerCase(),
          )
        )
          return null;
        const ref = await objectStore.exists(row.source_sha256);
        if (!ref) return null;
        const verified = await readAndVerifyRawEvidence(
          objectStore,
          ref,
          {
            sha256: row.source_sha256,
            byteSize: bytes,
            objectKey: row.source_object_key,
          },
          MAX_SOURCE_BYTES,
        );
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          verified.bytes,
        );
        const start = text.indexOf(hit.excerpt);
        if (
          start < 0 ||
          text.indexOf(hit.excerpt, start + 1) !== -1 ||
          !sourceSpanUsesCodePointBoundaries(
            text,
            start,
            start + hit.excerpt.length,
          )
        )
          return null;
        const quote = proposition.data.quote;
        if (
          quote.endOffset <= quote.startOffset ||
          quote.endOffset > hit.excerpt.length ||
          !sourceSpanUsesCodePointBoundaries(
            hit.excerpt,
            quote.startOffset,
            quote.endOffset,
          )
        )
          return null;
        return {
          originalQuestion,
          originalQuestionSha256: sha256(originalQuestion),
          candidateKey: retrievalAnswerabilityCandidateKey(hit),
          documentId: hit.documentId,
          unitId: hit.unitId ?? null,
          vaultId: hit.vaultId,
          revision: hit.revision,
          path: hit.document.path,
          originalSourceBytes: verified.bytes,
          originalSourceText: text,
          originalSourceSha256: row.source_sha256,
          excerptStartUtf16: start,
          excerptEndUtf16: start + hit.excerpt.length,
          queryProposition: query.data as StructuredPropositionQuery,
          candidateProposition: proposition.data as StructuredProposition,
        } satisfies GovernedLayeredPropositionProof;
      } catch {
        // An unreachable store, schema not migrated, revoked source or failing
        // DB authorization never downgrades to lexical/model authority.
        return null;
      }
    },
  };
}

/**
 * Evaluate previously unknown questions against SOURCE that is ALREADY
 * independently reviewed for a different statement. This proves only that
 * the original bytes/ACL/revision remain current; the anchor's question
 * proposition must NEVER be relabeled as approval for an unseen question.
 *
 * The same canonical reviewed port rechecks evidence, path, vault, revision
 * and raw bytes. No second SOURCE reader or authorizer is introduced.
 */
export async function findS2ReviewedSourceAnchor(input: {
  db: Postgres;
  port: GovernedLayeredPropositionPort;
  principalId: string;
  spaceId: string;
  hit: import("@akp/contracts").SearchHit;
  excludedQuestion: string;
}): Promise<{
  anchorQuestionSha256: string;
  proof: GovernedLayeredPropositionProof;
} | null> {
  const { db, port, principalId, spaceId, hit, excludedQuestion } = input;
  if (
    !principalId ||
    !spaceId ||
    !hit.documentId ||
    !hit.vaultId ||
    !hit.revision ||
    !hit.document?.path ||
    !hit.excerpt ||
    hit.excerpt.length > 8192 ||
    excludedQuestion.length > 4096
  )
    return null;
  try {
    // This is a bounded locator for an already reviewed SOURCE anchor; it is
    // NOT a means of accepting or synthesizing natural-language propositions.
    const matches = await db.pool.query<{
      question_text: string;
      question_sha256: string;
    }>(
      `select question_text,question_sha256
         from s2_reviewed_source_propositions
        where space_id=$1 and vault_id=$2 and document_id=$3
          and unit_id is not distinct from $4::uuid
          and document_revision=$5 and document_path=$6
          and excerpt_sha256=$7
          and status='APPROVED' and approved_by<>proposed_by
          and question_sha256<>$8
        order by question_sha256,id
        limit 8`,
      [
        spaceId,
        hit.vaultId,
        hit.documentId,
        hit.unitId ?? null,
        hit.revision,
        hit.document.path,
        sha256(hit.excerpt),
        sha256(excludedQuestion),
      ],
    );
    for (const row of matches.rows) {
      if (
        !row.question_text?.trim() ||
        row.question_text.length > 4096 ||
        row.question_text === excludedQuestion ||
        row.question_sha256 !== sha256(row.question_text)
      )
        continue;
      let proof: GovernedLayeredPropositionProof | null = null;
      try {
        proof = await port.resolve({
          originalQuestion: row.question_text,
          hit,
          principalId,
          spaceId,
        });
      } catch {
        proof = null;
      }
      // Reuse the established guarded SOURCE/structured-proposition binder.
      // This relation is about the anchor question, NEVER excludedQuestion.
      if (bindGovernedLayeredPropositionInput(row.question_text, hit, proof))
        return { anchorQuestionSha256: row.question_sha256, proof: proof! };
    }
  } catch {
    // No new-question fallback from unavailable/stale review rows or source.
  }
  return null;
}
