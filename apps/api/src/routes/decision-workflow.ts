import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  addDecisionAlternative,
  addDecisionObjection,
  captureDecisionCandidate,
  createDecisionCandidate,
  decideDecisionAlternative,
  getDecisionCandidateSnapshot,
  getWorkspaceSessionForParticipant,
  listDecisionCandidates,
  requestDecisionConsultation,
  resolveAuthorizedVaultScope,
  resolveDecisionObjection,
  respondDecisionConsultation,
  selectDecisionAlternative,
  type Postgres,
  type WorkspaceSessionAccess,
} from "@akp/postgres";
import {
  actorOf,
  audit,
  requirePermission,
  requirePrincipalAction,
  unrestrictedSpaceIdsForPermission,
} from "../auth.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maxLength ||
    /[\u0000-\u001f]/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function stringList(
  value: unknown,
  options: { min: number; max: number; itemMax: number },
): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length < options.min ||
    value.length > options.max
  ) {
    return null;
  }
  const normalized = value.map((entry) => safeText(entry, options.itemMax));
  if (normalized.some((entry) => entry === null)) return null;
  return [...new Set(normalized as string[])];
}

function optionalDate(value: unknown): Date | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function sendDecisionError(reply: FastifyReply, error: unknown) {
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; statusCode?: unknown };
    if (
      typeof candidate.code === "string" &&
      typeof candidate.statusCode === "number" &&
      candidate.statusCode >= 400 &&
      candidate.statusCode < 600
    ) {
      return reply.code(candidate.statusCode).send({ code: candidate.code });
    }
  }
  throw error;
}

async function authorizedSession(
  db: Postgres,
  request: FastifyRequest,
  reply: FastifyReply,
  sessionId: string,
): Promise<WorkspaceSessionAccess | null> {
  const actor = actorOf(request);
  if (!actor) {
    await reply.code(401).send({ code: "AUTH_REQUIRED" });
    return null;
  }
  const session = await getWorkspaceSessionForParticipant(
    db,
    sessionId,
    actor.id,
  );
  if (!session) {
    await reply.code(404).send({ code: "SESSION_NOT_FOUND" });
    return null;
  }
  if (
    actor.principalKind === "AGENT_PROCESS" &&
    (actor.principalSessionId !== session.id ||
      actor.principalVaultId !== session.vaultId)
  ) {
    await reply.code(404).send({ code: "SESSION_NOT_FOUND" });
    return null;
  }
  if (
    !unrestrictedSpaceIdsForPermission(actor, "knowledge:read").includes(
      session.spaceId,
    )
  ) {
    await reply.code(404).send({ code: "SESSION_NOT_FOUND" });
    return null;
  }
  try {
    const scope = await resolveAuthorizedVaultScope(db, {
      userId: actor.id,
      spaceId: session.spaceId,
      permission: "knowledge:read",
      vaultId: session.vaultId,
      vaultIds: [session.vaultId],
      federated: false,
    });
    if (scope.accessByVault[session.vaultId]?.pathPrefix !== null) {
      await reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      return null;
    }
  } catch {
    await reply.code(404).send({ code: "SESSION_NOT_FOUND" });
    return null;
  }
  return session;
}

function actorSupportsDecisionContribution(
  actor: ReturnType<typeof actorOf>,
): boolean {
  return Boolean(
    actor &&
    (actor.principalKind === "HUMAN" ||
      actor.principalKind === "AGENT_PROCESS"),
  );
}

export function registerDecisionWorkflowRoutes(
  app: FastifyInstance,
  db: Postgres,
): void {
  app.get<{
    Params: { id: string };
    Querystring: { objectRefId?: string };
  }>(
    "/v1/sessions/:id/decisions",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("workspace:read"),
      ],
    },
    async (request, reply) => {
      const session = await authorizedSession(
        db,
        request,
        reply,
        request.params.id,
      );
      if (!session) return;
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const objectRefId = request.query.objectRefId?.trim() || null;
      if (objectRefId && !UUID_PATTERN.test(objectRefId)) {
        return reply.code(400).send({ code: "INVALID_OBJECT_REF_ID" });
      }
      try {
        return {
          decisions: await listDecisionCandidates(db, {
            sessionId: session.id,
            actorUserId: actor.id,
            actorPrincipalId: actor.principalId,
            ...(objectRefId ? { objectRefId } : {}),
          }),
        };
      } catch (error) {
        return sendDecisionError(reply, error);
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      decisionAuthorityPrincipalId?: string;
      title?: string;
      problem?: string;
      context?: string;
      drivers?: string[];
      qualityAttributes?: string[];
      affectedRefs?: string[];
      affectedObjectRefIds?: string[];
      evidenceRefs?: string[];
      verificationPlan?: string;
      verificationDueAt?: string | null;
      decisionDeadline?: string | null;
      supersedesCandidateId?: string | null;
    };
  }>(
    "/v1/sessions/:id/decisions",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("workspace:event:append"),
      ],
    },
    async (request, reply) => {
      const session = await authorizedSession(
        db,
        request,
        reply,
        request.params.id,
      );
      if (!session) return;
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      if (!actorSupportsDecisionContribution(actor)) {
        return reply.code(403).send({ code: "DECISION_PRINCIPAL_KIND_DENIED" });
      }
      const decisionAuthorityPrincipalId =
        request.body?.decisionAuthorityPrincipalId;
      const title = safeText(request.body?.title, 200);
      const problem = safeText(request.body?.problem, 12_000);
      const context = safeText(request.body?.context, 12_000);
      const drivers = stringList(request.body?.drivers, {
        min: 1,
        max: 50,
        itemMax: 2_000,
      });
      const qualityAttributes = stringList(request.body?.qualityAttributes, {
        min: 1,
        max: 50,
        itemMax: 500,
      });
      const affectedRefs = stringList(request.body?.affectedRefs ?? [], {
        min: 0,
        max: 100,
        itemMax: 1_000,
      });
      const affectedObjectRefIds = stringList(
        request.body?.affectedObjectRefIds ?? [],
        {
          min: 0,
          max: 100,
          itemMax: 36,
        },
      );
      const evidenceRefs = stringList(request.body?.evidenceRefs, {
        min: 1,
        max: 100,
        itemMax: 1_000,
      });
      const verificationPlan = safeText(request.body?.verificationPlan, 12_000);
      const verificationDueAt = optionalDate(request.body?.verificationDueAt);
      const decisionDeadline = optionalDate(request.body?.decisionDeadline);
      const supersedesCandidateId =
        request.body?.supersedesCandidateId?.trim() || null;
      if (
        !decisionAuthorityPrincipalId ||
        !UUID_PATTERN.test(decisionAuthorityPrincipalId) ||
        !title ||
        !problem ||
        !context ||
        !drivers ||
        !qualityAttributes ||
        !affectedRefs ||
        !affectedObjectRefIds ||
        affectedObjectRefIds.some((value) => !UUID_PATTERN.test(value)) ||
        !evidenceRefs ||
        !verificationPlan ||
        verificationDueAt === undefined ||
        decisionDeadline === undefined ||
        (supersedesCandidateId && !UUID_PATTERN.test(supersedesCandidateId))
      ) {
        return reply.code(400).send({ code: "INVALID_DECISION_CANDIDATE" });
      }
      try {
        const decision = await createDecisionCandidate(db, {
          sessionId: session.id,
          actorUserId: actor.id,
          actorPrincipalId: actor.principalId,
          decisionAuthorityPrincipalId,
          title,
          problem,
          context,
          drivers,
          qualityAttributes,
          affectedRefs,
          affectedObjectRefIds,
          evidenceRefs,
          verificationPlan,
          verificationDueAt,
          decisionDeadline,
          supersedesCandidateId,
        });
        await audit(
          db,
          request,
          "decision.candidate.create",
          "workspace_decision_candidate",
          decision.id,
          {
            vaultId: session.vaultId,
            sessionId: session.id,
            decisionAuthorityPrincipalId,
            affectedObjectRefIds,
            supersedesCandidateId,
          },
          session.spaceId,
        );
        return reply.code(201).send(decision);
      } catch (error) {
        return sendDecisionError(reply, error);
      }
    },
  );

  app.get<{ Params: { id: string; decisionId: string } }>(
    "/v1/sessions/:id/decisions/:decisionId",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("workspace:read"),
      ],
    },
    async (request, reply) => {
      const session = await authorizedSession(
        db,
        request,
        reply,
        request.params.id,
      );
      if (!session) return;
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      if (!UUID_PATTERN.test(request.params.decisionId)) {
        return reply.code(400).send({ code: "INVALID_DECISION_ID" });
      }
      try {
        return await getDecisionCandidateSnapshot(db, {
          sessionId: session.id,
          candidateId: request.params.decisionId,
          actorUserId: actor.id,
          actorPrincipalId: actor.principalId,
        });
      } catch (error) {
        return sendDecisionError(reply, error);
      }
    },
  );

  app.post<{
    Params: { id: string; decisionId: string };
    Body: {
      title?: string;
      description?: string;
      tradeoffs?: string;
      evidenceRefs?: string[];
    };
  }>(
    "/v1/sessions/:id/decisions/:decisionId/alternatives",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("workspace:event:append"),
      ],
    },
    async (request, reply) => {
      const session = await authorizedSession(
        db,
        request,
        reply,
        request.params.id,
      );
      if (!session) return;
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      if (!actorSupportsDecisionContribution(actor)) {
        return reply.code(403).send({ code: "DECISION_PRINCIPAL_KIND_DENIED" });
      }
      const title = safeText(request.body?.title, 240);
      const description = safeText(request.body?.description, 12_000);
      const tradeoffs = safeText(request.body?.tradeoffs, 12_000);
      const evidenceRefs = stringList(request.body?.evidenceRefs ?? [], {
        min: 0,
        max: 100,
        itemMax: 1_000,
      });
      if (
        !UUID_PATTERN.test(request.params.decisionId) ||
        !title ||
        !description ||
        !tradeoffs ||
        !evidenceRefs
      ) {
        return reply.code(400).send({ code: "INVALID_DECISION_ALTERNATIVE" });
      }
      try {
        const alternative = await addDecisionAlternative(db, {
          sessionId: session.id,
          candidateId: request.params.decisionId,
          actorUserId: actor.id,
          actorPrincipalId: actor.principalId,
          actorPrincipalKind: actor.principalKind,
          title,
          description,
          tradeoffs,
          evidenceRefs,
        });
        await audit(
          db,
          request,
          "decision.alternative.add",
          "workspace_decision_candidate",
          request.params.decisionId,
          {
            vaultId: session.vaultId,
            alternativeId: alternative.id,
            origin: alternative.origin,
          },
          session.spaceId,
        );
        return reply.code(201).send(alternative);
      } catch (error) {
        return sendDecisionError(reply, error);
      }
    },
  );

  app.post<{
    Params: { id: string; decisionId: string; alternativeId: string };
    Body: { decision?: string };
  }>(
    "/v1/sessions/:id/decisions/:decisionId/alternatives/:alternativeId/decision",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("workspace:event:append"),
      ],
    },
    async (request, reply) => {
      const session = await authorizedSession(
        db,
        request,
        reply,
        request.params.id,
      );
      if (!session) return;
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const decision = request.body?.decision?.trim().toUpperCase();
      if (
        !UUID_PATTERN.test(request.params.decisionId) ||
        !UUID_PATTERN.test(request.params.alternativeId) ||
        (decision !== "CONSIDER" && decision !== "REJECT")
      ) {
        return reply
          .code(400)
          .send({ code: "INVALID_DECISION_ALTERNATIVE_DECISION" });
      }
      try {
        const alternative = await decideDecisionAlternative(db, {
          sessionId: session.id,
          candidateId: request.params.decisionId,
          alternativeId: request.params.alternativeId,
          actorUserId: actor.id,
          actorPrincipalId: actor.principalId,
          decision,
        });
        await audit(
          db,
          request,
          "decision.alternative.decision",
          "workspace_decision_candidate",
          request.params.decisionId,
          {
            vaultId: session.vaultId,
            alternativeId: alternative.id,
            decision,
          },
          session.spaceId,
        );
        return alternative;
      } catch (error) {
        return sendDecisionError(reply, error);
      }
    },
  );

  app.post<{
    Params: { id: string; decisionId: string };
    Body: {
      alternativeId?: string | null;
      statement?: string;
      evidenceRefs?: string[];
    };
  }>(
    "/v1/sessions/:id/decisions/:decisionId/objections",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("workspace:event:append"),
      ],
    },
    async (request, reply) => {
      const session = await authorizedSession(
        db,
        request,
        reply,
        request.params.id,
      );
      if (!session) return;
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      if (!actorSupportsDecisionContribution(actor)) {
        return reply.code(403).send({ code: "DECISION_PRINCIPAL_KIND_DENIED" });
      }
      const alternativeId = request.body?.alternativeId?.trim() || null;
      const statement = safeText(request.body?.statement, 12_000);
      const evidenceRefs = stringList(request.body?.evidenceRefs ?? [], {
        min: 0,
        max: 100,
        itemMax: 1_000,
      });
      if (
        !UUID_PATTERN.test(request.params.decisionId) ||
        (alternativeId && !UUID_PATTERN.test(alternativeId)) ||
        !statement ||
        !evidenceRefs
      ) {
        return reply.code(400).send({ code: "INVALID_DECISION_OBJECTION" });
      }
      try {
        const objection = await addDecisionObjection(db, {
          sessionId: session.id,
          candidateId: request.params.decisionId,
          alternativeId,
          actorUserId: actor.id,
          actorPrincipalId: actor.principalId,
          statement,
          evidenceRefs,
        });
        await audit(
          db,
          request,
          "decision.objection.add",
          "workspace_decision_candidate",
          request.params.decisionId,
          {
            vaultId: session.vaultId,
            objectionId: objection.id,
            alternativeId,
          },
          session.spaceId,
        );
        return reply.code(201).send(objection);
      } catch (error) {
        return sendDecisionError(reply, error);
      }
    },
  );

  app.post<{
    Params: { id: string; decisionId: string; objectionId: string };
    Body: { resolution?: string };
  }>(
    "/v1/sessions/:id/decisions/:decisionId/objections/:objectionId/resolve",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("workspace:event:append"),
      ],
    },
    async (request, reply) => {
      const session = await authorizedSession(
        db,
        request,
        reply,
        request.params.id,
      );
      if (!session) return;
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const resolution = safeText(request.body?.resolution, 12_000);
      if (
        !UUID_PATTERN.test(request.params.decisionId) ||
        !UUID_PATTERN.test(request.params.objectionId) ||
        !resolution
      ) {
        return reply
          .code(400)
          .send({ code: "INVALID_DECISION_OBJECTION_RESOLUTION" });
      }
      try {
        const objection = await resolveDecisionObjection(db, {
          sessionId: session.id,
          candidateId: request.params.decisionId,
          objectionId: request.params.objectionId,
          actorUserId: actor.id,
          actorPrincipalId: actor.principalId,
          resolution,
        });
        await audit(
          db,
          request,
          "decision.objection.resolve",
          "workspace_decision_candidate",
          request.params.decisionId,
          {
            vaultId: session.vaultId,
            objectionId: objection.id,
          },
          session.spaceId,
        );
        return objection;
      } catch (error) {
        return sendDecisionError(reply, error);
      }
    },
  );

  app.post<{
    Params: { id: string; decisionId: string };
    Body: { reviewerPrincipalId?: string; question?: string };
  }>(
    "/v1/sessions/:id/decisions/:decisionId/consultations",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("workspace:event:append"),
      ],
    },
    async (request, reply) => {
      const session = await authorizedSession(
        db,
        request,
        reply,
        request.params.id,
      );
      if (!session) return;
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const reviewerPrincipalId = request.body?.reviewerPrincipalId;
      const question = safeText(request.body?.question, 8_000);
      if (
        !UUID_PATTERN.test(request.params.decisionId) ||
        !reviewerPrincipalId ||
        !UUID_PATTERN.test(reviewerPrincipalId) ||
        !question
      ) {
        return reply.code(400).send({ code: "INVALID_DECISION_CONSULTATION" });
      }
      try {
        const consultation = await requestDecisionConsultation(db, {
          sessionId: session.id,
          candidateId: request.params.decisionId,
          actorUserId: actor.id,
          actorPrincipalId: actor.principalId,
          reviewerPrincipalId,
          question,
        });
        await audit(
          db,
          request,
          "decision.consultation.request",
          "workspace_decision_candidate",
          request.params.decisionId,
          {
            vaultId: session.vaultId,
            consultationId: consultation.id,
            reviewerPrincipalId,
          },
          session.spaceId,
        );
        return reply.code(201).send(consultation);
      } catch (error) {
        return sendDecisionError(reply, error);
      }
    },
  );

  app.post<{
    Params: { id: string; decisionId: string; consultationId: string };
    Body: { position?: string; response?: string };
  }>(
    "/v1/sessions/:id/decisions/:decisionId/consultations/:consultationId/respond",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("workspace:event:append"),
      ],
    },
    async (request, reply) => {
      const session = await authorizedSession(
        db,
        request,
        reply,
        request.params.id,
      );
      if (!session) return;
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const position = request.body?.position?.trim().toUpperCase();
      const response = safeText(request.body?.response, 12_000);
      if (
        !UUID_PATTERN.test(request.params.decisionId) ||
        !UUID_PATTERN.test(request.params.consultationId) ||
        !position ||
        !["SUPPORT", "OPPOSE", "NEUTRAL"].includes(position) ||
        !response
      ) {
        return reply
          .code(400)
          .send({ code: "INVALID_DECISION_CONSULTATION_RESPONSE" });
      }
      try {
        const consultation = await respondDecisionConsultation(db, {
          sessionId: session.id,
          candidateId: request.params.decisionId,
          consultationId: request.params.consultationId,
          actorUserId: actor.id,
          actorPrincipalId: actor.principalId,
          position: position as "SUPPORT" | "OPPOSE" | "NEUTRAL",
          response,
        });
        await audit(
          db,
          request,
          "decision.consultation.respond",
          "workspace_decision_candidate",
          request.params.decisionId,
          {
            vaultId: session.vaultId,
            consultationId: consultation.id,
            position,
          },
          session.spaceId,
        );
        return consultation;
      } catch (error) {
        return sendDecisionError(reply, error);
      }
    },
  );

  app.post<{
    Params: { id: string; decisionId: string };
    Body: {
      alternativeId?: string;
      consequences?: string;
      followUpActions?: string[];
      effectiveFrom?: string | null;
      effectiveUntil?: string | null;
    };
  }>(
    "/v1/sessions/:id/decisions/:decisionId/selection",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("workspace:event:append"),
      ],
    },
    async (request, reply) => {
      const session = await authorizedSession(
        db,
        request,
        reply,
        request.params.id,
      );
      if (!session) return;
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const alternativeId = request.body?.alternativeId;
      const consequences = safeText(request.body?.consequences, 12_000);
      const followUpActions = stringList(request.body?.followUpActions ?? [], {
        min: 0,
        max: 100,
        itemMax: 2_000,
      });
      const effectiveFrom = optionalDate(request.body?.effectiveFrom);
      const effectiveUntil = optionalDate(request.body?.effectiveUntil);
      if (
        !UUID_PATTERN.test(request.params.decisionId) ||
        !alternativeId ||
        !UUID_PATTERN.test(alternativeId) ||
        !consequences ||
        !followUpActions ||
        effectiveFrom === undefined ||
        effectiveUntil === undefined ||
        (effectiveUntil !== null &&
          (effectiveFrom === null || effectiveUntil <= effectiveFrom))
      ) {
        return reply.code(400).send({ code: "INVALID_DECISION_SELECTION" });
      }
      try {
        const decision = await selectDecisionAlternative(db, {
          sessionId: session.id,
          candidateId: request.params.decisionId,
          alternativeId,
          actorUserId: actor.id,
          actorPrincipalId: actor.principalId,
          consequences,
          followUpActions,
          effectiveFrom,
          effectiveUntil,
        });
        await audit(
          db,
          request,
          "decision.selection",
          "workspace_decision_candidate",
          decision.id,
          {
            vaultId: session.vaultId,
            alternativeId,
            effectiveFrom: effectiveFrom?.toISOString() ?? null,
            effectiveUntil: effectiveUntil?.toISOString() ?? null,
          },
          session.spaceId,
        );
        return decision;
      } catch (error) {
        return sendDecisionError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string; decisionId: string } }>(
    "/v1/sessions/:id/decisions/:decisionId/capture",
    {
      preHandler: [
        requirePermission("knowledge:propose"),
        requirePrincipalAction("knowledge:propose"),
      ],
    },
    async (request, reply) => {
      const session = await authorizedSession(
        db,
        request,
        reply,
        request.params.id,
      );
      if (!session) return;
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      if (!UUID_PATTERN.test(request.params.decisionId)) {
        return reply.code(400).send({ code: "INVALID_DECISION_ID" });
      }
      try {
        const captured = await captureDecisionCandidate(db, {
          sessionId: session.id,
          candidateId: request.params.decisionId,
          actorUserId: actor.id,
          actorPrincipalId: actor.principalId,
        });
        await audit(
          db,
          request,
          "decision.capture",
          "workspace_decision_candidate",
          captured.candidate.id,
          {
            vaultId: session.vaultId,
            eventId: String(captured.event.id),
          },
          session.spaceId,
        );
        return reply.code(201).send({
          candidate: captured.candidate,
          eventId: String(captured.event.id),
          eventType: "DECISION_CANDIDATE",
        });
      } catch (error) {
        return sendDecisionError(reply, error);
      }
    },
  );
}
