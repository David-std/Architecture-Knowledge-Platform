import Link from "next/link";
import { akp } from "../../../lib/api";
import {
  eventPayload,
  sessionObjectGroups,
  type SessionEvent,
} from "./session-object";

type Session = {
  id: string;
  spaceId: string;
  vaultId: string;
  projectId: string | null;
  purpose: string;
  contextBudget: number;
  coordinationVersion: number;
  workStatus: string;
  outcome: string | null;
  followUps: string[];
  touchedResources: string[];
  contextRevisionSetHash: string | null;
  role: string;
};

type Participant = {
  user_id: string;
  role: string;
  joined_at: string;
};

type Principal = {
  id: string;
  kind: string;
  user_id: string | null;
  parent_principal_id: string | null;
  policy_revision: number;
  state: string;
  created_at: string;
};

type Claim = {
  id: string;
  sessionId: string;
  workKey: string;
  ownerId: string;
  ownerPrincipalId: string;
  status: string;
  fencingToken: number;
  leaseExpiresAt: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

type ExternalRef = {
  id: string;
  provider: string;
  objectType: string;
  externalId: string;
  title: string | null;
  authority: string;
  workObjectClass: string | null;
  sourceRevision: string | null;
  updatedAt: string;
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

type AuditEvent = {
  id: string | number;
  actor_id: string | null;
  principal_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  trace_id: string | null;
  created_at: string;
};

type ContextPacketSummary = {
  id: string;
  objectRefId: string | null;
  packetHash: string;
  corpusRevision: string;
  createdAt: string;
  expiresAt: string | null;
};

type SessionState = {
  session: Session;
  participants: Participant[];
  principals: Principal[];
  assignedPrincipals: string[];
  claims: Claim[];
  contextPackets: ContextPacketSummary[];
  events: SessionEvent[];
  snapshotVersion: number;
  eventWindow: {
    total: number;
    returned: number;
    truncated: boolean;
    oldestVersion: number | null;
    latestVersion: number | null;
  };
  contextRevision: {
    status: string;
    changedDimensions: string[];
    pinned: {
      revisionSetHash?: string;
    } | null;
    current: {
      revisionSetHash?: string;
    };
  };
};

function short(value: string | null | undefined): string {
  return value ? value.slice(0, 12) : "—";
}

function scalar(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return "—";
}

function captureTitle(event: SessionEvent): string {
  const payload = eventPayload(event.payload);
  return scalar(payload.title) !== "—"
    ? scalar(payload.title)
    : scalar(payload.summary) !== "—"
      ? scalar(payload.summary)
      : event.event_type;
}

export default async function SessionObjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [state, refsResponse, me] = await Promise.all([
    akp<SessionState>(`/v1/sessions/${encodeURIComponent(id)}/state`),
    akp<{ refs: ExternalRef[] }>(
      `/v1/sessions/${encodeURIComponent(id)}/external-refs`,
    ),
    akp<OperatorMe>("/v1/operator/me"),
  ]);
  const grouped = sessionObjectGroups(state.events);
  const workRefs = refsResponse.refs.filter(
    (ref) => ref.workObjectClass !== null,
  );
  const canReadAudit = Boolean(
    me.actor?.memberships.some(
      (membership) =>
        membership.spaceId === state.session.spaceId &&
        membership.pathPrefix === null &&
        membership.permissions.includes("admin"),
    ),
  );
  const auditResponse = canReadAudit
    ? await akp<{ events: AuditEvent[] }>(
        `/v1/audit-events?resourceType=agent_session&resourceId=${encodeURIComponent(id)}&limit=100`,
      )
    : { events: [] as AuditEvent[] };

  return (
    <main>
      <p className="muted">Object-centric workspace · Agent session</p>
      <h1>{state.session.purpose}</h1>
      <p>
        <Link href="/">← Workspace Home</Link>
      </p>

      <div className="grid">
        <section className="card">
          <p className="muted">Work state</p>
          <p className="metric">{state.session.workStatus}</p>
          <p>
            session <code>{short(state.session.id)}</code> · role{" "}
            {state.session.role}
          </p>
          <p>
            coordination version {state.session.coordinationVersion} · snapshot{" "}
            {state.snapshotVersion}
          </p>
          {state.session.outcome ? (
            <p>
              <strong>Outcome:</strong> {state.session.outcome}
            </p>
          ) : null}
        </section>

        <section className="card">
          <p className="muted">Pinned context revision</p>
          <p className="metric">{state.contextRevision.status}</p>
          <p>
            pinned{" "}
            <code>
              {short(
                state.session.contextRevisionSetHash ??
                  state.contextRevision.pinned?.revisionSetHash,
              )}
            </code>
          </p>
          <p>
            current{" "}
            <code>{short(state.contextRevision.current.revisionSetHash)}</code>
          </p>
          {state.contextRevision.changedDimensions.length ? (
            <p>changed {state.contextRevision.changedDimensions.join(" · ")}</p>
          ) : null}
        </section>

        <section className="card">
          <p className="muted">Event window</p>
          <p className="metric">{state.eventWindow.returned}</p>
          <p>
            of {state.eventWindow.total} durable events
            {state.eventWindow.truncated ? " · truncated" : ""}
          </p>
          <p>
            versions {state.eventWindow.oldestVersion ?? "—"} →{" "}
            {state.eventWindow.latestVersion ?? "—"}
          </p>
        </section>
      </div>

      <h2>Participants and principals</h2>
      <div className="grid">
        <section className="card">
          <h3>Participants</h3>
          {state.participants.length ? (
            <ul>
              {state.participants.map((participant) => (
                <li key={participant.user_id}>
                  <code>{short(participant.user_id)}</code> · {participant.role}
                  <br />
                  <small className="muted">
                    joined {participant.joined_at}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No participants.</p>
          )}
        </section>

        <section className="card">
          <h3>Principals</h3>
          {state.principals.length ? (
            <ul>
              {state.principals.map((principal) => (
                <li key={principal.id}>
                  <span className="badge">{principal.kind}</span>{" "}
                  <span className="badge">{principal.state}</span>{" "}
                  <code>{short(principal.id)}</code>
                  <br />
                  <small className="muted">
                    policy {principal.policy_revision}
                    {principal.parent_principal_id
                      ? ` · parent ${short(principal.parent_principal_id)}`
                      : ""}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No principals.</p>
          )}
        </section>
      </div>

      <h2>Work objects</h2>
      <section className="card">
        {workRefs.length ? (
          <table>
            <thead>
              <tr>
                <th>Object</th>
                <th>Class</th>
                <th>Provider</th>
                <th>Authority</th>
                <th>Revision</th>
              </tr>
            </thead>
            <tbody>
              {workRefs.map((ref) => (
                <tr key={ref.id}>
                  <td>
                    <Link
                      href={`/work/${ref.id}?sessionId=${state.session.id}`}
                    >
                      {ref.title?.trim() || ref.externalId}
                    </Link>
                    <br />
                    <small className="muted">{ref.objectType}</small>
                  </td>
                  <td>{ref.workObjectClass}</td>
                  <td>{ref.provider}</td>
                  <td>{ref.authority}</td>
                  <td>
                    <code>{short(ref.sourceRevision)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">
            No typed work objects projected for this session.
          </p>
        )}
      </section>

      <h2>Work claims</h2>
      <section className="card">
        {state.claims.length ? (
          <table>
            <thead>
              <tr>
                <th>Work key</th>
                <th>Owner principal</th>
                <th>Status</th>
                <th>Fence</th>
                <th>Lease</th>
              </tr>
            </thead>
            <tbody>
              {state.claims.map((claim) => (
                <tr key={claim.id}>
                  <td>
                    <code>{claim.workKey}</code>
                  </td>
                  <td>
                    <code>{short(claim.ownerPrincipalId)}</code>
                  </td>
                  <td>{claim.status}</td>
                  <td>{claim.fencingToken}</td>
                  <td>{claim.leaseExpiresAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No work claims recorded for this session.</p>
        )}
      </section>

      <h2>Captures and handoffs</h2>
      <div className="grid">
        <section className="card">
          <h3>Durable captures</h3>
          {grouped.captures.length ? (
            <ul>
              {grouped.captures.map((event) => {
                const payload = eventPayload(event.payload);
                const decisionId =
                  typeof payload.decisionWorkflowCandidateId === "string"
                    ? payload.decisionWorkflowCandidateId
                    : null;
                return (
                  <li key={String(event.id)}>
                    <span className="badge">{event.event_type}</span>{" "}
                    {decisionId ? (
                      <Link
                        href={`/decisions/${decisionId}?sessionId=${state.session.id}`}
                      >
                        {captureTitle(event)}
                      </Link>
                    ) : (
                      captureTitle(event)
                    )}
                    <br />
                    <small className="muted">
                      event {event.id} · version {event.session_version ?? "—"}
                    </small>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted">
              No captured findings, artifacts or decisions.
            </p>
          )}
        </section>

        <section className="card">
          <h3>Handoffs</h3>
          {grouped.handoffs.length ? (
            <ul>
              {grouped.handoffs.map((event) => {
                const payload = eventPayload(event.payload);
                return (
                  <li key={String(event.id)}>
                    <strong>{scalar(payload.summary)}</strong>
                    <br />
                    <small className="muted">
                      event {event.id} · actor {short(event.actor_principal_id)}
                    </small>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted">No handoffs.</p>
          )}
        </section>

        <section className="card">
          <h3>Questions / blockers</h3>
          {grouped.blockers.length ? (
            <ul>
              {grouped.blockers.map((event) => {
                const payload = eventPayload(event.payload);
                return (
                  <li key={String(event.id)}>
                    <span className="badge">{event.event_type}</span>{" "}
                    {scalar(payload.summary) !== "—"
                      ? scalar(payload.summary)
                      : scalar(payload.message)}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted">No questions or blockers.</p>
          )}
        </section>
      </div>

      <h2>Follow-up and touched resources</h2>
      <div className="grid">
        <section className="card">
          <h3>Follow-up</h3>
          {state.session.followUps.length ? (
            <ul>
              {state.session.followUps.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">No follow-up recorded.</p>
          )}
        </section>
        <section className="card">
          <h3>Touched resources</h3>
          {state.session.touchedResources.length ? (
            <ul>
              {state.session.touchedResources.map((item) => (
                <li key={item}>
                  <code>{item}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No touched resources recorded.</p>
          )}
        </section>
        <section className="card">
          <h3>Retrieved context IDs</h3>
          {state.contextPackets.length ? (
            <ul>
              {state.contextPackets.map((packet) => (
                <li key={packet.id}>
                  packet <code>{short(packet.id)}</code>
                  {packet.objectRefId ? (
                    <>
                      {" · "}
                      <Link
                        href={`/work/${packet.objectRefId}?sessionId=${state.session.id}`}
                      >
                        work object {short(packet.objectRefId)}
                      </Link>
                    </>
                  ) : null}
                  <br />
                  <small className="muted">
                    hash {short(packet.packetHash)} · corpus{" "}
                    {short(packet.corpusRevision)} · {packet.createdAt}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              No context packets are durably linked to this session yet.
            </p>
          )}
        </section>
      </div>

      <h2>Event timeline</h2>
      <section className="card">
        {state.events.length ? (
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>Type</th>
                <th>Actor principal</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {state.events.map((event) => (
                <tr key={String(event.id)}>
                  <td>{event.session_version ?? "—"}</td>
                  <td>{event.event_type}</td>
                  <td>
                    <code>{short(event.actor_principal_id)}</code>
                  </td>
                  <td>{event.created_at ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No durable events.</p>
        )}
      </section>

      <h2>Audit actions</h2>
      <section className="card">
        {!canReadAudit ? (
          <p className="muted">
            Audit actions require an unrestricted admin permission for this
            space.
          </p>
        ) : auditResponse.events.length ? (
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>Principal</th>
                <th>Actor</th>
                <th>Created</th>
                <th>Trace</th>
              </tr>
            </thead>
            <tbody>
              {auditResponse.events.map((event) => (
                <tr key={String(event.id)}>
                  <td>{event.action}</td>
                  <td>
                    <code>{short(event.principal_id)}</code>
                  </td>
                  <td>
                    <code>{short(event.actor_id)}</code>
                  </td>
                  <td>{event.created_at}</td>
                  <td>
                    <code>{short(event.trace_id)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No audit actions recorded for this session.</p>
        )}
      </section>
    </main>
  );
}
