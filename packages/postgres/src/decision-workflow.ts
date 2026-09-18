import type { Postgres, PostgresPoolClient } from "./index.js";
import type { SqlExecutor } from "./outbox.js";
import { assertWorkspaceContextRevisionCurrent } from "./context-revision-set.js";
import { appendWorkspaceEventInTransaction } from "./workspace-coordination.js";

export type DecisionCandidateStatus =
  | "DRAFT"
  | "CONSULTATION"
  | "READY_FOR_REVIEW"
  | "PENDING_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "SUPERSEDED"
  | "WITHDRAWN";

export type DecisionAlternativeStatus =
  | "SUGGESTED"
  | "CONSIDERED"
  | "REJECTED";

export interface DecisionCandidateRecord {
  id: string;
  sessionId: string;
  spaceId: string;
  vaultId: string;
  createdByPrincipalId: string;
  decisionAuthorityPrincipalId: string;
  title: string;
  problem: string;
  context: string;
  drivers: string[];
  qualityAttributes: string[];
  affectedRefs: string[];
  evidenceRefs: string[];
  consequences: string | null;
  followUpActions: string[];
  verificationPlan: string;
  verificationDueAt: Date | null;
  decisionDeadline: Date | null;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: DecisionCandidateStatus;
  selectedAlternativeId: string | null;
  capturedEventId: string | null;
  reviewId: string | null;
  reviewStatus: string | null;
  supersedesCandidateId: string | null;
  supersededByCandidateId: string | null;
  publishedRevision: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  approvedAt: Date | null;
  supersededAt: Date | null;
}

export interface DecisionAlternativeRecord {
  id: string;
  candidateId: string;
  authorPrincipalId: string;
  origin: "HUMAN_SUBMITTED" | "AGENT_SUGGESTED";
  title: string;
  description: string;
  tradeoffs: string;
  evidenceRefs: string[];
  status: DecisionAlternativeStatus;
  decidedByPrincipalId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

export interface DecisionObjectionRecord {
  id: string;
  candidateId: string;
  alternativeId: string | null;
  authorPrincipalId: string;
  statement: string;
  evidenceRefs: string[];
  status: "OPEN" | "RESOLVED" | "WITHDRAWN";
  resolution: string | null;
  resolvedByPrincipalId: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

export interface DecisionConsultationRecord {
  id: string;
  candidateId: string;
  requestedByPrincipalId: string;
  reviewerPrincipalId: string;
  question: string;
  status: "REQUESTED" | "RESPONDED" | "DECLINED";
  position: "SUPPORT" | "OPPOSE" | "NEUTRAL" | null;
  response: string | null;
  requestedAt: Date;
  respondedAt: Date | null;
}

export interface DecisionCandidateSnapshot {
  candidate: DecisionCandidateRecord;
  alternatives: DecisionAlternativeRecord[];
  objections: DecisionObjectionRecord[];
  consultations: DecisionConsultationRecord[];
}

function decisionError(code: string, statusCode: number): Error {
  const error = new Error(code) as Error & {
    code?: string;
    statusCode?: number;
  };
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function candidateRecord(row: Record<string, unknown>): DecisionCandidateRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    spaceId: String(row.space_id),
    vaultId: String(row.vault_id),
    createdByPrincipalId: String(row.created_by_principal_id),
    decisionAuthorityPrincipalId: String(row.decision_authority_principal_id),
    title: String(row.title),
    problem: String(row.problem),
    context: String(row.context),
    drivers: stringArray(row.drivers),
    qualityAttributes: stringArray(row.quality_attributes),
    affectedRefs: stringArray(row.affected_refs),
    evidenceRefs: stringArray(row.evidence_refs),
    consequences: row.consequences ? String(row.consequences) : null,
    followUpActions: stringArray(row.follow_up_actions),
    verificationPlan: String(row.verification_plan),
    verificationDueAt: row.verification_due_at
      ? new Date(String(row.verification_due_at))
      : null,
    decisionDeadline: row.decision_deadline
      ? new Date(String(row.decision_deadline))
      : null,
    effectiveFrom: row.effective_from
      ? new Date(String(row.effective_from))
      : null,
    effectiveUntil: row.effective_until
      ? new Date(String(row.effective_until))
      : null,
    status: String(row.status) as DecisionCandidateStatus,
    selectedAlternativeId: row.selected_alternative_id
      ? String(row.selected_alternative_id)
      : null,
    capturedEventId:
      row.captured_event_id === null || row.captured_event_id === undefined
        ? null
        : String(row.captured_event_id),
    reviewId: row.review_id ? String(row.review_id) : null,
    reviewStatus: row.review_status ? String(row.review_status) : null,
    supersedesCandidateId: row.supersedes_candidate_id
      ? String(row.supersedes_candidate_id)
      : null,
    supersededByCandidateId: row.superseded_by_candidate_id
      ? String(row.superseded_by_candidate_id)
      : null,
    publishedRevision: row.published_revision
      ? String(row.published_revision)
      : null,
    version: Number(row.version),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    approvedAt: row.approved_at ? new Date(String(row.approved_at)) : null,
    supersededAt: row.superseded_at
      ? new Date(String(row.superseded_at))
      : null,
  };
}

function alternativeRecord(
  row: Record<string, unknown>,
): DecisionAlternativeRecord {
  return {
    id: String(row.id),
    candidateId: String(row.candidate_id),
    authorPrincipalId: String(row.author_principal_id),
    origin: String(row.origin) as DecisionAlternativeRecord["origin"],
    title: String(row.title),
    description: String(row.description),
    tradeoffs: String(row.tradeoffs),
    evidenceRefs: stringArray(row.evidence_refs),
    status: String(row.status) as DecisionAlternativeStatus,
    decidedByPrincipalId: row.decided_by_principal_id
      ? String(row.decided_by_principal_id)
      : null,
    decidedAt: row.decided_at ? new Date(String(row.decided_at)) : null,
    createdAt: new Date(String(row.created_at)),
  };
}

function objectionRecord(
  row: Record<string, unknown>,
): DecisionObjectionRecord {
  return {
    id: String(row.id),
    candidateId: String(row.candidate_id),
    alternativeId: row.alternative_id ? String(row.alternative_id) : null,
    authorPrincipalId: String(row.author_principal_id),
    statement: String(row.statement),
    evidenceRefs: stringArray(row.evidence_refs),
    status: String(row.status) as DecisionObjectionRecord["status"],
    resolution: row.resolution ? String(row.resolution) : null,
    resolvedByPrincipalId: row.resolved_by_principal_id
      ? String(row.resolved_by_principal_id)
      : null,
    resolvedAt: row.resolved_at ? new Date(String(row.resolved_at)) : null,
    createdAt: new Date(String(row.created_at)),
  };
}

function consultationRecord(
  row: Record<string, unknown>,
): DecisionConsultationRecord {
  return {
    id: String(row.id),
    candidateId: String(row.candidate_id),
    requestedByPrincipalId: String(row.requested_by_principal_id),
    reviewerPrincipalId: String(row.reviewer_principal_id),
    question: String(row.question),
    status: String(row.status) as DecisionConsultationRecord["status"],
    position: row.position
      ? (String(row.position) as DecisionConsultationRecord["position"])
      : null,
    response: row.response ? String(row.response) : null,
    requestedAt: new Date(String(row.requested_at)),
    respondedAt: row.responded_at
      ? new Date(String(row.responded_at))
      : null,
  };
}

async function requireDecisionScope(
  client: PostgresPoolClient,
  input: {
    sessionId: string;
    actorUserId: string;
    actorPrincipalId: string;
    requireCurrentRevision: boolean;
  },
): Promise<{ spaceId: string; vaultId: string; principalKind: string }> {
  const result = await client.query<{
    space_id: string;
    vault_id: string;
    principal_kind: string;
  }>(
    `select s.space_id,s.vault_id,principal.kind principal_kind
       from agent_sessions s
       join workspace_session_participants participant
         on participant.session_id=s.id
        and participant.user_id=$2
        and participant.left_at is null
       join principals principal
         on principal.id=$3
        and principal.user_id=$2
        and principal.state='ACTIVE'
      where s.id=$1
        and (
          principal.kind<>'AGENT_PROCESS'
          or (principal.session_id=s.id and principal.vault_id=s.vault_id)
        )`,
    [input.sessionId, input.actorUserId, input.actorPrincipalId],
  );
  const row = result.rows[0];
  if (!row) throw decisionError("DECISION_SESSION_NOT_FOUND", 404);
  if (input.requireCurrentRevision) {
    await assertWorkspaceContextRevisionCurrent(
      client,
      input.sessionId,
      row.space_id,
      row.vault_id,
    );
  }
  return {
    spaceId: row.space_id,
    vaultId: row.vault_id,
    principalKind: row.principal_kind,
  };
}

async function requireHumanParticipantPrincipal(
  client: PostgresPoolClient,
  sessionId: string,
  principalId: string,
): Promise<void> {
  const result = await client.query(
    `select 1
       from principals principal
       join workspace_session_participants participant
         on participant.user_id=principal.user_id
        and participant.session_id=$1
        and participant.left_at is null
      where principal.id=$2
        and principal.kind='HUMAN'
        and principal.state='ACTIVE'`,
    [sessionId, principalId],
  );
  if (!result.rowCount) {
    throw decisionError("DECISION_HUMAN_PARTICIPANT_REQUIRED", 422);
  }
}

async function lockedCandidate(
  client: PostgresPoolClient,
  input: {
    sessionId: string;
    candidateId: string;
    actorUserId: string;
    actorPrincipalId: string;
  },
): Promise<{ scope: { spaceId: string; vaultId: string }; row: Record<string, unknown> }> {
  const scope = await requireDecisionScope(client, {
    sessionId: input.sessionId,
    actorUserId: input.actorUserId,
    actorPrincipalId: input.actorPrincipalId,
    requireCurrentRevision: true,
  });
  const result = await client.query<Record<string, unknown>>(
    `select candidate.*,review.status review_status
       from workspace_decision_candidates candidate
       left join reviews review on review.id=candidate.review_id
      where candidate.id=$1
        and candidate.session_id=$2
        and candidate.space_id=$3
        and candidate.vault_id=$4
      for update of candidate`,
    [input.candidateId, input.sessionId, scope.spaceId, scope.vaultId],
  );
  const row = result.rows[0];
  if (!row) throw decisionError("DECISION_CANDIDATE_NOT_FOUND", 404);
  return { scope, row };
}

async function snapshotInTransaction(
  client: PostgresPoolClient,
  candidate: DecisionCandidateRecord,
): Promise<DecisionCandidateSnapshot> {
  const [alternatives, objections, consultations] = await Promise.all([
    client.query<Record<string, unknown>>(
      `select * from workspace_decision_alternatives
        where candidate_id=$1 order by created_at,id`,
      [candidate.id],
    ),
    client.query<Record<string, unknown>>(
      `select * from workspace_decision_objections
        where candidate_id=$1 order by created_at,id`,
      [candidate.id],
    ),
    client.query<Record<string, unknown>>(
      `select * from workspace_decision_consultations
        where candidate_id=$1 order by requested_at,id`,
      [candidate.id],
    ),
  ]);
  return {
    candidate,
    alternatives: alternatives.rows.map(alternativeRecord),
    objections: objections.rows.map(objectionRecord),
    consultations: consultations.rows.map(consultationRecord),
  };
}

export async function createDecisionCandidate(
  db: Postgres,
  input: {
    sessionId: string;
    actorUserId: string;
    actorPrincipalId: string;
    decisionAuthorityPrincipalId: string;
    title: string;
    problem: string;
    context: string;
    drivers: string[];
    qualityAttributes: string[];
    affectedRefs: string[];
    evidenceRefs: string[];
    verificationPlan: string;
    verificationDueAt?: Date | null;
    decisionDeadline?: Date | null;
    supersedesCandidateId?: string | null;
  },
): Promise<DecisionCandidateRecord> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const scope = await requireDecisionScope(client, {
      sessionId: input.sessionId,
      actorUserId: input.actorUserId,
      actorPrincipalId: input.actorPrincipalId,
      requireCurrentRevision: true,
    });
    await requireHumanParticipantPrincipal(
      client,
      input.sessionId,
      input.decisionAuthorityPrincipalId,
    );
    if (input.supersedesCandidateId) {
      const predecessor = await client.query(
        `select 1 from workspace_decision_candidates
          where id=$1 and vault_id=$2 and status='APPROVED'`,
        [input.supersedesCandidateId, scope.vaultId],
      );
      if (!predecessor.rowCount) {
        throw decisionError("DECISION_SUPERSEDED_CANDIDATE_NOT_APPROVED", 409);
      }
    }
    const inserted = await client.query<Record<string, unknown>>(
      `insert into workspace_decision_candidates(
         session_id,space_id,vault_id,created_by_principal_id,
         decision_authority_principal_id,title,problem,context,drivers,
         quality_attributes,affected_refs,evidence_refs,verification_plan,
         verification_due_at,decision_deadline,supersedes_candidate_id
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15,$16)
       returning *,null::text review_status`,
      [
        input.sessionId,
        scope.spaceId,
        scope.vaultId,
        input.actorPrincipalId,
        input.decisionAuthorityPrincipalId,
        input.title,
        input.problem,
        input.context,
        JSON.stringify(input.drivers),
        JSON.stringify(input.qualityAttributes),
        JSON.stringify(input.affectedRefs),
        JSON.stringify(input.evidenceRefs),
        input.verificationPlan,
        input.verificationDueAt ?? null,
        input.decisionDeadline ?? null,
        input.supersedesCandidateId ?? null,
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw decisionError("DECISION_CANDIDATE_WRITE_FAILED", 500);
    await client.query("commit");
    return candidateRecord(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function listDecisionCandidates(
  db: Postgres,
  input: {
    sessionId: string;
    actorUserId: string;
    actorPrincipalId: string;
  },
): Promise<DecisionCandidateRecord[]> {
  const client = await db.pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    const scope = await requireDecisionScope(client, {
      ...input,
      requireCurrentRevision: false,
    });
    const result = await client.query<Record<string, unknown>>(
      `select candidate.*,review.status review_status
         from workspace_decision_candidates candidate
         left join reviews review on review.id=candidate.review_id
        where candidate.session_id=$1
          and candidate.space_id=$2
          and candidate.vault_id=$3
        order by candidate.created_at,candidate.id`,
      [input.sessionId, scope.spaceId, scope.vaultId],
    );
    await client.query("commit");
    return result.rows.map(candidateRecord);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function getDecisionCandidateSnapshot(
  db: Postgres,
  input: {
    sessionId: string;
    candidateId: string;
    actorUserId: string;
    actorPrincipalId: string;
  },
): Promise<DecisionCandidateSnapshot> {
  const client = await db.pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    const scope = await requireDecisionScope(client, {
      sessionId: input.sessionId,
      actorUserId: input.actorUserId,
      actorPrincipalId: input.actorPrincipalId,
      requireCurrentRevision: false,
    });
    const result = await client.query<Record<string, unknown>>(
      `select candidate.*,review.status review_status
         from workspace_decision_candidates candidate
         left join reviews review on review.id=candidate.review_id
        where candidate.id=$1 and candidate.session_id=$2
          and candidate.space_id=$3 and candidate.vault_id=$4`,
      [input.candidateId, input.sessionId, scope.spaceId, scope.vaultId],
    );
    const row = result.rows[0];
    if (!row) throw decisionError("DECISION_CANDIDATE_NOT_FOUND", 404);
    const snapshot = await snapshotInTransaction(client, candidateRecord(row));
    await client.query("commit");
    return snapshot;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function addDecisionAlternative(
  db: Postgres,
  input: {
    sessionId: string;
    candidateId: string;
    actorUserId: string;
    actorPrincipalId: string;
    actorPrincipalKind: string;
    title: string;
    description: string;
    tradeoffs: string;
    evidenceRefs: string[];
  },
): Promise<DecisionAlternativeRecord> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const locked = await lockedCandidate(client, input);
    const status = String(locked.row.status);
    if (!["DRAFT", "CONSULTATION"].includes(status)) {
      throw decisionError("DECISION_CANDIDATE_NOT_EDITABLE", 409);
    }
    const origin =
      input.actorPrincipalKind === "HUMAN"
        ? "HUMAN_SUBMITTED"
        : "AGENT_SUGGESTED";
    const alternativeStatus =
      origin === "HUMAN_SUBMITTED" ? "CONSIDERED" : "SUGGESTED";
    const inserted = await client.query<Record<string, unknown>>(
      `insert into workspace_decision_alternatives(
         candidate_id,author_principal_id,origin,title,description,tradeoffs,
         evidence_refs,status
       ) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
       returning *`,
      [
        input.candidateId,
        input.actorPrincipalId,
        origin,
        input.title,
        input.description,
        input.tradeoffs,
        JSON.stringify(input.evidenceRefs),
        alternativeStatus,
      ],
    );
    await client.query(
      `update workspace_decision_candidates
          set status='CONSULTATION',version=version+1,updated_at=now()
        where id=$1 and status='DRAFT'`,
      [input.candidateId],
    );
    await client.query("commit");
    const row = inserted.rows[0];
    if (!row) throw decisionError("DECISION_ALTERNATIVE_WRITE_FAILED", 500);
    return alternativeRecord(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function decideDecisionAlternative(
  db: Postgres,
  input: {
    sessionId: string;
    candidateId: string;
    alternativeId: string;
    actorUserId: string;
    actorPrincipalId: string;
    decision: "CONSIDER" | "REJECT";
  },
): Promise<DecisionAlternativeRecord> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const locked = await lockedCandidate(client, input);
    if (String(locked.row.decision_authority_principal_id) !== input.actorPrincipalId) {
      throw decisionError("DECISION_AUTHORITY_REQUIRED", 403);
    }
    if (!["DRAFT", "CONSULTATION"].includes(String(locked.row.status))) {
      throw decisionError("DECISION_CANDIDATE_NOT_EDITABLE", 409);
    }
    const updated = await client.query<Record<string, unknown>>(
      `update workspace_decision_alternatives
          set status=$3,decided_by_principal_id=$4,decided_at=now()
        where id=$1 and candidate_id=$2
          and status in ('SUGGESTED','CONSIDERED')
        returning *`,
      [
        input.alternativeId,
        input.candidateId,
        input.decision === "CONSIDER" ? "CONSIDERED" : "REJECTED",
        input.actorPrincipalId,
      ],
    );
    const row = updated.rows[0];
    if (!row) throw decisionError("DECISION_ALTERNATIVE_NOT_FOUND", 404);
    await client.query(
      `update workspace_decision_candidates
          set version=version+1,updated_at=now() where id=$1`,
      [input.candidateId],
    );
    await client.query("commit");
    return alternativeRecord(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function addDecisionObjection(
  db: Postgres,
  input: {
    sessionId: string;
    candidateId: string;
    alternativeId?: string | null;
    actorUserId: string;
    actorPrincipalId: string;
    statement: string;
    evidenceRefs: string[];
  },
): Promise<DecisionObjectionRecord> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const locked = await lockedCandidate(client, input);
    if (!["DRAFT", "CONSULTATION"].includes(String(locked.row.status))) {
      throw decisionError("DECISION_CANDIDATE_NOT_EDITABLE", 409);
    }
    if (input.alternativeId) {
      const alternative = await client.query(
        `select 1 from workspace_decision_alternatives
          where id=$1 and candidate_id=$2`,
        [input.alternativeId, input.candidateId],
      );
      if (!alternative.rowCount) {
        throw decisionError("DECISION_ALTERNATIVE_NOT_FOUND", 404);
      }
    }
    const inserted = await client.query<Record<string, unknown>>(
      `insert into workspace_decision_objections(
         candidate_id,alternative_id,author_principal_id,statement,evidence_refs
       ) values($1,$2,$3,$4,$5::jsonb)
       returning *`,
      [
        input.candidateId,
        input.alternativeId ?? null,
        input.actorPrincipalId,
        input.statement,
        JSON.stringify(input.evidenceRefs),
      ],
    );
    await client.query(
      `update workspace_decision_candidates
          set status='CONSULTATION',version=version+1,updated_at=now()
        where id=$1 and status in ('DRAFT','CONSULTATION')`,
      [input.candidateId],
    );
    await client.query("commit");
    const row = inserted.rows[0];
    if (!row) throw decisionError("DECISION_OBJECTION_WRITE_FAILED", 500);
    return objectionRecord(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveDecisionObjection(
  db: Postgres,
  input: {
    sessionId: string;
    candidateId: string;
    objectionId: string;
    actorUserId: string;
    actorPrincipalId: string;
    resolution: string;
  },
): Promise<DecisionObjectionRecord> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const locked = await lockedCandidate(client, input);
    if (String(locked.row.decision_authority_principal_id) !== input.actorPrincipalId) {
      throw decisionError("DECISION_AUTHORITY_REQUIRED", 403);
    }
    if (!["DRAFT", "CONSULTATION"].includes(String(locked.row.status))) {
      throw decisionError("DECISION_CANDIDATE_NOT_EDITABLE", 409);
    }
    const updated = await client.query<Record<string, unknown>>(
      `update workspace_decision_objections
          set status='RESOLVED',resolution=$3,
              resolved_by_principal_id=$4,resolved_at=now()
        where id=$1 and candidate_id=$2 and status='OPEN'
        returning *`,
      [
        input.objectionId,
        input.candidateId,
        input.resolution,
        input.actorPrincipalId,
      ],
    );
    const row = updated.rows[0];
    if (!row) throw decisionError("DECISION_OBJECTION_NOT_FOUND", 404);
    await client.query(
      `update workspace_decision_candidates
          set version=version+1,updated_at=now() where id=$1`,
      [input.candidateId],
    );
    await client.query("commit");
    return objectionRecord(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function requestDecisionConsultation(
  db: Postgres,
  input: {
    sessionId: string;
    candidateId: string;
    actorUserId: string;
    actorPrincipalId: string;
    reviewerPrincipalId: string;
    question: string;
  },
): Promise<DecisionConsultationRecord> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const locked = await lockedCandidate(client, input);
    if (!["DRAFT", "CONSULTATION"].includes(String(locked.row.status))) {
      throw decisionError("DECISION_CANDIDATE_NOT_EDITABLE", 409);
    }
    await requireHumanParticipantPrincipal(
      client,
      input.sessionId,
      input.reviewerPrincipalId,
    );
    if (
      input.reviewerPrincipalId === input.actorPrincipalId ||
      input.reviewerPrincipalId ===
        String(locked.row.decision_authority_principal_id)
    ) {
      throw decisionError("DECISION_INDEPENDENT_CONSULTANT_REQUIRED", 422);
    }
    const inserted = await client.query<Record<string, unknown>>(
      `insert into workspace_decision_consultations(
         candidate_id,requested_by_principal_id,reviewer_principal_id,question
       ) values($1,$2,$3,$4)
       returning *`,
      [
        input.candidateId,
        input.actorPrincipalId,
        input.reviewerPrincipalId,
        input.question,
      ],
    );
    await client.query(
      `update workspace_decision_candidates
          set status='CONSULTATION',version=version+1,updated_at=now()
        where id=$1 and status in ('DRAFT','CONSULTATION')`,
      [input.candidateId],
    );
    await client.query("commit");
    const row = inserted.rows[0];
    if (!row) throw decisionError("DECISION_CONSULTATION_WRITE_FAILED", 500);
    return consultationRecord(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function respondDecisionConsultation(
  db: Postgres,
  input: {
    sessionId: string;
    candidateId: string;
    consultationId: string;
    actorUserId: string;
    actorPrincipalId: string;
    position: "SUPPORT" | "OPPOSE" | "NEUTRAL";
    response: string;
  },
): Promise<DecisionConsultationRecord> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const locked = await lockedCandidate(client, input);
    if (!["DRAFT", "CONSULTATION"].includes(String(locked.row.status))) {
      throw decisionError("DECISION_CANDIDATE_NOT_EDITABLE", 409);
    }
    const updated = await client.query<Record<string, unknown>>(
      `update workspace_decision_consultations
          set status='RESPONDED',position=$4,response=$5,responded_at=now()
        where id=$1 and candidate_id=$2 and reviewer_principal_id=$3
          and status='REQUESTED'
        returning *`,
      [
        input.consultationId,
        input.candidateId,
        input.actorPrincipalId,
        input.position,
        input.response,
      ],
    );
    const row = updated.rows[0];
    if (!row) throw decisionError("DECISION_CONSULTATION_NOT_FOUND", 404);
    await client.query(
      `update workspace_decision_candidates
          set version=version+1,updated_at=now() where id=$1`,
      [input.candidateId],
    );
    await client.query("commit");
    return consultationRecord(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function selectDecisionAlternative(
  db: Postgres,
  input: {
    sessionId: string;
    candidateId: string;
    alternativeId: string;
    actorUserId: string;
    actorPrincipalId: string;
    consequences: string;
    followUpActions: string[];
    effectiveFrom?: Date | null;
    effectiveUntil?: Date | null;
  },
): Promise<DecisionCandidateRecord> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const locked = await lockedCandidate(client, input);
    if (String(locked.row.decision_authority_principal_id) !== input.actorPrincipalId) {
      throw decisionError("DECISION_AUTHORITY_REQUIRED", 403);
    }
    if (!["DRAFT", "CONSULTATION"].includes(String(locked.row.status))) {
      throw decisionError("DECISION_CANDIDATE_NOT_EDITABLE", 409);
    }
    const alternative = await client.query(
      `select 1 from workspace_decision_alternatives
        where id=$1 and candidate_id=$2 and status='CONSIDERED'`,
      [input.alternativeId, input.candidateId],
    );
    if (!alternative.rowCount) {
      throw decisionError("DECISION_ALTERNATIVE_NOT_CONSIDERED", 409);
    }
    const considered = await client.query<{ count: number }>(
      `select count(*)::int count from workspace_decision_alternatives
        where candidate_id=$1 and status='CONSIDERED'`,
      [input.candidateId],
    );
    if ((considered.rows[0]?.count ?? 0) < 2) {
      throw decisionError("DECISION_ALTERNATIVES_INSUFFICIENT", 409);
    }
    const consultations = await client.query<{ count: number }>(
      `select count(*)::int count from workspace_decision_consultations
        where candidate_id=$1 and status='RESPONDED'`,
      [input.candidateId],
    );
    if ((consultations.rows[0]?.count ?? 0) < 1) {
      throw decisionError("DECISION_CONSULTATION_REQUIRED", 409);
    }
    const objections = await client.query<{ count: number }>(
      `select count(*)::int count from workspace_decision_objections
        where candidate_id=$1 and status='OPEN'`,
      [input.candidateId],
    );
    if ((objections.rows[0]?.count ?? 0) > 0) {
      throw decisionError("DECISION_OPEN_OBJECTIONS", 409);
    }
    const updated = await client.query<Record<string, unknown>>(
      `update workspace_decision_candidates
          set selected_alternative_id=$2,consequences=$3,
              follow_up_actions=$4::jsonb,effective_from=$5,effective_until=$6,
              status='READY_FOR_REVIEW',version=version+1,updated_at=now()
        where id=$1
        returning *,null::text review_status`,
      [
        input.candidateId,
        input.alternativeId,
        input.consequences,
        JSON.stringify(input.followUpActions),
        input.effectiveFrom ?? null,
        input.effectiveUntil ?? null,
      ],
    );
    const row = updated.rows[0];
    if (!row) throw decisionError("DECISION_CANDIDATE_WRITE_FAILED", 500);
    await client.query("commit");
    return candidateRecord(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function captureDecisionCandidate(
  db: Postgres,
  input: {
    sessionId: string;
    candidateId: string;
    actorUserId: string;
    actorPrincipalId: string;
  },
): Promise<{ candidate: DecisionCandidateRecord; event: Record<string, unknown> }> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const locked = await lockedCandidate(client, input);
    if (String(locked.row.status) !== "READY_FOR_REVIEW") {
      throw decisionError("DECISION_NOT_READY_FOR_REVIEW", 409);
    }
    if (locked.row.captured_event_id) {
      const existing = await client.query<Record<string, unknown>>(
        "select * from workspace_events where id=$1",
        [locked.row.captured_event_id],
      );
      const event = existing.rows[0];
      if (!event) throw decisionError("DECISION_CAPTURE_EVENT_MISSING", 500);
      await client.query("commit");
      return { candidate: candidateRecord(locked.row), event };
    }
    const snapshot = await snapshotInTransaction(
      client,
      candidateRecord(locked.row),
    );
    const selected = snapshot.alternatives.find(
      (alternative) =>
        alternative.id === snapshot.candidate.selectedAlternativeId,
    );
    if (!selected) throw decisionError("DECISION_SELECTED_ALTERNATIVE_MISSING", 500);
    const event = await appendWorkspaceEventInTransaction(client, {
      sessionId: input.sessionId,
      actorId: input.actorUserId,
      eventType: "DECISION_CANDIDATE",
      payload: {
        decisionWorkflowCandidateId: snapshot.candidate.id,
        workflowVersion: 1,
        title: snapshot.candidate.title,
        problem: snapshot.candidate.problem,
        context: snapshot.candidate.context,
        drivers: snapshot.candidate.drivers,
        qualityAttributes: snapshot.candidate.qualityAttributes,
        decisionAuthorityPrincipalId:
          snapshot.candidate.decisionAuthorityPrincipalId,
        selectedAlternative: selected,
        alternatives: snapshot.alternatives,
        objections: snapshot.objections,
        consultations: snapshot.consultations,
        evidenceRefs: snapshot.candidate.evidenceRefs,
        affectedRefs: snapshot.candidate.affectedRefs,
        consequences: snapshot.candidate.consequences,
        followUpActions: snapshot.candidate.followUpActions,
        verificationPlan: snapshot.candidate.verificationPlan,
        verificationDueAt:
          snapshot.candidate.verificationDueAt?.toISOString() ?? null,
        decisionDeadline:
          snapshot.candidate.decisionDeadline?.toISOString() ?? null,
        effectiveFrom: snapshot.candidate.effectiveFrom?.toISOString() ?? null,
        effectiveUntil:
          snapshot.candidate.effectiveUntil?.toISOString() ?? null,
        supersedesCandidateId: snapshot.candidate.supersedesCandidateId,
      },
    });
    const updated = await client.query<Record<string, unknown>>(
      `update workspace_decision_candidates
          set captured_event_id=$2,version=version+1,updated_at=now()
        where id=$1
        returning *,null::text review_status`,
      [input.candidateId, event.id],
    );
    const row = updated.rows[0];
    if (!row) throw decisionError("DECISION_CAPTURE_WRITE_FAILED", 500);
    await client.query("commit");
    return { candidate: candidateRecord(row), event };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function validateDecisionPromotionCandidate(
  db: Postgres,
  input: {
    sessionId: string;
    candidateId: string;
    capturedEventId: string;
    actorUserId: string;
    actorPrincipalId: string;
  },
): Promise<DecisionCandidateRecord> {
  const client = await db.pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    const scope = await requireDecisionScope(client, {
      sessionId: input.sessionId,
      actorUserId: input.actorUserId,
      actorPrincipalId: input.actorPrincipalId,
      requireCurrentRevision: true,
    });
    const result = await client.query<Record<string, unknown>>(
      `select candidate.*,review.status review_status
         from workspace_decision_candidates candidate
         left join reviews review on review.id=candidate.review_id
        where candidate.id=$1 and candidate.session_id=$2
          and candidate.space_id=$3 and candidate.vault_id=$4
          and candidate.status='READY_FOR_REVIEW'
          and candidate.captured_event_id=$5::bigint
          and candidate.review_id is null`,
      [
        input.candidateId,
        input.sessionId,
        scope.spaceId,
        scope.vaultId,
        input.capturedEventId,
      ],
    );
    const row = result.rows[0];
    if (!row) throw decisionError("DECISION_PROMOTION_STATE_INVALID", 409);
    await client.query("commit");
    return candidateRecord(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function linkDecisionCandidateReviewInTransaction(
  client: PostgresPoolClient,
  input: {
    candidateId: string;
    sessionId: string;
    capturedEventId: string;
    reviewId: string;
  },
): Promise<void> {
  try {
    const updated = await client.query(
      `update workspace_decision_candidates
          set status='PENDING_REVIEW',review_id=$4,
              version=version+1,updated_at=now()
        where id=$1 and session_id=$2
          and captured_event_id=$3::bigint
          and status='READY_FOR_REVIEW' and review_id is null
        returning id`,
      [
        input.candidateId,
        input.sessionId,
        input.capturedEventId,
        input.reviewId,
      ],
    );
    if (!updated.rowCount) {
      throw decisionError("DECISION_PROMOTION_STATE_INVALID", 409);
    }
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "23505"
    ) {
      throw decisionError("DECISION_SUPERSESSION_ALREADY_PENDING", 409);
    }
    throw error;
  }
}

function decisionWorkflowManifest(
  impactManifest: Record<string, unknown>,
): { candidateId: string; capturedEventId: string } | null {
  const value = impactManifest.decisionWorkflow;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidateId = (value as Record<string, unknown>).candidateId;
  const capturedEventId = (value as Record<string, unknown>).capturedEventId;
  return typeof candidateId === "string" && typeof capturedEventId === "string"
    ? { candidateId, capturedEventId }
    : null;
}

export async function finalizeDecisionCandidatePublicationInTransaction(
  client: SqlExecutor,
  input: {
    reviewId: string;
    revision: string;
    impactManifest: Record<string, unknown>;
  },
): Promise<void> {
  const manifest = decisionWorkflowManifest(input.impactManifest);
  if (!manifest) return;
  const currentResult = await client.query<Record<string, unknown>>(
    `select * from workspace_decision_candidates
      where id=$1 and review_id=$2
      for update`,
    [manifest.candidateId, input.reviewId],
  );
  const current = currentResult.rows[0];
  if (!current) throw new Error("DECISION_PUBLICATION_CANDIDATE_MISSING");
  if (
    String(current.status) === "APPROVED" &&
    String(current.published_revision ?? "") === input.revision
  ) {
    return;
  }
  if (String(current.status) !== "PENDING_REVIEW") {
    throw new Error("DECISION_PUBLICATION_STATE_INVALID");
  }
  const supersedesCandidateId = current.supersedes_candidate_id
    ? String(current.supersedes_candidate_id)
    : null;
  if (supersedesCandidateId) {
    const predecessor = await client.query<Record<string, unknown>>(
      `select * from workspace_decision_candidates
        where id=$1 and vault_id=$2
        for update`,
      [supersedesCandidateId, current.vault_id],
    );
    const prior = predecessor.rows[0];
    if (!prior) throw new Error("DECISION_SUPERSESSION_TARGET_MISSING");
    const alreadySuperseded =
      String(prior.status) === "SUPERSEDED" &&
      String(prior.superseded_by_candidate_id ?? "") === manifest.candidateId;
    if (!alreadySuperseded) {
      const superseded = await client.query(
        `update workspace_decision_candidates
            set status='SUPERSEDED',superseded_by_candidate_id=$2,
                superseded_at=now(),version=version+1,updated_at=now()
          where id=$1 and status='APPROVED'
          returning id`,
        [supersedesCandidateId, manifest.candidateId],
      );
      if (!superseded.rowCount) {
        throw new Error("DECISION_SUPERSESSION_CONFLICT");
      }
    }
  }
  const approved = await client.query(
    `update workspace_decision_candidates
        set status='APPROVED',published_revision=$3,approved_at=now(),
            version=version+1,updated_at=now()
      where id=$1 and review_id=$2 and status='PENDING_REVIEW'
      returning id`,
    [manifest.candidateId, input.reviewId, input.revision],
  );
  if (!approved.rowCount) throw new Error("DECISION_PUBLICATION_STATE_LOST");
}

