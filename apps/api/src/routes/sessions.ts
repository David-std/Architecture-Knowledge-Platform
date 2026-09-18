import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { OpenTelemetryBridge } from "@akp/observability";
import { BootstrapContext } from "@akp/application";
import { ContextPacketResponse, QueryIntent } from "@akp/contracts";
import { parseKnowledgeDocumentMetadata } from "@akp/validation";
import {
  DEFAULT_KNOWLEDGE_PROFILE_V1,
  KnowledgeProfileV1,
} from "@akp/contracts/knowledge-profile";
import {
  AGENT_PROCESS_ALLOWED_ACTIONS,
  DEFAULT_AGENT_PROCESS_ACTIONS,
  addWorkspaceParticipant,
  appendWorkspaceEvent,
  appendWorkspaceEventInTransaction,
  createAgentProcessPrincipalCredential,
  claimWorkspaceWork,
  createWorkspaceSession,
  getWorkspaceSessionForParticipant,
  handoffWorkspaceWork,
  heartbeatWorkspaceWork,
  releaseWorkspaceWork,
  updateWorkspaceWorkContext,
  getActiveKnowledgeProfileRevision,
  assertWorkspaceContextRevisionCurrent,
  isWorkspaceWorkKey,
  listWorkspaceSessionsForParticipant,
  linkDecisionCandidateReviewInTransaction,
  PostgresAuthorizationPort,
  resolveAuthorizedVaultScope,
  revokeAgentProcessPrincipal,
  workspaceSessionSnapshot,
  workspacePromotionEvidence,
  validateDecisionPromotionCandidate,
  type Postgres,
  type WorkspaceSessionAccess,
} from "@akp/postgres";
import {
  actorOf,
  audit,
  authorizationPolicyFingerprint,
  requirePermission,
  requirePrincipalAction,
  serializeEffectiveScopes,
  unrestrictedSpaceIdsForPermission,
} from "../auth.js";

const PRINCIPAL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const WORK_CONTEXT_STATUSES = new Set([
  "OPEN",
  "BLOCKED",
  "COMPLETED",
  "ABANDONED",
]);

const USER_EVENT_TYPES = new Set([
  "FINDING",
  "BLOCKER",
  "QUESTION",
  "ARTIFACT",
  "DECISION_CANDIDATE",
  "NOTE",
]);

function boundedLeaseSeconds(value: unknown): number | null {
  const candidate = Number(value ?? 120);
  if (!Number.isInteger(candidate) || candidate < 15 || candidate > 900) {
    return null;
  }
  return candidate;
}

function boundedEventPayload(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > 16 * 1024) return null;
  return value as Record<string, unknown>;
}

function boundedHandoffText(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    !normalized ||
    Buffer.byteLength(normalized, "utf8") > maxBytes ||
    /[\u0000-\u001f]/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function boundedHandoffList(
  value: unknown,
  maxItems: number,
  maxItemBytes: number,
): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const normalized = value.map((entry) =>
    boundedHandoffText(entry, maxItemBytes),
  );
  if (normalized.some((entry) => entry === null)) return null;
  return [...new Set(normalized as string[])];
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
    actor.principalSessionId !== session.id
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

async function userHasFullVaultRead(
  db: Postgres,
  userId: string,
  session: WorkspaceSessionAccess,
): Promise<boolean> {
  try {
    const scope = await resolveAuthorizedVaultScope(db, {
      userId,
      spaceId: session.spaceId,
      permission: "knowledge:read",
      vaultId: session.vaultId,
      vaultIds: [session.vaultId],
      federated: false,
    });
    return scope.accessByVault[session.vaultId]?.pathPrefix === null;
  } catch {
    return false;
  }
}

export function registerSessionRoutes(
  app: FastifyInstance,
  db: Postgres,
): void {
  const workspaceTelemetry = new OpenTelemetryBridge();
  app.get(
    "/v1/sessions",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("workspace:read"),
      ],
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const spaces = unrestrictedSpaceIdsForPermission(actor, "knowledge:read");
      if (!spaces.length) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const vaultIds: string[] = [];
      for (const spaceId of spaces) {
        try {
          const scope = await resolveAuthorizedVaultScope(db, {
            userId: actor.id,
            spaceId,
            permission: "knowledge:read",
            federated: true,
          });
          for (const vaultId of scope.vaultIds) {
            // Sessions are pathless context containers. A prefix grant cannot
            // safely authorize the whole session record.
            if (scope.accessByVault[vaultId]?.pathPrefix === null) {
              vaultIds.push(vaultId);
            }
          }
        } catch {
          // No visible vault in this otherwise authorized space.
        }
      }
      if (!vaultIds.length) return { sessions: [] };
      const sessions = await listWorkspaceSessionsForParticipant(
        db,
        actor.id,
        spaces,
        [...new Set(vaultIds)],
      );
      return {
        sessions:
          actor.principalKind === "AGENT_PROCESS"
            ? sessions.filter(
                (session) => session.id === actor.principalSessionId,
              )
            : sessions,
      };
    },
  );

  app.post<{
    Body: {
      purpose: string;
      contextBudget?: number;
      projectId?: string;
      spaceId: string;
      vaultId: string;
    };
  }>(
    "/v1/sessions",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("workspace:create"),
      ],
    },
    async (request, reply) => {
      if (!request.body?.purpose?.trim()) {
        return reply.code(400).send({ code: "SESSION_PURPOSE_REQUIRED" });
      }
      const actor = actorOf(request);
      const budget = Math.max(
        256,
        Math.min(Number(request.body.contextBudget ?? 6000), 32000),
      );
      const spaceId = request.body.spaceId;
      const vaultId = request.body.vaultId;
      if (!spaceId || !vaultId) {
        return reply.code(400).send({ code: "VAULT_SCOPE_REQUIRED" });
      }
      if (
        !unrestrictedSpaceIdsForPermission(actor, "knowledge:read").includes(
          spaceId,
        )
      ) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      try {
        const scope = await resolveAuthorizedVaultScope(db, {
          userId: actor.id,
          spaceId,
          permission: "knowledge:read",
          vaultId,
          vaultIds: [vaultId],
          federated: false,
        });
        if (scope.accessByVault[vaultId]?.pathPrefix !== null) {
          return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
        }
      } catch (error) {
        return reply.code(403).send({
          code: error instanceof Error ? error.message : "VAULT_ACCESS_DENIED",
        });
      }
      if (request.body.projectId) {
        const project = await db.pool.query(
          `select id from projects
             where id=$1 and space_id=$2 and vault_id=$3`,
          [request.body.projectId, spaceId, vaultId],
        );
        if (!project.rowCount) {
          return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
        }
      }
      const session = await createWorkspaceSession(db, {
        spaceId,
        vaultId,
        actorId: actor.id,
        ...(request.body.projectId !== undefined
          ? { projectId: request.body.projectId }
          : {}),
        purpose: request.body.purpose.trim(),
        contextBudget: budget,
      });
      await audit(
        db,
        request,
        "agent_session.create",
        "agent_session",
        session.id,
        { vaultId },
        spaceId,
      );
      return reply.code(201).send(session);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/sessions/:id/state",
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
      const snapshot = await workspaceSessionSnapshot(db, session.id, actor.id);
      if (!snapshot) return reply.code(404).send({ code: "SESSION_NOT_FOUND" });
      return snapshot;
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      query?: string;
      intent?: string;
      packetMode?: "COMPACT_AGENT_PACKET" | "FULL_CONTEXT_PACKET";
    };
  }>(
    "/v1/sessions/:id/bootstrap",
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

      const intent = QueryIntent.safeParse(
        request.body?.intent ?? "WORKFLOW_EXECUTION",
      );
      if (!intent.success) {
        return reply.code(400).send({ code: "INVALID_BOOTSTRAP_INTENT" });
      }
      const packetMode = request.body?.packetMode ?? "COMPACT_AGENT_PACKET";
      if (
        !["COMPACT_AGENT_PACKET", "FULL_CONTEXT_PACKET"].includes(packetMode)
      ) {
        return reply.code(400).send({ code: "INVALID_BOOTSTRAP_PACKET_MODE" });
      }
      const query = request.body?.query?.trim();
      if (query && Buffer.byteLength(query, "utf8") > 4096) {
        return reply.code(413).send({ code: "BOOTSTRAP_QUERY_TOO_LARGE" });
      }

      const authorizationPort = new PostgresAuthorizationPort(db);
      let vaultAuthorizationRevision: string;
      try {
        const authorizationScope = await authorizationPort.resolveVaultScope({
          userId: actor.id,
          spaceId: session.spaceId,
          permission: "knowledge:read",
          vaultId: session.vaultId,
          vaultIds: [session.vaultId],
          federated: false,
        });
        vaultAuthorizationRevision = authorizationScope.policyRevision;
      } catch {
        return reply.code(403).send({ code: "VAULT_ACCESS_DENIED" });
      }
      const actorAuthorizationRevision = authorizationPolicyFingerprint(actor);
      const effectiveAuthorizationRevision = createHash("sha256")
        .update(`${actorAuthorizationRevision}:${vaultAuthorizationRevision}`)
        .digest("hex");

      const bootstrap = new BootstrapContext({
        loadWorkContext: async (sessionId, actorId) => {
          const snapshot = await workspaceSessionSnapshot(
            db,
            sessionId,
            actorId,
          );
          if (!snapshot) return null;
          return {
            session: {
              id: snapshot.session.id,
              spaceId: snapshot.session.spaceId,
              vaultId: snapshot.session.vaultId,
              purpose: snapshot.session.purpose,
              contextBudget: snapshot.session.contextBudget,
              coordinationVersion: snapshot.session.coordinationVersion,
            },
            principals: snapshot.principals,
            assignedPrincipals: snapshot.assignedPrincipals,
            claims: snapshot.claims,
            events: snapshot.events,
            snapshotVersion: snapshot.snapshotVersion,
            eventWindow: snapshot.eventWindow,
            contextRevision: {
              status: snapshot.contextRevision.status,
              pinned: snapshot.contextRevision.pinned
                ? {
                    revisionSetHash:
                      snapshot.contextRevision.pinned.revisionSetHash,
                  }
                : null,
              current: {
                revisionSetHash:
                  snapshot.contextRevision.current.revisionSetHash,
              },
              changedDimensions: snapshot.contextRevision.changedDimensions,
            },
          };
        },
        loadKnowledgeProfile: async (spaceId, vaultId, bootstrapIntent) => {
          const active = await getActiveKnowledgeProfileRevision(
            db,
            spaceId,
            vaultId,
          );
          const profile = KnowledgeProfileV1.parse(
            active?.profile ?? DEFAULT_KNOWLEDGE_PROFILE_V1,
          );
          const revision = session.contextRevisionSet;
          if (!revision) throw new Error("CONTEXT_REVISION_PIN_REQUIRED");
          const mandatoryKinds =
            profile.retrievalPolicy.mandatoryKindsByIntent[bootstrapIntent] ??
            [];
          return {
            source: active
              ? ("DURABLE_REVISION" as const)
              : ("DEFAULT" as const),
            revisionId: active?.id ?? null,
            profileId: profile.profileId,
            version: profile.version,
            hash: active?.profileHash ?? revision.profile.hash,
            policyRevision: revision.policy.revision,
            allowedKnowledgeKinds: profile.retrievalPolicy.allowedKinds,
            mandatoryKinds,
            progressiveDisclosure:
              profile.retrievalPolicy.progressiveDisclosure,
            promotion: {
              allowedTargetScopes: profile.promotionPolicy.allowedTargetScopes,
              reviewRequired: profile.promotionPolicy.reviewRequired,
            },
          };
        },
        buildAuthorizedContext: async (input) => {
          const response = await app.inject({
            method: "POST",
            url: "/v1/context",
            headers: {
              ...(request.headers.authorization
                ? { authorization: request.headers.authorization }
                : {}),
              ...(request.headers.cookie
                ? { cookie: request.headers.cookie }
                : {}),
              ...(request.headers["x-csrf-token"]
                ? {
                    "x-csrf-token": String(request.headers["x-csrf-token"]),
                  }
                : {}),
            },
            payload: {
              query: input.query,
              intent: input.intent,
              spaceId: input.spaceId,
              vaultId: input.vaultId,
              federated: false,
              mode: "SOURCE_BACKED",
              maxTokens: input.maxTokens,
              packetMode: input.mode,
            },
          });
          if (response.statusCode !== 200) {
            const body = response.json() as { code?: string };
            const error = new Error(
              body.code ?? "BOOTSTRAP_CONTEXT_BUILD_FAILED",
            ) as Error & { statusCode?: number; code?: string };
            error.statusCode = response.statusCode;
            error.code = body.code ?? "BOOTSTRAP_CONTEXT_BUILD_FAILED";
            throw error;
          }
          return ContextPacketResponse.parse(response.json());
        },
        verifyRevisionCurrent: async (sessionId, spaceId, vaultId) =>
          assertWorkspaceContextRevisionCurrent(
            db.pool,
            sessionId,
            spaceId,
            vaultId,
          ),
      });

      const result = await bootstrap.execute(
        {
          sessionId: session.id,
          actorId: actor.id,
          ...(query ? { query } : {}),
          intent: intent.data,
          mode: packetMode,
        },
        {
          principalId: actor.principalId,
          principalKind: actor.principalKind,
          principalPolicyRevision: actor.principalPolicyRevision,
          allowedActions: [...actor.principalAllowedActions].sort(),
          scopeFingerprint: actor.idempotencyScopeFingerprint,
          policyRevision: effectiveAuthorizationRevision,
        },
      );
      workspaceTelemetry.counter("akp.workspace.bootstrap_total", 1, {
        mode: packetMode,
        profileSource: result.knowledgeProfile.source,
      });
      await audit(
        db,
        request,
        "workspace.bootstrap",
        "agent_session",
        session.id,
        {
          vaultId: session.vaultId,
          revisionSetHash: result.revisionSetHash,
          contextPacketHash: result.context.packetHash,
          snapshotVersion: result.workContext.snapshotVersion,
        },
        session.spaceId,
      );
      if (!session.contextRevisionSet || !session.contextRevisionSetHash) {
        return reply.code(409).send({ code: "CONTEXT_REVISION_PIN_REQUIRED" });
      }
      const effectiveContextRevisionSet = {
        ...session.contextRevisionSet,
        authorization: {
          source: "BUILT_IN_AUTHORIZATION" as const,
          principalId: actor.principalId,
          principalKind: actor.principalKind,
          principalPolicyRevision: actor.principalPolicyRevision,
          actorRevision: actorAuthorizationRevision,
          vaultRevision: vaultAuthorizationRevision,
          revision: effectiveAuthorizationRevision,
        },
      };
      const effectiveRevisionSetHash = createHash("sha256")
        .update(
          `${session.contextRevisionSetHash}:${effectiveAuthorizationRevision}`,
        )
        .digest("hex");
      return {
        ...result,
        sharedRevisionSetHash: result.revisionSetHash,
        effectiveRevisionSetHash,
        contextRevisionSet: effectiveContextRevisionSet,
      };
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      evidenceEventIds?: string[];
      summary?: string;
      changes?: Array<{ path: string; content: string; reason?: string }>;
    };
  }>(
    "/v1/sessions/:id/promotions",
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
      const evidenceEventIds = request.body?.evidenceEventIds ?? [];
      const changes = request.body?.changes ?? [];
      if (evidenceEventIds.length > 100) {
        return reply
          .code(413)
          .send({ code: "PROMOTION_EVIDENCE_LIMIT_EXCEEDED" });
      }
      if (changes.length > 100) {
        return reply
          .code(413)
          .send({ code: "PROMOTION_CHANGE_LIMIT_EXCEEDED" });
      }
      if (!evidenceEventIds.length) {
        return reply.code(400).send({ code: "PROMOTION_EVIDENCE_REQUIRED" });
      }
      if (!changes.length) {
        return reply.code(400).send({ code: "PROMOTION_CHANGES_REQUIRED" });
      }
      const duplicatePaths = changes
        .map((change) => change.path.trim())
        .filter((path, index, all) => all.indexOf(path) !== index);
      if (duplicatePaths.length) {
        return reply.code(400).send({ code: "PROMOTION_DUPLICATE_PATH" });
      }
      const evidence = await workspacePromotionEvidence(db, {
        sessionId: session.id,
        actorId: actor.id,
        eventIds: evidenceEventIds,
      });
      const structuredDecisionEvents = evidence.events.flatMap((event) => {
        if (String(event.event_type) !== "DECISION_CANDIDATE") return [];
        const payload =
          event.payload && typeof event.payload === "object"
            ? (event.payload as Record<string, unknown>)
            : null;
        const candidateId = payload?.decisionWorkflowCandidateId;
        return typeof candidateId === "string" && candidateId
          ? [{ event, candidateId }]
          : [];
      });
      if (structuredDecisionEvents.length > 1) {
        return reply
          .code(400)
          .send({ code: "DECISION_PROMOTION_SINGLE_CANDIDATE_REQUIRED" });
      }
      let decisionCandidate: Awaited<
        ReturnType<typeof validateDecisionPromotionCandidate>
      > | null = null;
      let decisionCapturedEventId: string | null = null;
      if (structuredDecisionEvents[0]) {
        decisionCapturedEventId = String(structuredDecisionEvents[0].event.id);
        try {
          decisionCandidate = await validateDecisionPromotionCandidate(db, {
            sessionId: session.id,
            candidateId: structuredDecisionEvents[0].candidateId,
            capturedEventId: decisionCapturedEventId,
            actorUserId: actor.id,
            actorPrincipalId: actor.principalId,
          });
        } catch (error) {
          if (error && typeof error === "object") {
            const candidate = error as {
              code?: unknown;
              statusCode?: unknown;
            };
            if (
              typeof candidate.code === "string" &&
              typeof candidate.statusCode === "number"
            ) {
              return reply
                .code(candidate.statusCode)
                .send({ code: candidate.code });
            }
          }
          throw error;
        }
      }
      const proposal = await app.inject({
        method: "POST",
        url: "/v1/proposals",
        headers: {
          ...(request.headers.authorization
            ? { authorization: request.headers.authorization }
            : {}),
          ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
          ...(request.headers["x-csrf-token"]
            ? {
                "x-csrf-token": String(request.headers["x-csrf-token"]),
              }
            : {}),
        },
        payload: {
          spaceId: session.spaceId,
          vaultId: session.vaultId,
          summary:
            request.body?.summary ??
            `workspace promotion from session ${session.id}`,
          changes,
        },
      });
      if (proposal.statusCode !== 201) {
        return reply.code(proposal.statusCode).send(proposal.json());
      }
      const created = proposal.json() as {
        reviewId: string;
        status: string;
        branchName: string;
        headCommit: string;
      };
      const promotionCandidates = changes.map((change) => {
        const metadata = parseKnowledgeDocumentMetadata(change.content);
        if (!metadata) {
          throw new Error("PROMOTION_VALIDATED_METADATA_MISSING");
        }
        const trustTier =
          typeof metadata.trust_tier === "string" ? metadata.trust_tier : null;
        return {
          path: change.path,
          kind: metadata.type,
          knowledgeLayer: metadata.knowledge_layer,
          lifecycle: metadata.status,
          trustTier,
        };
      });
      const targetKnowledgeLayers = [
        ...new Set(
          promotionCandidates.map((candidate) => candidate.knowledgeLayer),
        ),
      ].sort();
      const evidenceVersions = evidence.events.map((event) =>
        Number(event.session_version),
      );
      const promotionSemantics = {
        sourceScope: {
          sessionId: session.id,
          spaceId: session.spaceId,
          vaultId: session.vaultId,
          revisionSetHash: session.contextRevisionSetHash,
        },
        targetScope: {
          spaceId: session.spaceId,
          vaultId: session.vaultId,
          knowledgeLayers: targetKnowledgeLayers,
        },
        knowledgeCandidates: promotionCandidates,
        evidence: evidenceEventIds.map((eventId, index) => ({
          eventId,
          sessionVersion: evidenceVersions[index] ?? null,
        })),
        conflicts: {
          status: "NOT_EVALUATED" as const,
          items: [] as string[],
        },
        implications: {
          lifecycle: promotionCandidates.map((candidate) => ({
            path: candidate.path,
            requestedStatus: candidate.lifecycle,
            publicationRequired: true,
          })),
          trust: promotionCandidates.map((candidate) => ({
            path: candidate.path,
            requestedTier: candidate.trustTier,
            selfAttestationAllowed: false,
            authority: "GOVERNED_REVIEW",
          })),
        },
      };
      const promotionClient = await db.pool.connect();
      let promotionEvent: Record<string, unknown>;
      try {
        await promotionClient.query("begin");
        const lockedReview = await promotionClient.query(
          "select id from reviews where id=$1 and author_id=$2 and status='PENDING' for update",
          [created.reviewId, actor.id],
        );
        if (lockedReview.rowCount !== 1) {
          throw new Error("PROMOTION_REVIEW_NOT_PENDING");
        }
        if (decisionCandidate && decisionCapturedEventId) {
          await linkDecisionCandidateReviewInTransaction(promotionClient, {
            candidateId: decisionCandidate.id,
            sessionId: session.id,
            capturedEventId: decisionCapturedEventId,
            reviewId: created.reviewId,
          });
        }
        const insertedEvent = await appendWorkspaceEventInTransaction(
          promotionClient,
          {
            sessionId: session.id,
            actorId: actor.id,
            actorPrincipalId: actor.principalId,
            eventType: "PROMOTION_REQUESTED",
            payload: {
              reviewId: created.reviewId,
              evidenceEventIds,
              evidenceVersions,
              revisionSetHash: session.contextRevisionSetHash,
              requestedPaths: changes.map((change) => change.path),
              ...promotionSemantics,
            },
          },
        );
        const provenanceUpdate = await promotionClient.query(
          `update reviews
              set impact_manifest =
                impact_manifest || $2::jsonb,
                  updated_at=now()
            where id=$1 and author_id=$3 and status='PENDING'`,
          [
            created.reviewId,
            JSON.stringify({
              promotionRequest: {
                sessionId: session.id,
                promotionEventId: String(insertedEvent.id),
                evidenceEventIds,
                evidenceVersions,
                revisionSetHash: session.contextRevisionSetHash,
                ...promotionSemantics,
              },
              ...(decisionCandidate && decisionCapturedEventId
                ? {
                    decisionWorkflow: {
                      candidateId: decisionCandidate.id,
                      capturedEventId: decisionCapturedEventId,
                      decisionAuthorityPrincipalId:
                        decisionCandidate.decisionAuthorityPrincipalId,
                    },
                  }
                : {}),
            }),
            actor.id,
          ],
        );
        if (provenanceUpdate.rowCount !== 1) {
          throw new Error("PROMOTION_PROVENANCE_ATTACH_FAILED");
        }
        await promotionClient.query("commit");
        promotionEvent = insertedEvent;
      } catch {
        await promotionClient.query("rollback");
        await db.pool.query(
          `update reviews
              set status='REJECTED',
                  last_error='PROMOTION_PROVENANCE_ATTACH_FAILED',
                  updated_at=now()
            where id=$1 and status='PENDING'`,
          [created.reviewId],
        );
        return reply
          .code(409)
          .send({ code: "PROMOTION_PROVENANCE_ATTACH_FAILED" });
      } finally {
        promotionClient.release();
      }
      workspaceTelemetry.counter("akp.workspace.promotions_total", 1, {
        outcome: "PENDING_REVIEW",
      });
      await audit(
        db,
        request,
        "workspace.promotion.request",
        "review",
        created.reviewId,
        {
          vaultId: session.vaultId,
          sessionId: session.id,
          evidenceEventIds,
        },
        session.spaceId,
      );
      return reply.code(201).send({
        ...created,
        promotionEventId: String(promotionEvent.id),
        evidenceEventIds,
        revisionSetHash: session.contextRevisionSetHash,
        ...(decisionCandidate
          ? { decisionCandidateId: decisionCandidate.id }
          : {}),
      });
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      status?: string;
      outcome?: string | null;
      followUps?: string[];
      touchedResources?: string[];
    };
  }>(
    "/v1/sessions/:id/work-context",
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
      const status = request.body?.status?.trim().toUpperCase();
      const outcome =
        request.body?.outcome === null || request.body?.outcome === undefined
          ? null
          : boundedHandoffText(request.body.outcome, 12_000);
      const followUps = boundedHandoffList(request.body?.followUps, 50, 2_000);
      const touchedResources = boundedHandoffList(
        request.body?.touchedResources,
        100,
        1_000,
      );
      if (
        !status ||
        !WORK_CONTEXT_STATUSES.has(status) ||
        (request.body?.outcome !== null &&
          request.body?.outcome !== undefined &&
          !outcome) ||
        !followUps ||
        !touchedResources
      ) {
        return reply.code(400).send({ code: "INVALID_WORK_CONTEXT_UPDATE" });
      }
      const updated = await updateWorkspaceWorkContext(db, {
        sessionId: session.id,
        actorId: actor.id,
        actorPrincipalId: actor.principalId,
        status: status as "OPEN" | "BLOCKED" | "COMPLETED" | "ABANDONED",
        outcome,
        followUps,
        touchedResources,
      });
      await audit(
        db,
        request,
        "workspace.context.update",
        "agent_session",
        session.id,
        {
          vaultId: session.vaultId,
          workStatus: updated.workStatus,
        },
        session.spaceId,
      );
      return updated;
    },
  );

  app.post<{
    Params: { id: string };
    Body: { userId: string };
  }>(
    "/v1/sessions/:id/participants",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("workspace:manage-participants"),
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
      if (session.role !== "OWNER") {
        return reply
          .code(403)
          .send({ code: "WORKSPACE_SESSION_OWNER_REQUIRED" });
      }
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const userId = request.body?.userId?.trim();
      if (!userId) {
        return reply.code(400).send({ code: "PARTICIPANT_USER_REQUIRED" });
      }
      if (!(await userHasFullVaultRead(db, userId, session))) {
        return reply.code(422).send({ code: "PARTICIPANT_NOT_AUTHORIZED" });
      }
      const participant = await addWorkspaceParticipant(db, {
        sessionId: session.id,
        actorId: actor.id,
        userId,
      });
      await audit(
        db,
        request,
        "workspace.participant.add",
        "agent_session",
        session.id,
        { vaultId: session.vaultId, userId },
        session.spaceId,
      );
      return reply
        .code(participant.joined ? 201 : 200)
        .send({ sessionId: session.id, userId, ...participant });
    },
  );

  app.post<{
    Params: { id: string };
    Body: { workKey: string; leaseSeconds?: number };
  }>(
    "/v1/sessions/:id/claims",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("workspace:claim"),
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
      const workKey = request.body?.workKey?.trim();
      if (!workKey || !isWorkspaceWorkKey(workKey)) {
        return reply.code(400).send({ code: "INVALID_WORK_KEY" });
      }
      const leaseSeconds = boundedLeaseSeconds(request.body.leaseSeconds);
      if (!leaseSeconds) {
        return reply.code(400).send({ code: "INVALID_CLAIM_LEASE" });
      }
      const claim = await claimWorkspaceWork(db, {
        sessionId: session.id,
        actorId: actor.id,
        actorPrincipalId: actor.principalId,
        workKey,
        leaseSeconds,
      });
      await audit(
        db,
        request,
        "workspace.claim.acquire",
        "agent_session",
        session.id,
        {
          vaultId: session.vaultId,
          claimId: claim.id,
          workKey,
          fencingToken: claim.fencingToken,
        },
        session.spaceId,
      );
      return reply.code(201).send(claim);
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      workKey: string;
      fencingToken: number;
      leaseSeconds?: number;
    };
  }>(
    "/v1/sessions/:id/claims/heartbeat",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("workspace:claim"),
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
      const workKey = request.body?.workKey?.trim();
      if (!workKey || !isWorkspaceWorkKey(workKey)) {
        return reply.code(400).send({ code: "INVALID_WORK_KEY" });
      }
      const fencingToken = Number(request.body.fencingToken);
      if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
        return reply.code(400).send({ code: "INVALID_FENCING_TOKEN" });
      }
      const leaseSeconds = boundedLeaseSeconds(request.body.leaseSeconds);
      if (!leaseSeconds) {
        return reply.code(400).send({ code: "INVALID_CLAIM_LEASE" });
      }
      const claim = await heartbeatWorkspaceWork(db, {
        sessionId: session.id,
        actorId: actor.id,
        actorPrincipalId: actor.principalId,
        workKey,
        fencingToken,
        leaseSeconds,
      });
      await audit(
        db,
        request,
        "workspace.claim.heartbeat",
        "agent_session",
        session.id,
        {
          vaultId: session.vaultId,
          claimId: claim.id,
          workKey,
          fencingToken: claim.fencingToken,
        },
        session.spaceId,
      );
      return claim;
    },
  );

  app.post<{
    Params: { id: string };
    Body: { workKey: string; fencingToken: number };
  }>(
    "/v1/sessions/:id/claims/release",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("workspace:claim"),
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
      const workKey = request.body?.workKey?.trim();
      if (!workKey || !isWorkspaceWorkKey(workKey)) {
        return reply.code(400).send({ code: "INVALID_WORK_KEY" });
      }
      const fencingToken = Number(request.body.fencingToken);
      if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
        return reply.code(400).send({ code: "INVALID_FENCING_TOKEN" });
      }
      const claim = await releaseWorkspaceWork(db, {
        sessionId: session.id,
        actorId: actor.id,
        actorPrincipalId: actor.principalId,
        workKey,
        fencingToken,
      });
      await audit(
        db,
        request,
        "workspace.claim.release",
        "agent_session",
        session.id,
        {
          vaultId: session.vaultId,
          claimId: claim.id,
          workKey,
          fencingToken: claim.fencingToken,
        },
        session.spaceId,
      );
      return claim;
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      workKey: string;
      toUserId: string;
      toPrincipalId?: string;
      fencingToken: number;
      leaseSeconds?: number;
      summary?: string;
      completed?: string[];
      remaining?: string[];
      blockers?: string[];
      changedResourceRefs?: string[];
      evidenceRefs?: string[];
      questions?: string[];
      note?: string;
    };
  }>(
    "/v1/sessions/:id/claims/handoff",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("workspace:handoff"),
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
      const workKey = request.body?.workKey?.trim();
      const toUserId = request.body?.toUserId?.trim();
      const toPrincipalId = request.body?.toPrincipalId?.trim() || null;
      if (
        !workKey ||
        !isWorkspaceWorkKey(workKey) ||
        !toUserId ||
        (toPrincipalId && !PRINCIPAL_ID_PATTERN.test(toPrincipalId))
      ) {
        return reply.code(400).send({ code: "INVALID_WORK_HANDOFF" });
      }
      const fencingToken = Number(request.body.fencingToken);
      if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
        return reply.code(400).send({ code: "INVALID_FENCING_TOKEN" });
      }
      const leaseSeconds = boundedLeaseSeconds(request.body.leaseSeconds);
      if (!leaseSeconds) {
        return reply.code(400).send({ code: "INVALID_CLAIM_LEASE" });
      }
      const note = request.body.note?.trim();
      if (note && Buffer.byteLength(note, "utf8") > 2048) {
        return reply.code(413).send({ code: "HANDOFF_NOTE_TOO_LARGE" });
      }
      const structuredRequested = [
        request.body.summary,
        request.body.completed,
        request.body.remaining,
        request.body.blockers,
        request.body.changedResourceRefs,
        request.body.evidenceRefs,
        request.body.questions,
      ].some((value) => value !== undefined);
      const summary = structuredRequested
        ? boundedHandoffText(request.body.summary, 4_096)
        : null;
      const completed = boundedHandoffList(request.body.completed, 50, 2_000);
      const remaining = boundedHandoffList(request.body.remaining, 50, 2_000);
      const blockers = boundedHandoffList(request.body.blockers, 50, 2_000);
      const changedResourceRefs = boundedHandoffList(
        request.body.changedResourceRefs,
        100,
        1_000,
      );
      const evidenceRefs = boundedHandoffList(
        request.body.evidenceRefs,
        100,
        1_000,
      );
      const questions = boundedHandoffList(request.body.questions, 50, 2_000);
      const handoff =
        structuredRequested &&
        summary &&
        completed &&
        remaining &&
        blockers &&
        changedResourceRefs &&
        evidenceRefs &&
        questions
          ? {
              summary,
              completed,
              remaining,
              blockers,
              changedResourceRefs,
              evidenceRefs,
              questions,
            }
          : null;
      if (
        structuredRequested &&
        (!handoff ||
          Buffer.byteLength(JSON.stringify(handoff), "utf8") > 16 * 1024)
      ) {
        return reply.code(400).send({ code: "INVALID_STRUCTURED_HANDOFF" });
      }
      if (!(await userHasFullVaultRead(db, toUserId, session))) {
        return reply.code(422).send({ code: "PARTICIPANT_NOT_AUTHORIZED" });
      }
      const claim = await handoffWorkspaceWork(db, {
        sessionId: session.id,
        actorId: actor.id,
        workKey,
        toUserId,
        ...(toPrincipalId ? { toPrincipalId } : {}),
        fencingToken,
        leaseSeconds,
        actorPrincipalId: actor.principalId,
        ...(handoff ? { handoff } : {}),
        ...(note ? { note } : {}),
      });
      await audit(
        db,
        request,
        "workspace.claim.handoff",
        "agent_session",
        session.id,
        {
          vaultId: session.vaultId,
          claimId: claim.id,
          workKey,
          toUserId,
          fencingToken: claim.fencingToken,
        },
        session.spaceId,
      );
      return claim;
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      label?: string;
      durationMinutes?: number;
      allowedActions?: string[];
    };
  }>(
    "/v1/sessions/:id/agent-processes",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("workspace:manage-agents"),
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
      if (actor.principalKind !== "HUMAN") {
        return reply.code(403).send({ code: "AGENT_PROCESS_ISSUER_DENIED" });
      }
      const label = request.body?.label?.trim() || "Workspace agent";
      if (label.length > 200) {
        return reply.code(400).send({ code: "INVALID_AGENT_LABEL" });
      }
      const requestedActions = request.body?.allowedActions ?? [
        ...DEFAULT_AGENT_PROCESS_ACTIONS,
      ];
      if (
        !requestedActions.length ||
        requestedActions.some(
          (action) =>
            typeof action !== "string" ||
            !(AGENT_PROCESS_ALLOWED_ACTIONS as readonly string[]).includes(
              action,
            ),
        )
      ) {
        return reply.code(400).send({ code: "INVALID_AGENT_ALLOWED_ACTIONS" });
      }
      const allowedActions = [...new Set(requestedActions)] as Array<
        (typeof AGENT_PROCESS_ALLOWED_ACTIONS)[number]
      >;
      const durationMinutes = Math.max(
        5,
        Math.min(Number(request.body?.durationMinutes ?? 60), 720),
      );
      if (!Number.isFinite(durationMinutes)) {
        return reply.code(400).send({ code: "INVALID_AGENT_DURATION" });
      }
      const effectiveScopes = serializeEffectiveScopes(actor);
      const scopes = {
        spaces: effectiveScopes.spaces
          .map((scope) => ({
            ...scope,
            permissions: scope.permissions.filter((permission) =>
              ["knowledge:read", "knowledge:propose"].includes(permission),
            ),
          }))
          .filter((scope) => scope.permissions.length > 0),
      };
      const token = randomBytes(32).toString("base64url");
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const principal = await createAgentProcessPrincipalCredential(db, {
        parentPrincipalId: actor.principalId,
        userId: actor.id,
        sessionId: session.id,
        displayName: label,
        allowedActions,
        tokenHash,
        scopes,
        expiresAt: new Date(Date.now() + durationMinutes * 60_000),
      });
      await audit(
        db,
        request,
        "agent_process.create",
        "principal",
        principal.id,
        { vaultId: session.vaultId, sessionId: session.id },
        session.spaceId,
      );
      return reply.code(201).send({
        principal,
        token,
        authenticationKind: "PRINCIPAL_TOKEN",
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/agent-processes/:id/revoke",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("workspace:manage-agents"),
      ],
    },
    async (request, reply) => {
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      if (actor.principalKind !== "HUMAN") {
        return reply.code(403).send({ code: "AGENT_PROCESS_ISSUER_DENIED" });
      }
      const principal = await revokeAgentProcessPrincipal(db, {
        principalId: request.params.id,
        parentPrincipalId: actor.principalId,
      });
      await audit(
        db,
        request,
        "agent_process.revoke",
        "principal",
        principal.id,
      );
      return { principal };
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      eventType: string;
      claimId?: string;
      fencingToken?: number;
      payload?: Record<string, unknown>;
    };
  }>(
    "/v1/sessions/:id/events",
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
      const eventType = request.body?.eventType?.trim().toUpperCase();
      if (!eventType || !USER_EVENT_TYPES.has(eventType)) {
        return reply.code(400).send({ code: "INVALID_WORKSPACE_EVENT_TYPE" });
      }
      const payload = boundedEventPayload(request.body?.payload ?? {});
      if (!payload) {
        return reply
          .code(413)
          .send({ code: "WORKSPACE_EVENT_PAYLOAD_INVALID" });
      }
      const claimId = request.body?.claimId?.trim() || null;
      const fencingToken =
        request.body?.fencingToken === undefined
          ? null
          : Number(request.body.fencingToken);
      if (
        (claimId && fencingToken === null) ||
        (!claimId && fencingToken !== null) ||
        (claimId && !PRINCIPAL_ID_PATTERN.test(claimId)) ||
        (fencingToken !== null &&
          (!Number.isSafeInteger(fencingToken) || fencingToken < 1))
      ) {
        return reply.code(400).send({ code: "INVALID_WORKSPACE_EVENT_CLAIM" });
      }
      const event = await appendWorkspaceEvent(db, {
        sessionId: session.id,
        actorId: actor.id,
        actorPrincipalId: actor.principalId,
        ...(claimId ? { claimId, fencingToken } : {}),
        eventType: eventType as
          | "FINDING"
          | "BLOCKER"
          | "QUESTION"
          | "ARTIFACT"
          | "DECISION_CANDIDATE"
          | "NOTE",
        payload,
      });
      await audit(
        db,
        request,
        "workspace.event.append",
        "agent_session",
        session.id,
        {
          vaultId: session.vaultId,
          eventId: event.id,
          eventType,
          ...(claimId ? { claimId, fencingToken } : {}),
        },
        session.spaceId,
      );
      return reply.code(201).send(event);
    },
  );
}
