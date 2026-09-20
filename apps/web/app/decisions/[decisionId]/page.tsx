import Link from "next/link";
import { akp } from "../../../lib/api";
import {
  addAlternative,
  addObjection,
  captureDecision,
  decideAlternative,
  promoteDecision,
  requestConsultation,
  resolveObjection,
  respondConsultation,
  selectAlternative,
} from "../actions";
import { decisionReadiness } from "../decision-readiness";

type Candidate = {
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
  verificationDueAt: string | null;
  decisionDeadline: string | null;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  status: string;
  selectedAlternativeId: string | null;
  capturedEventId: string | null;
  reviewId: string | null;
  reviewStatus: string | null;
  supersedesCandidateId: string | null;
  supersededByCandidateId: string | null;
  publishedRevision: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

type Alternative = {
  id: string;
  authorPrincipalId: string;
  origin: "HUMAN_SUBMITTED" | "AGENT_SUGGESTED";
  title: string;
  description: string;
  tradeoffs: string;
  evidenceRefs: string[];
  status: string;
  decidedByPrincipalId: string | null;
  decidedAt: string | null;
};

type Objection = {
  id: string;
  alternativeId: string | null;
  authorPrincipalId: string;
  statement: string;
  evidenceRefs: string[];
  status: string;
  resolution: string | null;
  resolvedByPrincipalId: string | null;
};

type Consultation = {
  id: string;
  requestedByPrincipalId: string;
  reviewerPrincipalId: string;
  question: string;
  status: string;
  position: string | null;
  response: string | null;
};

type DecisionSnapshot = {
  candidate: Candidate;
  alternatives: Alternative[];
  objections: Objection[];
  consultations: Consultation[];
};

type Principal = {
  id: string;
  kind: string;
  user_id: string | null;
  state: string;
};

type SessionState = {
  session: {
    id: string;
    spaceId: string;
    vaultId: string;
    purpose: string;
    contextRevisionSetHash?: string | null;
  };
  principals: Principal[];
  contextRevision: {
    status: string;
    changedDimensions?: string[];
  };
};

type OperatorMe = {
  actor: {
    id: string;
    memberships: Array<{
      spaceId: string;
      pathPrefix: string | null;
      permissions: string[];
    }>;
  } | null;
};

function short(value: string | null | undefined): string {
  return value ? value.slice(0, 12) : "—";
}

function list(values: string[]): string {
  return values.length ? values.join(" · ") : "—";
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, 80) || "architecture-decision"
  );
}

function promotionContent(
  candidate: Candidate,
  selected: Alternative | undefined,
): string {
  return [
    "---",
    `id: DECISION-${candidate.id.slice(0, 8).toUpperCase()}`,
    "type: decision",
    "status: proposed",
    "knowledge_layer: project",
    "---",
    `# ${candidate.title}`,
    "",
    "## Problem",
    candidate.problem,
    "",
    "## Decision",
    selected?.description ?? "Selected alternative recorded in governed evidence.",
    "",
    "## Consequences",
    candidate.consequences ?? "See captured decision evidence.",
    "",
    "## Verification",
    candidate.verificationPlan,
    "",
  ].join("\n");
}

export default async function DecisionPage({
  params,
  searchParams,
}: {
  params: Promise<{ decisionId: string }>;
  searchParams: Promise<{
    sessionId?: string;
    notice?: string;
    error?: string;
  }>;
}) {
  const { decisionId } = await params;
  const query = await searchParams;
  if (!query.sessionId) {
    return (
      <main>
        <p className="muted">Architecture Decision Workspace</p>
        <h1>Session required</h1>
        <div className="card">
          Open this decision from the workspace so its authorized session scope
          is explicit.
        </div>
      </main>
    );
  }

  const sessionId = query.sessionId;
  const [snapshot, state, me] = await Promise.all([
    akp<DecisionSnapshot>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/decisions/${encodeURIComponent(decisionId)}`,
    ),
    akp<SessionState>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/state`,
    ),
    akp<OperatorMe>("/v1/operator/me"),
  ]);
  const { candidate, alternatives, objections, consultations } = snapshot;
  const readiness = decisionReadiness({
    candidateStatus: candidate.status,
    alternatives,
    objections,
    consultations,
    capturedEventId: candidate.capturedEventId,
    reviewId: candidate.reviewId,
  });
  const currentPrincipal = state.principals.find(
    (principal) =>
      principal.kind === "HUMAN" &&
      principal.state === "ACTIVE" &&
      principal.user_id === me.actor?.id,
  );
  const isAuthority =
    currentPrincipal?.id === candidate.decisionAuthorityPrincipalId;
  const membership = me.actor?.memberships.find(
    (item) => item.spaceId === candidate.spaceId,
  );
  const canPropose =
    membership?.pathPrefix === null &&
    membership.permissions.includes("knowledge:propose");
  const humanPrincipals = state.principals.filter(
    (principal) => principal.kind === "HUMAN" && principal.state === "ACTIVE",
  );
  const consultantOptions = humanPrincipals.filter(
    (principal) =>
      principal.id !== currentPrincipal?.id &&
      principal.id !== candidate.decisionAuthorityPrincipalId,
  );
  const selected = alternatives.find(
    (alternative) => alternative.id === candidate.selectedAlternativeId,
  );
  const defaultPath = `20-knowledge/generated/decision/${slug(candidate.title)}-${candidate.id.slice(0, 8)}.md`;

  return (
    <main>
      <p className="muted">Architecture Decision Workspace</p>
      <h1>{candidate.title}</h1>
      <p>
        <Link href={`/decisions?sessionId=${sessionId}`}>
          ← All decisions in {state.session.purpose}
        </Link>
      </p>

      {query.notice ? <p className="card">{query.notice}</p> : null}
      {query.error ? (
        <p className="card">
          <strong>Action failed:</strong> {query.error}
        </p>
      ) : null}

      <div className="grid">
        <section className="card">
          <p className="muted">Lifecycle</p>
          <p className="metric">{candidate.status}</p>
          <p>version {candidate.version}</p>
          <p>
            authority <code>{short(candidate.decisionAuthorityPrincipalId)}</code>
            {isAuthority ? " · you are the decision authority" : ""}
          </p>
          <p>
            context <code>{short(state.session.contextRevisionSetHash)}</code> ·{" "}
            {state.contextRevision.status}
          </p>
          {candidate.reviewId ? (
            <p>
              <Link href={`/reviews/${candidate.reviewId}`}>
                Review {short(candidate.reviewId)} ·{" "}
                {candidate.reviewStatus ?? "linked"}
              </Link>
            </p>
          ) : null}
          {candidate.publishedRevision ? (
            <p>
              published <code>{short(candidate.publishedRevision)}</code>
            </p>
          ) : null}
        </section>

        <section className="card">
          <p className="muted">Selection gates</p>
          <p className="metric">
            {readiness.selectionReady ? "READY" : "BLOCKED"}
          </p>
          <p>
            considered alternatives: {readiness.consideredAlternatives} / 2
          </p>
          <p>
            responded consultations: {readiness.respondedConsultations} / 1
          </p>
          <p>open objections: {readiness.openObjections}</p>
          <p className="muted">
            Agent suggestions count only after the human decision authority
            marks them CONSIDERED.
          </p>
        </section>
      </div>

      <h2>Decision frame</h2>
      <div className="grid">
        <section className="card">
          <h3>Problem</h3>
          <p>{candidate.problem}</p>
          <h3>Context</h3>
          <p>{candidate.context}</p>
        </section>
        <section className="card">
          <h3>Drivers</h3>
          <p>{list(candidate.drivers)}</p>
          <h3>Quality attributes</h3>
          <p>{list(candidate.qualityAttributes)}</p>
          <h3>Affected refs</h3>
          <p>{list(candidate.affectedRefs)}</p>
          <h3>Evidence refs</h3>
          <p>{list(candidate.evidenceRefs)}</p>
        </section>
        <section className="card">
          <h3>Verification</h3>
          <p>{candidate.verificationPlan}</p>
          <p>
            due {candidate.verificationDueAt ?? "not set"} · decision deadline{" "}
            {candidate.decisionDeadline ?? "not set"}
          </p>
          {candidate.supersedesCandidateId ? (
            <p>
              supersedes{" "}
              <code>{short(candidate.supersedesCandidateId)}</code>
            </p>
          ) : null}
          {candidate.supersededByCandidateId ? (
            <p>
              superseded by{" "}
              <code>{short(candidate.supersededByCandidateId)}</code>
            </p>
          ) : null}
        </section>
      </div>

      <h2>Alternatives</h2>
      <div className="grid">
        {alternatives.map((alternative) => (
          <section className="card" key={alternative.id}>
            <p>
              <span className="badge">{alternative.origin}</span>
              <span className="badge">{alternative.status}</span>
            </p>
            <h3>{alternative.title}</h3>
            <p>{alternative.description}</p>
            <p>
              <strong>Trade-offs:</strong> {alternative.tradeoffs}
            </p>
            <p className="muted">evidence {list(alternative.evidenceRefs)}</p>
            {alternative.decidedByPrincipalId ? (
              <p className="muted">
                decided by {short(alternative.decidedByPrincipalId)}
              </p>
            ) : null}
            {isAuthority &&
            readiness.editable &&
            alternative.status !== "REJECTED" ? (
              <form action={decideAlternative} className="inline-actions">
                <input type="hidden" name="sessionId" value={sessionId} />
                <input type="hidden" name="decisionId" value={candidate.id} />
                <input
                  type="hidden"
                  name="alternativeId"
                  value={alternative.id}
                />
                <button type="submit" name="decision" value="CONSIDER">
                  Consider
                </button>
                <button type="submit" name="decision" value="REJECT">
                  Reject
                </button>
              </form>
            ) : null}
          </section>
        ))}
      </div>

      {readiness.editable ? (
        <section className="card" style={{ marginTop: 18 }}>
          <h3>Add alternative</h3>
          <form action={addAlternative} className="stack">
            <input type="hidden" name="sessionId" value={sessionId} />
            <input type="hidden" name="decisionId" value={candidate.id} />
            <label>
              Title
              <input name="title" required />
            </label>
            <label>
              Description
              <textarea name="description" required />
            </label>
            <label>
              Trade-offs
              <textarea name="tradeoffs" required />
            </label>
            <label>
              Evidence refs · one per line
              <textarea name="evidenceRefs" />
            </label>
            <button type="submit">Add alternative</button>
          </form>
        </section>
      ) : null}

      <h2>Consultation and objections</h2>
      <div className="grid">
        <section className="card">
          <h3>Consultations</h3>
          {consultations.length ? (
            consultations.map((consultation) => (
              <article key={consultation.id} style={{ marginBottom: 18 }}>
                <p>
                  <span className="badge">{consultation.status}</span>
                  {consultation.position ? (
                    <span className="badge">{consultation.position}</span>
                  ) : null}
                </p>
                <p>{consultation.question}</p>
                <p className="muted">
                  reviewer {short(consultation.reviewerPrincipalId)}
                </p>
                {consultation.response ? <p>{consultation.response}</p> : null}
                {consultation.status === "REQUESTED" &&
                consultation.reviewerPrincipalId === currentPrincipal?.id ? (
                  <form action={respondConsultation} className="stack">
                    <input type="hidden" name="sessionId" value={sessionId} />
                    <input
                      type="hidden"
                      name="decisionId"
                      value={candidate.id}
                    />
                    <input
                      type="hidden"
                      name="consultationId"
                      value={consultation.id}
                    />
                    <label>
                      Position
                      <select name="position" required>
                        <option value="SUPPORT">Support</option>
                        <option value="OPPOSE">Oppose</option>
                        <option value="NEUTRAL">Neutral</option>
                      </select>
                    </label>
                    <label>
                      Response
                      <textarea name="response" required />
                    </label>
                    <button type="submit">Respond</button>
                  </form>
                ) : null}
              </article>
            ))
          ) : (
            <p className="muted">No consultations requested.</p>
          )}

          {readiness.editable && consultantOptions.length ? (
            <form action={requestConsultation} className="stack">
              <input type="hidden" name="sessionId" value={sessionId} />
              <input type="hidden" name="decisionId" value={candidate.id} />
              <label>
                Independent human reviewer
                <select name="reviewerPrincipalId" required>
                  {consultantOptions.map((principal) => (
                    <option key={principal.id} value={principal.id}>
                      {short(principal.id)} · user {short(principal.user_id)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Question
                <textarea name="question" required />
              </label>
              <button type="submit">Request consultation</button>
            </form>
          ) : null}
        </section>

        <section className="card">
          <h3>Objections</h3>
          {objections.length ? (
            objections.map((objection) => (
              <article key={objection.id} style={{ marginBottom: 18 }}>
                <p>
                  <span className="badge">{objection.status}</span>
                  {objection.alternativeId
                    ? ` alternative ${short(objection.alternativeId)}`
                    : " decision-level"}
                </p>
                <p>{objection.statement}</p>
                <p className="muted">evidence {list(objection.evidenceRefs)}</p>
                {objection.resolution ? (
                  <p>
                    <strong>Resolution:</strong> {objection.resolution}
                  </p>
                ) : null}
                {isAuthority &&
                readiness.editable &&
                objection.status === "OPEN" ? (
                  <form action={resolveObjection} className="stack">
                    <input type="hidden" name="sessionId" value={sessionId} />
                    <input
                      type="hidden"
                      name="decisionId"
                      value={candidate.id}
                    />
                    <input
                      type="hidden"
                      name="objectionId"
                      value={objection.id}
                    />
                    <label>
                      Resolution
                      <textarea name="resolution" required />
                    </label>
                    <button type="submit">Resolve objection</button>
                  </form>
                ) : null}
              </article>
            ))
          ) : (
            <p className="muted">No objections recorded.</p>
          )}

          {readiness.editable ? (
            <form action={addObjection} className="stack">
              <input type="hidden" name="sessionId" value={sessionId} />
              <input type="hidden" name="decisionId" value={candidate.id} />
              <label>
                Scope · optional alternative
                <select name="alternativeId" defaultValue="">
                  <option value="">Decision-level objection</option>
                  {alternatives.map((alternative) => (
                    <option key={alternative.id} value={alternative.id}>
                      {alternative.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Statement
                <textarea name="statement" required />
              </label>
              <label>
                Evidence refs · one per line
                <textarea name="evidenceRefs" />
              </label>
              <button type="submit">Add objection</button>
            </form>
          ) : null}
        </section>
      </div>

      <h2>Selection, capture and governance</h2>
      <div className="grid">
        <section className="card">
          <h3>Human selection</h3>
          {isAuthority && readiness.selectionReady ? (
            <form action={selectAlternative} className="stack">
              <input type="hidden" name="sessionId" value={sessionId} />
              <input type="hidden" name="decisionId" value={candidate.id} />
              <label>
                Selected alternative
                <select name="alternativeId" required>
                  {alternatives
                    .filter((alternative) => alternative.status === "CONSIDERED")
                    .map((alternative) => (
                      <option key={alternative.id} value={alternative.id}>
                        {alternative.title}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Consequences
                <textarea name="consequences" required />
              </label>
              <label>
                Follow-up actions · one per line
                <textarea name="followUpActions" />
              </label>
              <label>
                Effective from · ISO 8601, optional
                <input name="effectiveFrom" placeholder="2026-10-01T00:00:00Z" />
              </label>
              <label>
                Effective until · ISO 8601, optional
                <input name="effectiveUntil" placeholder="2027-10-01T00:00:00Z" />
              </label>
              <button type="submit">Select for governed review</button>
            </form>
          ) : (
            <p className="muted">
              Selection requires the human authority, at least two considered
              alternatives, one responded independent consultation, and zero
              open objections.
            </p>
          )}

          {candidate.selectedAlternativeId ? (
            <>
              <p>
                selected <strong>{selected?.title ?? short(candidate.selectedAlternativeId)}</strong>
              </p>
              <p>{candidate.consequences}</p>
              <p className="muted">
                effective {candidate.effectiveFrom ?? "not bounded"} →{" "}
                {candidate.effectiveUntil ?? "open"}
              </p>
              <p>follow-up {list(candidate.followUpActions)}</p>
            </>
          ) : null}
        </section>

        <section className="card">
          <h3>Capture</h3>
          <p className="muted">
            Capture freezes the structured candidate into durable workspace
            evidence. It does not publish canonical knowledge.
          </p>
          {readiness.captureReady && !candidate.capturedEventId ? (
            <form action={captureDecision}>
              <input type="hidden" name="sessionId" value={sessionId} />
              <input type="hidden" name="decisionId" value={candidate.id} />
              <button type="submit">Capture decision evidence</button>
            </form>
          ) : null}
          {candidate.capturedEventId ? (
            <p>
              event <code>{candidate.capturedEventId}</code>
            </p>
          ) : (
            <p className="muted">No captured decision event yet.</p>
          )}
        </section>

        <section className="card">
          <h3>Promote to Review Workspace</h3>
          {readiness.promotionReady && canPropose ? (
            <form action={promoteDecision} className="stack">
              <input type="hidden" name="sessionId" value={sessionId} />
              <input type="hidden" name="decisionId" value={candidate.id} />
              <input
                type="hidden"
                name="capturedEventId"
                value={candidate.capturedEventId ?? ""}
              />
              <label>
                Summary
                <input
                  name="summary"
                  required
                  defaultValue={`Promote architecture decision: ${candidate.title}`}
                />
              </label>
              <label>
                Canonical path
                <input name="path" required defaultValue={defaultPath} />
              </label>
              <label>
                Proposed canonical content
                <textarea
                  name="content"
                  required
                  defaultValue={promotionContent(candidate, selected)}
                  rows={18}
                />
              </label>
              <label>
                Reason
                <textarea
                  name="reason"
                  required
                  defaultValue="Promote the captured, consulted decision through the governed human review boundary."
                />
              </label>
              <p className="muted">
                The content still must satisfy the active KnowledgeProfile.
                Promotion creates a review; it does not approve publication.
              </p>
              <button type="submit">Create governed review</button>
            </form>
          ) : candidate.reviewId ? (
            <p>
              Already linked to{" "}
              <Link href={`/reviews/${candidate.reviewId}`}>
                review {short(candidate.reviewId)}
              </Link>
              .
            </p>
          ) : (
            <p className="muted">
              Promotion requires captured evidence plus full-vault
              knowledge:propose permission.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
