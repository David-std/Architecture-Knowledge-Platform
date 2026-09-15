import type { FastifyInstance } from "fastify";
import {
  activateKnowledgeProfile,
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

function activationErrorStatus(code: string): number {
  if (code === "KNOWLEDGE_PROFILE_REVISION_NOT_FOUND") return 404;
  if (code === "VAULT_NOT_FOUND_OR_SCOPE_MISMATCH") return 404;
  if (
    code === "CONTEXT_REVISION_CHANGED" ||
    code === "KNOWLEDGE_PROFILE_DRY_RUN_REQUIRED" ||
    code === "PROFILE_REVIEW_REQUIRED" ||
    code === "KNOWLEDGE_PROFILE_NOT_VALIDATED" ||
    code === "KNOWLEDGE_PROFILE_SUPERSESSION_REQUIRED" ||
    code === "KNOWLEDGE_PROFILE_ACTIVATION_CONFLICT" ||
    code === "ACTIVE_KNOWLEDGE_PROFILE_BINDING_INVALID"
  ) {
    return 409;
  }
  return 500;
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
      if (!hasUnrestrictedPathAccess(actor, body.spaceId, "admin")) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });

      try {
        const scope = await resolveAuthorizedVaultScope(db, {
          userId: actor.id,
          spaceId: body.spaceId,
          vaultId: body.vaultId,
          vaultIds: [body.vaultId],
          permission: "admin",
          federated: false,
        });
        const access = scope.accessByVault[body.vaultId];
        if (!access || access.pathPrefix !== null) {
          return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
        }
      } catch (error) {
        return reply.code(403).send({
          code: error instanceof Error ? error.message : "VAULT_ACCESS_DENIED",
        });
      }

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
}
