import Link from "next/link";
import { akp } from "../../lib/api";
import { createDecision } from "./actions";

type Session = {
  id: string;
  spaceId: string;
  vaultId: string;
  purpose: string;
  workStatus: string;
  contextRevisionSetHash?: string | null;
};

type Principal = {
  id: string;
  kind: string;
  user_id: string | null;
  state: string;
};

type SessionState = {
  session: Session;
  principals: Principal[];
  contextRevision: {
    status: string;
    changedDimensions?: string[];
  };
};

type Decision = {
  id: string;
  title: string;
  status: string;
  decisionAuthorityPrincipalId: string;
  reviewId?: string | null;
  reviewStatus?: string | null;
  publishedRevision?: string | null;
  updatedAt: string;
};

function short(value: string | null | undefined): string {
  return value ? value.slice(0, 12) : "—";
}

export default async function DecisionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    sessionId?: string;
    notice?: string;
    error?: string;
  }>;
}) {
  const query = await searchParams;
  const sessionsResponse = await akp<{ sessions: Session[] }>("/v1/sessions");
  const selected =
    sessionsResponse.sessions.find(
      (session) => session.id === query.sessionId,
    ) ?? sessionsResponse.sessions[0];

  if (!selected) {
    return (
      <main>
        <p className="muted">Human Team Workspace</p>
        <h1>Architecture Decisions</h1>
        <div className="card">
          No hay sesiones de trabajo visibles. Crea o abre una sesión antes de
          iniciar una decisión.
        </div>
      </main>
    );
  }

  const [state, decisionsResponse] = await Promise.all([
    akp<SessionState>(`/v1/sessions/${encodeURIComponent(selected.id)}/state`),
    akp<{ decisions: Decision[] }>(
      `/v1/sessions/${encodeURIComponent(selected.id)}/decisions`,
    ),
  ]);
  const humanPrincipals = state.principals.filter(
    (principal) => principal.kind === "HUMAN" && principal.state === "ACTIVE",
  );

  return (
    <main>
      <p className="muted">Human Team Workspace · governed decision workflow</p>
      <h1>Architecture Decisions</h1>

      {query.notice ? <p className="card">{query.notice}</p> : null}
      {query.error ? (
        <p className="card">
          <strong>Action failed:</strong> {query.error}
        </p>
      ) : null}

      <section className="card">
        <h2>Session</h2>
        <p>
          <strong>{selected.purpose}</strong>{" "}
          <span className="badge">{selected.workStatus}</span>
        </p>
        <p className="muted">
          context {short(selected.contextRevisionSetHash)} ·{" "}
          {state.contextRevision.status}
        </p>
        <p>
          {sessionsResponse.sessions.map((session, index) => (
            <span key={session.id}>
              {index > 0 ? " · " : ""}
              <Link href={`/decisions?sessionId=${session.id}`}>
                {session.purpose}
              </Link>
            </span>
          ))}
        </p>
      </section>

      <div className="grid" style={{ marginTop: 18 }}>
        <section className="card">
          <h2>Decision candidates</h2>
          {decisionsResponse.decisions.length ? (
            <table>
              <thead>
                <tr>
                  <th>Decision</th>
                  <th>Status</th>
                  <th>Authority</th>
                  <th>Review</th>
                </tr>
              </thead>
              <tbody>
                {decisionsResponse.decisions.map((decision) => (
                  <tr key={decision.id}>
                    <td>
                      <Link
                        href={`/decisions/${decision.id}?sessionId=${selected.id}`}
                      >
                        {decision.title}
                      </Link>
                    </td>
                    <td>{decision.status}</td>
                    <td>
                      <code>
                        {short(decision.decisionAuthorityPrincipalId)}
                      </code>
                    </td>
                    <td>
                      {decision.reviewId ? (
                        <Link href={`/reviews/${decision.reviewId}`}>
                          {decision.reviewStatus ?? "review"}
                        </Link>
                      ) : decision.publishedRevision ? (
                        <code>{short(decision.publishedRevision)}</code>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No hay decisiones en esta sesión.</p>
          )}
        </section>

        <section className="card">
          <h2>New candidate</h2>
          <p className="muted">
            La autoridad de decisión debe ser un participante humano. Las
            alternativas sugeridas por agentes no adquieren autoridad hasta que
            esa persona las marque como consideradas.
          </p>
          {humanPrincipals.length ? (
            <form action={createDecision} className="stack">
              <input type="hidden" name="sessionId" value={selected.id} />
              <label>
                Decision authority
                <select name="decisionAuthorityPrincipalId" required>
                  {humanPrincipals.map((principal) => (
                    <option key={principal.id} value={principal.id}>
                      {short(principal.id)} · user {short(principal.user_id)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Title
                <input name="title" required maxLength={200} />
              </label>
              <label>
                Problem
                <textarea name="problem" required />
              </label>
              <label>
                Context
                <textarea name="context" required />
              </label>
              <label>
                Drivers · one per line
                <textarea name="drivers" required />
              </label>
              <label>
                Quality attributes · one per line
                <textarea name="qualityAttributes" required />
              </label>
              <label>
                Evidence refs · one per line
                <textarea name="evidenceRefs" required />
              </label>
              <label>
                Affected refs · one per line
                <textarea name="affectedRefs" />
              </label>
              <label>
                Verification plan
                <textarea name="verificationPlan" required />
              </label>
              <label>
                Verification due · ISO 8601, optional
                <input
                  name="verificationDueAt"
                  placeholder="2026-10-01T12:00:00Z"
                />
              </label>
              <label>
                Decision deadline · ISO 8601, optional
                <input
                  name="decisionDeadline"
                  placeholder="2026-10-01T12:00:00Z"
                />
              </label>
              <label>
                Supersedes candidate UUID · optional
                <input name="supersedesCandidateId" />
              </label>
              <button type="submit">Create decision candidate</button>
            </form>
          ) : (
            <p>No hay principals humanos activos en esta sesión.</p>
          )}
        </section>
      </div>
    </main>
  );
}
