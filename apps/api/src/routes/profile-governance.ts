import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  DEFAULT_KNOWLEDGE_PROFILE_V1,
  KnowledgeProfileV1,
  canonicalKnowledgeProfileJson,
  type KnowledgeProfileV1 as KnowledgeProfile,
} from "@akp/contracts/knowledge-profile";
import { classifyKnowledgeProfileCompatibility } from "@akp/contracts/knowledge-profile-compatibility";
import {
  getKnowledgeProfileRevision,
  resolveAuthorizedVaultScope,
  resolveKnowledgeProfileBinding,
  type Postgres,
} from "@akp/postgres";
import {
  actorOf,
  hasUnrestrictedPathAccess,
  requirePermission,
} from "../auth.js";

interface ProfileScope {
  spaceId: string;
  vaultId: string;
}

interface ProfileDiffBody extends ProfileScope {
  candidateProfile?: unknown;
  candidateRevisionId?: string;
  baseRevisionId?: string;
}

function canonicalProfile(profile: unknown): {
  profile: KnowledgeProfile;
  canonicalProfile: string;
  profileHash: string;
} {
  const parsed = KnowledgeProfileV1.parse(profile);
  const canonicalProfile = canonicalKnowledgeProfileJson(parsed);
  return {
    profile: parsed,
    canonicalProfile,
    profileHash: createHash("sha256").update(canonicalProfile).digest("hex"),
  };
}

async function authorizeProfileAdmin(
  db: Postgres,
  actor: ReturnType<typeof actorOf>,
  scope: ProfileScope,
  reply: FastifyReply,
): Promise<boolean> {
  if (!actor) {
    await reply.code(401).send({ code: "AUTH_REQUIRED" });
    return false;
  }
  if (!scope.spaceId || !scope.vaultId) {
    await reply.code(400).send({ code: "VAULT_SCOPE_REQUIRED" });
    return false;
  }
  if (!hasUnrestrictedPathAccess(actor, scope.spaceId, "admin")) {
    await reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
    return false;
  }
  try {
    const resolved = await resolveAuthorizedVaultScope(db, {
      userId: actor.id,
      spaceId: scope.spaceId,
      vaultId: scope.vaultId,
      vaultIds: [scope.vaultId],
      permission: "admin",
      federated: false,
    });
    const access = resolved.accessByVault[scope.vaultId];
    if (!access || access.pathPrefix !== null) {
      await reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      return false;
    }
    return true;
  } catch (error) {
    await reply.code(403).send({
      code: error instanceof Error ? error.message : "VAULT_ACCESS_DENIED",
    });
    return false;
  }
}

async function effectiveProfile(
  db: Postgres,
  spaceId: string,
  vaultId: string,
) {
  const binding = await resolveKnowledgeProfileBinding(db, spaceId, vaultId);
  if (binding.revision) {
    return {
      source: "DURABLE_REVISION" as const,
      revisionId: binding.revision.id,
      profileId: binding.revision.profileId,
      version: binding.revision.version,
      profileHash: binding.revision.profileHash,
      status: binding.revision.status,
    };
  }
  const fallback = canonicalProfile(DEFAULT_KNOWLEDGE_PROFILE_V1);
  return {
    source: "V03_DEFAULT" as const,
    revisionId: null,
    profileId: fallback.profile.profileId,
    version: fallback.profile.version,
    profileHash: fallback.profileHash,
    status: "ACTIVE" as const,
  };
}

async function profileForRevisionOrEffective(
  db: Postgres,
  scope: ProfileScope,
  revisionId?: string,
): Promise<ReturnType<typeof canonicalProfile>> {
  if (revisionId) {
    const revision = await getKnowledgeProfileRevision(
      db,
      scope.spaceId,
      scope.vaultId,
      revisionId,
    );
    if (!revision) throw new Error("KNOWLEDGE_PROFILE_REVISION_NOT_FOUND");
    return canonicalProfile(revision.profile);
  }
  const binding = await resolveKnowledgeProfileBinding(
    db,
    scope.spaceId,
    scope.vaultId,
  );
  return canonicalProfile(
    binding.revision?.profile ?? DEFAULT_KNOWLEDGE_PROFILE_V1,
  );
}

export function registerProfileGovernanceRoutes(
  app: FastifyInstance,
  db: Postgres,
): void {
  app.get<{ Querystring: ProfileScope }>(
    "/v1/schema/profiles",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      const scope = request.query;
      if (!(await authorizeProfileAdmin(db, actorOf(request), scope, reply))) {
        return;
      }
      const revisions = await db.pool.query(
        `
        select p.id,p.profile_id,p.version,p.profile_hash,p.status,
               p.compatibility_class,p.supersedes_revision_id,p.created_by,
               p.validated_at,p.activated_at,p.superseded_at,p.retired_at,
               p.created_at,p.updated_at,
               d.id latest_dry_run_id,d.compatibility_class latest_compatibility_class,
               d.affected_document_count,d.corpus_revision,d.created_at latest_dry_run_at
          from knowledge_profile_revisions p
          left join lateral (
            select id,compatibility_class,affected_document_count,corpus_revision,created_at
              from schema_dry_runs
             where profile_revision_id=p.id and space_id=p.space_id and vault_id=p.vault_id
             order by created_at desc limit 1
          ) d on true
         where p.space_id=$1 and p.vault_id=$2
         order by p.created_at desc,p.id
        `,
        [scope.spaceId, scope.vaultId],
      );
      return {
        spaceId: scope.spaceId,
        vaultId: scope.vaultId,
        active: await effectiveProfile(db, scope.spaceId, scope.vaultId),
        revisions: revisions.rows,
      };
    },
  );

  app.get<{
    Params: { revisionId: string };
    Querystring: ProfileScope;
  }>(
    "/v1/schema/profiles/:revisionId",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      const scope = request.query;
      if (!(await authorizeProfileAdmin(db, actorOf(request), scope, reply))) {
        return;
      }
      const revision = await getKnowledgeProfileRevision(
        db,
        scope.spaceId,
        scope.vaultId,
        request.params.revisionId,
      );
      if (!revision) {
        return reply
          .code(404)
          .send({ code: "KNOWLEDGE_PROFILE_REVISION_NOT_FOUND" });
      }
      const dryRun = await db.pool.query(
        `
        select id,compatibility_class,affected_document_count,corpus_revision,
               compatibility_status,report,created_at
          from schema_dry_runs
         where space_id=$1 and vault_id=$2 and profile_revision_id=$3
         order by created_at desc limit 1
        `,
        [scope.spaceId, scope.vaultId, revision.id],
      );
      return {
        ...revision,
        latestDryRun: dryRun.rows[0] ?? null,
        active:
          (await effectiveProfile(db, scope.spaceId, scope.vaultId))
            .revisionId === revision.id,
      };
    },
  );

  app.post<{ Body: ProfileScope & { profile: unknown } }>(
    "/v1/schema/profiles/validate",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      const scope = request.body;
      if (!(await authorizeProfileAdmin(db, actorOf(request), scope, reply))) {
        return;
      }
      try {
        const candidate = canonicalProfile(request.body.profile);
        return {
          valid: true,
          profileId: candidate.profile.profileId,
          version: candidate.profile.version,
          profileHash: candidate.profileHash,
          canonicalProfile: candidate.canonicalProfile,
          summary: {
            knowledgeKinds: Object.keys(
              candidate.profile.knowledgeKinds,
            ).sort(),
            relationTypes: Object.keys(candidate.profile.relationTypes).sort(),
            lifecycles: Object.keys(candidate.profile.lifecycles).sort(),
            evidencePolicies: Object.keys(
              candidate.profile.evidencePolicies,
            ).sort(),
            reviewPolicies: Object.keys(
              candidate.profile.reviewPolicies,
            ).sort(),
            artifactContracts: Object.keys(
              candidate.profile.artifactContracts,
            ).sort(),
          },
        };
      } catch (error) {
        return reply.code(400).send({
          code: "INVALID_KNOWLEDGE_PROFILE",
          detail: error instanceof Error ? error.message : "invalid profile",
        });
      }
    },
  );

  app.post<{ Body: ProfileDiffBody }>(
    "/v1/schema/profiles/diff",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      const body = request.body;
      if (!(await authorizeProfileAdmin(db, actorOf(request), body, reply))) {
        return;
      }
      if (
        (body.candidateProfile === undefined) ===
        (body.candidateRevisionId === undefined)
      ) {
        return reply.code(400).send({
          code: "PROFILE_DIFF_CANDIDATE_REQUIRED",
          message:
            "Provide exactly one candidateProfile or candidateRevisionId.",
        });
      }
      try {
        const base = await profileForRevisionOrEffective(
          db,
          body,
          body.baseRevisionId,
        );
        const candidate = body.candidateRevisionId
          ? await profileForRevisionOrEffective(
              db,
              body,
              body.candidateRevisionId,
            )
          : canonicalProfile(body.candidateProfile);
        const compatibility = classifyKnowledgeProfileCompatibility(
          base.profile,
          candidate.profile,
        );
        return {
          base: {
            profileId: base.profile.profileId,
            version: base.profile.version,
            profileHash: base.profileHash,
            revisionId: body.baseRevisionId ?? null,
          },
          candidate: {
            profileId: candidate.profile.profileId,
            version: candidate.profile.version,
            profileHash: candidate.profileHash,
            revisionId: body.candidateRevisionId ?? null,
          },
          ...compatibility,
          usageAware: false,
          impactEndpoint: "/v1/schema/dry-run",
        };
      } catch (error) {
        const code = error instanceof Error ? error.message : String(error);
        if (code === "KNOWLEDGE_PROFILE_REVISION_NOT_FOUND") {
          return reply.code(404).send({ code });
        }
        return reply.code(400).send({
          code: "INVALID_KNOWLEDGE_PROFILE",
          detail: code,
        });
      }
    },
  );
}
