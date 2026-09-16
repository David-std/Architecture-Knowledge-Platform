import type { FastifyInstance } from "fastify";
import {
  activateKnowledgeProfile,
  rollbackKnowledgeProfile,
  resolveAuthorizedVaultScope,
  type Postgres,
} from "@akp/postgres";
import {
  actorOf,
  hasUnrestrictedPathAccess,
  requirePermission,
} from "../auth.js";

interface ProfileActivationBody {
  spaceId: string;
  vaultId: string;
  profileRevisionId: string;
  dryRunId: string;
  expectedProfileHash: string;
  expectedCorpusRevision: string;
}

interface ProfileRollbackBody {
  spaceId: string;
  vaultId: string;
  targetRevisionId: string;
  dryRunId: string;
  expectedProfileHash: string;
  expectedCorpusRevision: string;
  expectedActiveRevisionId: string;
}

type ProfileMutationAuthorization =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 404; code: string };

function activationErrorStatus(code: string): number {
  if (code === "KNOWLEDGE_PROFILE_REVISION_NOT_FOUND") return 404;
  if (code === "VAULT_NOT_FOUND_OR_SCOPE_MISMATCH") return 404;
  if (
    code === "CONTEXT_REVISION_CHANGED" ||
    code === "KNOWLEDGE_PROFILE_DRY_RUN_REQUIRED" ||
    code === "PROFILE_REVIEW_REQUIRED" ||
    code === "PROFILE_ROLLBACK_REVIEW_REQUIRED" ||
    code === "KNOWLEDGE_PROFILE_NOT_VALIDATED" ||
    code === "KNOWLEDGE_PROFILE_SUPERSESSION_REQUIRED" ||
    code === "KNOWLEDGE_PROFILE_ACTIVATION_CONFLICT" ||
    code === "KNOWLEDGE_PROFILE_ROLLBACK_TARGET_INVALID" ||
    code === "KNOWLEDGE_PROFILE_ROLLBACK_TARGET_NOT_PREDECESSOR" ||
    code === "KNOWLEDGE_PROFILE_ROLLBACK_CONFLICT" ||
    code === "ACTIVE_KNOWLEDGE_PROFILE_BINDING_INVALID"
  ) {
    return 409;
  }
  return 500;
}

async function authorizeProfileMutation(
  db: Postgres,
  input: {
    actor: ReturnType<typeof actorOf>;
    spaceId: string;
    vaultId: string;
  },
): Promise<ProfileMutationAuthorization> {
  if (!hasUnrestrictedPathAccess(input.actor, input.spaceId, "admin")) {
    return { ok: false, status: 403, code: "PATH_SCOPE_DENIED" };
  }
  if (!input.actor) {
    return { ok: false, status: 401, code: "AUTH_REQUIRED" };
  }
  try {
    const scope = await resolveAuthorizedVaultScope(db, {
      userId: input.actor.id,
      spaceId: input.spaceId,
      vaultId: input.vaultId,
      vaultIds: [input.vaultId],
      permission: "admin",
      federated: false,
    });
    const access = scope.accessByVault[input.vaultId];
    if (!access || access.pathPrefix !== null) {
      return { ok: false, status: 403, code: "PATH_SCOPE_DENIED" };
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : "VAULT_ACCESS_DENIED";
    return {
      ok: false,
      status: code === "VAULT_SCOPE_NOT_FOUND" ? 404 : 403,
      code,
    };
  }
  return { ok: true };
}

export function registerProfileActivationRoutes(
  app: FastifyInstance,
  db: Postgres,
): void {
  app.post<{ Body: ProfileActivationBody }>(
    "/v1/schema/activate",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      const actor = actorOf(request);
      const body = request.body;
      if (
        !body?.spaceId ||
        !body.vaultId ||
        !body.profileRevisionId ||
        !body.dryRunId ||
        !body.expectedProfileHash ||
        !body.expectedCorpusRevision
      ) {
        return reply
          .code(400)
          .send({ code: "PROFILE_ACTIVATION_INPUT_REQUIRED" });
      }
      if (!/^[a-f0-9]{64}$/.test(body.expectedProfileHash)) {
        return reply.code(400).send({ code: "INVALID_PROFILE_HASH" });
      }
      const authorization = await authorizeProfileMutation(db, {
        actor,
        spaceId: body.spaceId,
        vaultId: body.vaultId,
      });
      if (!authorization.ok) {
        return reply
          .code(authorization.status)
          .send({ code: authorization.code });
      }
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });

      try {
        const activated = await activateKnowledgeProfile(db, {
          spaceId: body.spaceId,
          vaultId: body.vaultId,
          revisionId: body.profileRevisionId,
          dryRunId: body.dryRunId,
          expectedProfileHash: body.expectedProfileHash,
          expectedCorpusRevision: body.expectedCorpusRevision,
          actorId: actor.id,
          traceId: request.id,
        });
        return {
          profileRevisionId: activated.revision.id,
          profileId: activated.revision.profileId,
          version: activated.revision.version,
          profileHash: activated.revision.profileHash,
          status: activated.revision.status,
          previousRevisionId: activated.previousRevisionId,
          corpusRevision: activated.corpusRevision,
          dryRunId: activated.dryRunId,
          alreadyActive: activated.alreadyActive,
        };
      } catch (error) {
        const code =
          error instanceof Error ? error.message : "PROFILE_ACTIVATION_FAILED";
        const status = activationErrorStatus(code);
        if (status < 500) return reply.code(status).send({ code });
        throw error;
      }
    },
  );

  app.post<{ Body: ProfileRollbackBody }>(
    "/v1/schema/rollback",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      const actor = actorOf(request);
      const body = request.body;
      if (
        !body?.spaceId ||
        !body.vaultId ||
        !body.targetRevisionId ||
        !body.dryRunId ||
        !body.expectedProfileHash ||
        !body.expectedCorpusRevision ||
        !body.expectedActiveRevisionId
      ) {
        return reply
          .code(400)
          .send({ code: "PROFILE_ROLLBACK_INPUT_REQUIRED" });
      }
      if (!/^[a-f0-9]{64}$/.test(body.expectedProfileHash)) {
        return reply.code(400).send({ code: "INVALID_PROFILE_HASH" });
      }
      const authorization = await authorizeProfileMutation(db, {
        actor,
        spaceId: body.spaceId,
        vaultId: body.vaultId,
      });
      if (!authorization.ok) {
        return reply
          .code(authorization.status)
          .send({ code: authorization.code });
      }
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });

      try {
        const rolledBack = await rollbackKnowledgeProfile(db, {
          spaceId: body.spaceId,
          vaultId: body.vaultId,
          targetRevisionId: body.targetRevisionId,
          dryRunId: body.dryRunId,
          expectedProfileHash: body.expectedProfileHash,
          expectedCorpusRevision: body.expectedCorpusRevision,
          expectedActiveRevisionId: body.expectedActiveRevisionId,
          actorId: actor.id,
          traceId: request.id,
        });
        return {
          profileRevisionId: rolledBack.revision.id,
          profileId: rolledBack.revision.profileId,
          version: rolledBack.revision.version,
          profileHash: rolledBack.revision.profileHash,
          status: rolledBack.revision.status,
          rolledBackFromRevisionId: rolledBack.rolledBackFromRevisionId,
          corpusRevision: rolledBack.corpusRevision,
          dryRunId: rolledBack.dryRunId,
          alreadyActive: rolledBack.alreadyActive,
        };
      } catch (error) {
        const code =
          error instanceof Error ? error.message : "PROFILE_ROLLBACK_FAILED";
        const status = activationErrorStatus(code);
        if (status < 500) return reply.code(status).send({ code });
        throw error;
      }
    },
  );
}
