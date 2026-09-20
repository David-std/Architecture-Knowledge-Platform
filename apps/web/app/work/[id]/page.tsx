import Link from "next/link";
import { notFound } from "next/navigation";
import { akp } from "../../../lib/api";
import {
  relatedObjectId,
  relationDirection,
  type WorkActivity,
} from "./work-object";

type ExternalRef = {
  id: string;
  spaceId: string;
  vaultId: string;
  sessionId: string | null;
  provider: string;
  objectType: string;
  externalId: string;
  canonicalUrl: string | null;
  sourceRevision: string | null;
  title: string | null;
  authority: string;
  workObjectClass: string | null;
  metadata: Record<string, unknown>;
  observedAt: string;
  updatedAt: string;
};

type Activity = WorkActivity & {
  sessionId: string | null;
  actorPrincipalId: string | null;
  actorExternalId: string | null;
  occurredAt: string;
  recordedAt: string;
  sourceSystem: string;
  evidenceRefs: string[];
  payload: Record<string, unknown>;
};

type Claim = {
  id: string;
  workKey: string;
  objectRefId: string | null;
  ownerPrincipalId: string;
  status: string;
  fencingToken: number;
  leaseExpiresAt: string;
};

type ContextPacketSummary = {
  id: string;
  objectRefId: string | null;
  packetHash: string;
  corpusRevision: string;
  createdAt: string;
};

type SessionState = {
  session: {
    id: string;
    purpose: string;
    workStatus: string;
    contextRevisionSetHash: string | null;
  };
  claims: Claim[];
  contextPackets: ContextPacketSummary[];
  contextRevision: {
    status: string;
  };
};

function short(value: string | null | undefined): string {
  return value ? value.slice(0, 12) : "—";
}

function display(value: unknown): string {
  if (typeof value === "string") return value || "—";
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value ?? "—");
  }
  if (value === undefined) return "—";
  return JSON.stringify(value);
}

function title(ref: ExternalRef | undefined, fallback: string): string {
  return ref?.title?.trim() || ref?.externalId || fallback;
}

export default async function WorkObjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ sessionId?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  if (!query.sessionId) notFound();
  const sessionId = query.sessionId;

  const [refsResponse, activityResponse, state] = await Promise.all([
    akp<{ refs: ExternalRef[] }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/external-refs`,
    ),
    akp<{ events: Activity[] }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/activity?objectRefId=${encodeURIComponent(id)}&limit=200`,
    ),
    akp<SessionState>(`/v1/sessions/${encodeURIComponent(sessionId)}/state`),
  ]);

  const object = refsResponse.refs.find((ref) => ref.id === id);
  if (!object) notFound();

  const byId = new Map(refsResponse.refs.map((ref) => [ref.id, ref]));
  const relational = activityResponse.events.filter(
    (event) => relatedObjectId(event, object.id) !== null,
  );
  const objectClaims = state.claims.filter(
    (claim) => claim.objectRefId === object.id,
  );
  const contextPackets = state.contextPackets.filter(
    (packet) => packet.objectRefId === object.id,
  );

  return (
    <main>
      <p className="muted">Object-centric workspace · Work object</p>
      <h1>{title(object, object.id)}</h1>
      <p>
        <Link href={`/sessions/${sessionId}`}>
          ← Session {state.session.purpose}
        </Link>
      </p>

      <div className="grid">
        <section className="card">
          <p className="muted">Identity</p>
          <p className="metric">{object.workObjectClass ?? "REFERENCE"}</p>
          <p>
            {object.provider} · {object.objectType} ·{" "}
            <code>{object.externalId}</code>
          </p>
          <p>
            object <code>{short(object.id)}</code>
          </p>
          {object.canonicalUrl ? (
            <p>
              <a href={object.canonicalUrl} target="_blank" rel="noreferrer">
                Open system-of-record reference
              </a>
            </p>
          ) : null}
        </section>

        <section className="card">
          <p className="muted">Authority / revision</p>
          <p className="metric">{object.authority}</p>
          <p>
            source revision <code>{short(object.sourceRevision)}</code>
          </p>
          <p>observed {object.observedAt}</p>
          <p>updated {object.updatedAt}</p>
        </section>

        <section className="card">
          <p className="muted">Workspace context</p>
          <p className="metric">{state.session.workStatus}</p>
          <p>
            context <code>{short(state.session.contextRevisionSetHash)}</code>
          </p>
          <p>{state.contextRevision.status}</p>
        </section>
      </div>

      <h2>Source metadata</h2>
      <section className="card">
        {Object.keys(object.metadata).length ? (
          <table>
            <thead>
              <tr>
                <th>Field</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(object.metadata)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, value]) => (
                  <tr key={key}>
                    <td>{key}</td>
                    <td>
                      <code>{display(value)}</code>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No source metadata projected.</p>
        )}
      </section>

      <h2>Explicit relations</h2>
      <section className="card">
        <p className="muted">
          Sólo aparecen relaciones registradas en Work/Activity. Una correlación
          observada o inferencia de modelo conserva su derivation y no se
          presenta como causalidad probada.
        </p>
        {relational.length ? (
          <table>
            <thead>
              <tr>
                <th>Direction</th>
                <th>Action</th>
                <th>Related object</th>
                <th>Derivation</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {relational.map((event) => {
                const relatedId = relatedObjectId(event, object.id);
                const related = relatedId ? byId.get(relatedId) : undefined;
                return (
                  <tr key={event.id}>
                    <td>{relationDirection(event, object.id)}</td>
                    <td>{event.action}</td>
                    <td>
                      {relatedId && related ? (
                        <Link
                          href={`/work/${relatedId}?sessionId=${sessionId}`}
                        >
                          {title(related, relatedId)}
                        </Link>
                      ) : (
                        <code>{short(relatedId)}</code>
                      )}
                    </td>
                    <td>
                      <span className="badge">{event.derivation}</span>
                    </td>
                    <td>{event.occurredAt}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="muted">No explicit object relations recorded.</p>
        )}
      </section>

      <h2>Agents / claims</h2>
      <section className="card">
        {objectClaims.length ? (
          <table>
            <thead>
              <tr>
                <th>Principal</th>
                <th>Status</th>
                <th>Work key</th>
                <th>Fence</th>
                <th>Lease</th>
              </tr>
            </thead>
            <tbody>
              {objectClaims.map((claim) => (
                <tr key={claim.id}>
                  <td>
                    <code>{short(claim.ownerPrincipalId)}</code>
                  </td>
                  <td>{claim.status}</td>
                  <td>
                    <code>{claim.workKey}</code>
                  </td>
                  <td>{claim.fencingToken}</td>
                  <td>{claim.leaseExpiresAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">
            No claims are explicitly linked to this work object.
          </p>
        )}
      </section>

      <h2>Context packets</h2>
      <section className="card">
        {contextPackets.length ? (
          <table>
            <thead>
              <tr>
                <th>Packet</th>
                <th>Hash</th>
                <th>Corpus revision</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {contextPackets.map((packet) => (
                <tr key={packet.id}>
                  <td>
                    <code>{short(packet.id)}</code>
                  </td>
                  <td>
                    <code>{short(packet.packetHash)}</code>
                  </td>
                  <td>
                    <code>{short(packet.corpusRevision)}</code>
                  </td>
                  <td>{packet.createdAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">
            No context packets are explicitly linked to this work object.
          </p>
        )}
      </section>

      <h2>Activity timeline</h2>
      <section className="card">
        {activityResponse.events.length ? (
          <table>
            <thead>
              <tr>
                <th>Occurred</th>
                <th>Action</th>
                <th>Actor</th>
                <th>Source</th>
                <th>Derivation</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {activityResponse.events.map((event) => (
                <tr key={event.id}>
                  <td>{event.occurredAt}</td>
                  <td>{event.action}</td>
                  <td>
                    <code>
                      {short(event.actorPrincipalId ?? event.actorExternalId)}
                    </code>
                  </td>
                  <td>{event.sourceSystem}</td>
                  <td>
                    <span className="badge">{event.derivation}</span>
                  </td>
                  <td>
                    {event.evidenceRefs.length
                      ? event.evidenceRefs.join(" · ")
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No activity recorded for this object.</p>
        )}
      </section>

      <h2>Activity payloads</h2>
      <div className="grid">
        {activityResponse.events
          .filter((event) => Object.keys(event.payload).length > 0)
          .map((event) => (
            <section className="card" key={event.id}>
              <h3>
                {event.action} · {event.occurredAt}
              </h3>
              <pre>{JSON.stringify(event.payload, null, 2)}</pre>
            </section>
          ))}
      </div>
    </main>
  );
}
