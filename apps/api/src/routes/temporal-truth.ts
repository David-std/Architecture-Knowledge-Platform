import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  PostgresTemporalTruthStore,
  pathMatchesVaultPrefix,
  resolveAuthorizedVaultScope,
  type Postgres,
} from "@akp/postgres";
import {
  actorOf,
  hasPathAccess,
  hasSpaceAccess,
  requirePermission,
} from "../auth.js";

const HASH64 = /^[a-f0-9]{64}$/;

const TruthFactsQuery = z.object({
  spaceId: z.string().uuid(),
  vaultId: z.string().uuid(),
  subjectRef: z.string().trim().min(1).max(2048).optional(),
  predicate: z.string().trim().min(1).max(512).optional(),
  mode: z.enum(["CURRENT", "HISTORY"]).default("CURRENT"),
  validAt: z.string().datetime().optional(),
  recordedAtOrBefore: z.string().datetime().optional(),
  truthRevisionHash: z.string().regex(HASH64).optional(),
  changedSince: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

const TruthHistoryParams = z.object({
  factId: z.string().uuid(),
});

const TruthHistoryQuery = z.object({
  spaceId: z.string().uuid(),
  vaultId: z.string().uuid(),
});

function truthStatus(code: string): number {
  if (
    code === "TRUTH_FACT_NOT_FOUND" ||
    code === "TRUTH_FACT_NOT_FOUND_OR_UNAUTHORIZED" ||
    code === "VAULT_SCOPE_NOT_FOUND"
  ) {
    return 404;
  }
  if (
    code === "VAULT_ACCESS_DENIED" ||
    code === "SPACE_ACCESS_DENIED" ||
    code === "PRINCIPAL_VAULT_SCOPE_DENIED"
  ) {
    return 403;
  }
  if (
    code === "TRUTH_REVISION_NOT_FOUND" ||
    code === "TRUTH_SUPPORT_SET_NOT_FOUND"
  ) {
    return 409;
  }
  if (
    code.startsWith("TRUTH_") ||
    code === "FEDERATED_QUERY_REQUIRES_EXPLICIT_OPT_IN" ||
    code === "VAULT_SCOPE_REQUIRED"
  ) {
    return 400;
  }
  return 500;
}

function sendTruthError(reply: FastifyReply, error: unknown) {
  const code =
    error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "TRUTH_QUERY_FAILED";
  return reply.code(truthStatus(code)).send({ code });
}

async function authorizedTruthScope(
  db: Postgres,
  request: FastifyRequest,
  spaceId: string,
  vaultId: string,
) {
  const actor = actorOf(request);
  if (!actor) throw new Error("AUTH_REQUIRED");
  if (!hasSpaceAccess(actor, spaceId, "knowledge:read")) {
    throw new Error("SPACE_ACCESS_DENIED");
  }
  if (
    actor.principalKind === "AGENT_PROCESS" &&
    actor.principalVaultId &&
    actor.principalVaultId !== vaultId
  ) {
    throw new Error("PRINCIPAL_VAULT_SCOPE_DENIED");
  }
  const resolved = await resolveAuthorizedVaultScope(db, {
    userId: actor.id,
    spaceId,
    permission: "knowledge:read",
    vaultId,
    vaultIds: [vaultId],
    federated: false,
  });
  const access = resolved.accessByVault[vaultId];
  if (!access) throw new Error("VAULT_ACCESS_DENIED");
  return { actor, pathPrefix: access.pathPrefix };
}

export function registerTemporalTruthRoutes(
  app: FastifyInstance,
  db: Postgres,
) {
  const store = new PostgresTemporalTruthStore(db);

  app.get(
    "/v1/truth/facts",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const parsed = TruthFactsQuery.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ code: "INVALID_TRUTH_QUERY" });
      }
      try {
        const access = await authorizedTruthScope(
          db,
          request,
          parsed.data.spaceId,
          parsed.data.vaultId,
        );
        const facts = await store.listFacts({
          spaceId: parsed.data.spaceId,
          vaultId: parsed.data.vaultId,
          mode: parsed.data.mode,
          authorizationPathPrefixes: [access.pathPrefix],
          limit: parsed.data.limit,
          ...(parsed.data.subjectRef
            ? { subjectRef: parsed.data.subjectRef }
            : {}),
          ...(parsed.data.predicate ? { predicate: parsed.data.predicate } : {}),
          ...(parsed.data.validAt ? { validAt: parsed.data.validAt } : {}),
          ...(parsed.data.recordedAtOrBefore
            ? { recordedAtOrBefore: parsed.data.recordedAtOrBefore }
            : {}),
          ...(parsed.data.truthRevisionHash
            ? { truthRevisionHash: parsed.data.truthRevisionHash }
            : {}),
          ...(parsed.data.changedSince
            ? { changedSince: parsed.data.changedSince }
            : {}),
        });
        return {
          facts,
          mode: parsed.data.mode,
          headRevision: await store.currentRevision(
            parsed.data.spaceId,
            parsed.data.vaultId,
          ),
        };
      } catch (error) {
        return sendTruthError(reply, error);
      }
    },
  );

  app.get(
    "/v1/truth/facts/:factId/support-history",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const params = TruthHistoryParams.safeParse(request.params);
      const query = TruthHistoryQuery.safeParse(request.query);
      if (!params.success || !query.success) {
        return reply.code(400).send({ code: "INVALID_TRUTH_HISTORY_QUERY" });
      }
      try {
        const access = await authorizedTruthScope(
          db,
          request,
          query.data.spaceId,
          query.data.vaultId,
        );
        const history = await store.supportHistory(params.data.factId);
        if (
          history.fact.spaceId !== query.data.spaceId ||
          history.fact.vaultId !== query.data.vaultId ||
          !hasPathAccess(
            access.actor,
            query.data.spaceId,
            "knowledge:read",
            history.fact.authorizationPath,
          ) ||
          !pathMatchesVaultPrefix(
            history.fact.authorizationPath,
            access.pathPrefix,
          )
        ) {
          throw new Error("TRUTH_FACT_NOT_FOUND_OR_UNAUTHORIZED");
        }
        return history;
      } catch (error) {
        return sendTruthError(reply, error);
      }
    },
  );
}
