import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  DEFAULT_KNOWLEDGE_PROFILE_V1,
  KnowledgeProfileV1,
  canonicalKnowledgeProfileJson,
} from "@akp/contracts/knowledge-profile";
import {
  classifyKnowledgeProfileCompatibility,
  type KnowledgeProfileCompatibilityIssue,
  type KnowledgeProfileCorpusUsage,
} from "@akp/contracts/knowledge-profile-compatibility";
import {
  createKnowledgeProfileDraft,
  recordKnowledgeProfileDryRun,
  resolveAuthorizedVaultScope,
  resolveKnowledgeProfileBinding,
  type Postgres,
} from "@akp/postgres";
import {
  actorOf,
  audit,
  hasUnrestrictedPathAccess,
  requirePermission,
} from "../auth.js";

interface CorpusDocument extends Record<string, unknown> {
  id: string;
  external_id: string | null;
  path: string;
  type: string;
  lifecycle: string;
  frontmatter: Record<string, unknown>;
  current_revision: string;
}

interface RelationUsageRow {
  relation_type: string;
  relation_count: string | number;
}

interface EffectiveKnowledgeProfile {
  source: "DURABLE_REVISION" | "V03_DEFAULT";
  revisionId: string | null;
  profileHash: string;
  profile: KnowledgeProfileV1;
  legacySchemaProfile: Record<string, unknown>;
}

function normalized(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values
        .map(String)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function canonicalProfile(profile: unknown): {
  parsed: KnowledgeProfileV1;
  canonical: string;
  hash: string;
} {
  const parsed = KnowledgeProfileV1.parse(profile);
  const canonical = canonicalKnowledgeProfileJson(parsed);
  return {
    parsed,
    canonical,
    hash: createHash("sha256").update(canonical).digest("hex"),
  };
}

async function resolveEffectiveKnowledgeProfile(
  db: Postgres,
  spaceId: string,
  vaultId: string,
): Promise<EffectiveKnowledgeProfile> {
  const binding = await resolveKnowledgeProfileBinding(db, spaceId, vaultId);
  if (binding.revision) {
    return {
      source: "DURABLE_REVISION",
      revisionId: binding.revision.id,
      profileHash: binding.revision.profileHash,
      profile: KnowledgeProfileV1.parse(binding.revision.profile),
      legacySchemaProfile: binding.legacySchemaProfile,
    };
  }

  const fallback = canonicalProfile(DEFAULT_KNOWLEDGE_PROFILE_V1);
  return {
    source: "V03_DEFAULT",
    revisionId: null,
    profileHash: fallback.hash,
    profile: fallback.parsed,
    legacySchemaProfile: binding.legacySchemaProfile,
  };
}

async function corpusFingerprint(
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>,
  spaceId: string,
  vaultId: string,
): Promise<string> {
  const result = await query(
    `
    select encode(digest(coalesce(string_agg(
      id::text||':'||coalesce(content_hash,'')||':'||current_revision,
      '|' order by id
    ),''),'sha256'),'hex') fingerprint
      from knowledge_documents where space_id=$1 and vault_id=$2
    `,
    [spaceId, vaultId],
  );
  return String(result.rows[0]?.fingerprint ?? "");
}

function buildProfileCorpusUsage(
  documents: CorpusDocument[],
  relationRows: RelationUsageRow[],
  currentProfile: KnowledgeProfileV1,
): KnowledgeProfileCorpusUsage {
  const kindCounts: Record<string, number> = {};
  const lifecycleStateCounts: Record<string, Record<string, number>> = {};
  for (const document of documents) {
    kindCounts[document.type] = (kindCounts[document.type] ?? 0) + 1;
    const lifecycleName =
      currentProfile.knowledgeKinds[document.type]?.lifecycle;
    if (!lifecycleName) continue;
    const states = (lifecycleStateCounts[lifecycleName] ??= {});
    states[document.lifecycle] = (states[document.lifecycle] ?? 0) + 1;
  }
  const relationCounts = Object.fromEntries(
    relationRows.map((row) => [row.relation_type, Number(row.relation_count)]),
  );
  return { kindCounts, relationCounts, lifecycleStateCounts };
}

function profileAffectedDocumentCount(
  documents: CorpusDocument[],
  currentProfile: KnowledgeProfileV1,
  issues: KnowledgeProfileCompatibilityIssue[],
): number {
  const kinds = new Set<string>();
  const addKindsUsing = (
    field: "lifecycle" | "evidencePolicy" | "reviewPolicy" | "artifactContract",
    value: string,
  ) => {
    for (const [kind, definition] of Object.entries(
      currentProfile.knowledgeKinds,
    )) {
      if (definition[field] === value) kinds.add(kind);
    }
  };

  for (const issue of issues) {
    const [root, name] = issue.path.split(".");
    if (issue.code === "PROFILE_ID_CHANGED") {
      for (const kind of Object.keys(currentProfile.knowledgeKinds)) {
        kinds.add(kind);
      }
      continue;
    }
    if (!name) continue;
    if (root === "knowledgeKinds") kinds.add(name);
    if (root === "lifecycles") addKindsUsing("lifecycle", name);
    if (root === "evidencePolicies") addKindsUsing("evidencePolicy", name);
    if (root === "reviewPolicies") addKindsUsing("reviewPolicy", name);
    if (root === "artifactContracts") addKindsUsing("artifactContract", name);
  }

  return documents.filter((document) => kinds.has(document.type)).length;
}

function legacyCompatibilityStatus(
  compatibilityClass: string,
): "COMPATIBLE" | "MIGRATION_REQUIRED" {
  return compatibilityClass === "MIGRATION_REQUIRED" ||
    compatibilityClass === "UNSAFE"
    ? "MIGRATION_REQUIRED"
    : "COMPATIBLE";
}

export function registerSchemaGovernanceRoutes(
  app: FastifyInstance,
  db: Postgres,
): void {
  app.post<{
    Body: {
      spaceId: string;
      vaultId: string;
      candidateVersion?: string;
      requiredFrontmatterFields?: string[];
      allowedTypes?: string[];
      profile?: unknown;
      supersedesRevisionId?: string;
    };
  }>(
    "/v1/schema/dry-run",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      const actor = actorOf(request);
      const spaceId = request.body?.spaceId;
      const vaultId = request.body?.vaultId;
      if (!spaceId || !vaultId) {
        return reply.code(400).send({ code: "VAULT_SCOPE_REQUIRED" });
      }
      if (!hasUnrestrictedPathAccess(actor, spaceId, "admin")) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      let vaultAccess:
        { pathPrefix: string | null; permissions: string[] } | undefined;
      try {
        const scope = await resolveAuthorizedVaultScope(db, {
          userId: actor.id,
          spaceId,
          vaultId,
          vaultIds: [vaultId],
          permission: "admin",
          federated: false,
        });
        vaultAccess = scope.accessByVault[vaultId];
      } catch (error) {
        return reply.code(403).send({
          code: error instanceof Error ? error.message : "VAULT_ACCESS_DENIED",
        });
      }
      if (!vaultAccess || vaultAccess.pathPrefix !== null) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }

      const fullProfileRequested = request.body?.profile !== undefined;
      const candidateVersion = request.body?.candidateVersion?.trim();
      if (!fullProfileRequested && !candidateVersion) {
        return reply
          .code(400)
          .send({ code: "CANDIDATE_SCHEMA_VERSION_REQUIRED" });
      }

      let currentProfileBefore:
        | Awaited<ReturnType<typeof resolveEffectiveKnowledgeProfile>>
        | undefined;
      let profileDraft:
        Awaited<ReturnType<typeof createKnowledgeProfileDraft>> | undefined;
      let profileCandidate: KnowledgeProfileV1 | undefined;
      if (fullProfileRequested) {
        try {
          currentProfileBefore = await resolveEffectiveKnowledgeProfile(
            db,
            spaceId,
            vaultId,
          );
          const candidate = canonicalProfile(request.body.profile);
          profileCandidate = candidate.parsed;
          profileDraft = await createKnowledgeProfileDraft(db, {
            spaceId,
            vaultId,
            profileId: candidate.parsed.profileId,
            version: candidate.parsed.version,
            canonicalProfile: candidate.canonical,
            profileHash: candidate.hash,
            supersedesRevisionId:
              request.body.supersedesRevisionId?.trim() || null,
            createdBy: actor.id,
          });
        } catch (error) {
          return reply.code(400).send({
            code: "INVALID_KNOWLEDGE_PROFILE",
            detail: error instanceof Error ? error.message : "invalid profile",
          });
        }
      }

      const requiredFields = normalized(request.body.requiredFrontmatterFields);
      const allowedTypes = normalized(request.body.allowedTypes);
      const legacyCandidate = candidateVersion
        ? {
            candidateVersion,
            requiredFrontmatterFields: requiredFields,
            allowedTypes,
          }
        : null;
      const legacyCandidateHash = legacyCandidate
        ? createHash("sha256")
            .update(JSON.stringify(legacyCandidate))
            .digest("hex")
        : null;

      const client = await db.pool.connect();
      let before = "";
      let documents: CorpusDocument[] = [];
      let relationRows: RelationUsageRow[] = [];
      let corpusRevision = "unknown";
      try {
        await client.query("begin isolation level repeatable read read only");
        before = await corpusFingerprint(
          client.query.bind(client),
          spaceId,
          vaultId,
        );
        const result = await client.query<CorpusDocument>(
          `
          select id,external_id,path,type,lifecycle,frontmatter,current_revision
            from knowledge_documents where space_id=$1 and vault_id=$2 order by path
          `,
          [spaceId, vaultId],
        );
        documents = result.rows;
        if (fullProfileRequested) {
          const relations = await client.query<RelationUsageRow>(
            `
            select r.relation_type,count(*) relation_count
              from knowledge_relations r
              join knowledge_documents source on source.id=r.from_document_id
              join knowledge_documents target on target.id=r.to_document_id
             where r.space_id=$1
               and source.space_id=$1 and source.vault_id=$2
               and target.space_id=$1 and target.vault_id=$2
             group by r.relation_type
             order by r.relation_type
            `,
            [spaceId, vaultId],
          );
          relationRows = relations.rows;
        }
        const revision = await client.query<{ revision: string }>(
          `
          select coalesce(
            (select corpus_revision from vault_index_revisions where space_id=$1 and vault_id=$2),
            (select current_revision from vaults where space_id=$1 and id=$2),
            'unknown'
          ) revision
          `,
          [spaceId, vaultId],
        );
        corpusRevision = String(revision.rows[0]?.revision ?? "unknown");
        await client.query("rollback");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      const after = await corpusFingerprint(
        async (text, values) => {
          const result = await db.pool.query(text, values);
          return { rows: result.rows as Array<Record<string, unknown>> };
        },
        spaceId,
        vaultId,
      );

      if (
        fullProfileRequested &&
        currentProfileBefore &&
        profileDraft &&
        profileCandidate
      ) {
        const currentProfileAfter = await resolveEffectiveKnowledgeProfile(
          db,
          spaceId,
          vaultId,
        );
        if (
          before !== after ||
          currentProfileBefore.revisionId !== currentProfileAfter.revisionId ||
          currentProfileBefore.profileHash !== currentProfileAfter.profileHash
        ) {
          return reply.code(409).send({ code: "CONTEXT_REVISION_CHANGED" });
        }

        const corpusUsage = buildProfileCorpusUsage(
          documents,
          relationRows,
          currentProfileBefore.profile,
        );
        const compatibility = classifyKnowledgeProfileCompatibility(
          currentProfileBefore.profile,
          profileCandidate,
          corpusUsage,
        );
        const affectedDocumentCount = profileAffectedDocumentCount(
          documents,
          currentProfileBefore.profile,
          compatibility.issues,
        );
        const report = {
          mode: "KNOWLEDGE_PROFILE",
          currentProfile: {
            source: currentProfileBefore.source,
            revisionId: currentProfileBefore.revisionId,
            profileId: currentProfileBefore.profile.profileId,
            version: currentProfileBefore.profile.version,
            profileHash: currentProfileBefore.profileHash,
          },
          candidateProfile: {
            revisionId: profileDraft.id,
            profileId: profileDraft.profileId,
            version: profileDraft.version,
            profileHash: profileDraft.profileHash,
            supersedesRevisionId: profileDraft.supersedesRevisionId,
          },
          compatibilityStatus: legacyCompatibilityStatus(
            compatibility.compatibilityClass,
          ),
          compatibilityClass: compatibility.compatibilityClass,
          requiresArchitectureOrCuratorApproval: compatibility.requiresReview,
          requiredFollowUp: compatibility.requiredActions,
          issues: compatibility.issues,
          corpusUsage,
          affectedDocumentCount,
          affectedDocumentCountScope: "DOCUMENT_KIND_AND_POLICY_IMPACT",
          corpusRevision,
          corpusUnchanged: before === after,
          rollbackPlan:
            "Keep the prior active profile binding and activate a reviewed successor only after required migration/reindex/recompile work succeeds.",
        };

        let recorded: Awaited<ReturnType<typeof recordKnowledgeProfileDryRun>>;
        try {
          recorded = await recordKnowledgeProfileDryRun(db, {
            spaceId,
            vaultId,
            revisionId: profileDraft.id,
            actorId: actor.id,
            expectedCorpusRevision: corpusRevision,
            compatibilityClass: compatibility.compatibilityClass,
            affectedDocumentCount,
            report,
            corpusFingerprintBefore: before,
            corpusFingerprintAfter: after,
          });
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === "CONTEXT_REVISION_CHANGED"
          ) {
            return reply.code(409).send({ code: "CONTEXT_REVISION_CHANGED" });
          }
          throw error;
        }

        await audit(
          db,
          request,
          "schema.profile_dry_run",
          "knowledge_profile_revision",
          profileDraft.id,
          {
            vaultId,
            dryRunId: recorded.id,
            candidateHash: profileDraft.profileHash,
            compatibilityClass: compatibility.compatibilityClass,
            affectedDocumentCount,
            corpusRevision,
          },
          spaceId,
        );
        return {
          id: recorded.id,
          createdAt: recorded.createdAt,
          profileRevisionId: recorded.revision.id,
          profileRevisionStatus: recorded.revision.status,
          candidateHash: profileDraft.profileHash,
          corpusFingerprintBefore: before,
          corpusFingerprintAfter: after,
          ...report,
        };
      }

      const affected = documents.flatMap((document) => {
        const frontmatter = document.frontmatter ?? {};
        const missingFields = requiredFields.filter(
          (field) => !(field in frontmatter) || frontmatter[field] === null,
        );
        const unsupportedType =
          allowedTypes.length > 0 && !allowedTypes.includes(document.type);
        return missingFields.length || unsupportedType
          ? [
              {
                id: document.id,
                externalId: document.external_id,
                path: document.path,
                type: document.type,
                missingFields,
                unsupportedType,
              },
            ]
          : [];
      });
      const compatibilityStatus = affected.length
        ? "MIGRATION_REQUIRED"
        : "COMPATIBLE";
      const compatibilityClass = affected.length
        ? "MIGRATION_REQUIRED"
        : "NON_BREAKING";
      const report = {
        candidate: legacyCandidate,
        compatibilityStatus,
        compatibilityClass,
        affectedDocumentCount: affected.length,
        affectedSample: affected.slice(0, 100),
        sampleTruncated: affected.length > 100,
        corpusRevision,
        corpusUnchanged: before === after,
        requiresArchitectureOrCuratorApproval: true,
        requiredFollowUp: affected.length
          ? [
              "APPROVE_MIGRATION",
              "MIGRATE_AFFECTED_DOCUMENTS",
              "REINDEX",
              "RUN_REGRESSION_EVALS",
            ]
          : ["APPROVE_SCHEMA", "REINDEX", "RUN_REGRESSION_EVALS"],
        rollbackPlan:
          "Retain the prior schema version and reverse the reviewed migration commit.",
      };
      const inserted = await db.pool.query(
        `
        insert into schema_dry_runs(
          space_id,vault_id,actor_id,candidate_version,candidate_hash,corpus_revision,
          affected_document_count,compatibility_status,compatibility_class,report,
          corpus_fingerprint_before,corpus_fingerprint_after
        ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
        returning id,created_at
        `,
        [
          spaceId,
          vaultId,
          actor.id,
          candidateVersion,
          legacyCandidateHash,
          corpusRevision,
          affected.length,
          compatibilityStatus,
          compatibilityClass,
          JSON.stringify(report),
          before,
          after,
        ],
      );
      await audit(
        db,
        request,
        "schema.dry_run",
        "schema_dry_run",
        String(inserted.rows[0]?.id),
        {
          vaultId,
          candidateHash: legacyCandidateHash,
          affectedDocumentCount: affected.length,
        },
        spaceId,
      );
      return {
        id: inserted.rows[0]?.id,
        createdAt: inserted.rows[0]?.created_at,
        candidateHash: legacyCandidateHash,
        corpusFingerprintBefore: before,
        corpusFingerprintAfter: after,
        ...report,
      };
    },
  );
}
