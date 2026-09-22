import Link from "next/link";
import { notFound } from "next/navigation";
import { akp } from "../../../lib/api";
import {
  compareDependencyPerspectives,
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
  owners: string[];
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
  relationKind: string | null;
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

type SessionEvent = {
  id: string | number;
  event_type: string;
  claim_id: string | null;
  actor_principal_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

type Decision = {
  id: string;
  title: string;
  status: string;
  reviewId: string | null;
  reviewStatus: string | null;
  publishedRevision: string | null;
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
  events: SessionEvent[];
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

  const [refsResponse, activityResponse, state, decisionsResponse] =
    await Promise.all([
      akp<{ refs: ExternalRef[] }>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/external-refs`,
      ),
      akp<{ events: Activity[] }>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/activity?objectRefId=${encodeURIComponent(id)}&limit=200`,
      ),
      akp<SessionState>(`/v1/sessions/${encodeURIComponent(sessionId)}/state`),
      akp<{ decisions: Decision[] }>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/decisions?objectRefId=${encodeURIComponent(id)}`,
      ),
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
  const claimIds = new Set(objectClaims.map((claim) => claim.id));
  const findings = state.events.filter(
    (event) =>
      event.event_type === "FINDING" &&
      Boolean(event.claim_id) &&
      claimIds.has(String(event.claim_id)),
  );
  const terminalActivity = activityResponse.events.filter((event) =>
    ["RESOLVED", "CLOSED"].includes(event.action),
  );
  const relatedObjects = relational.flatMap((event) => {
    const relatedId = relatedObjectId(event, object.id);
    const related = relatedId ? byId.get(relatedId) : undefined;
    return related ? [{ event, related }] : [];
  });
  const linkedCode = relatedObjects.filter(({ related }) =>
    [
      "PULL_REQUEST",
      "CODE_REVIEW",
      "REPOSITORY",
      "BUILD",
      "DEPLOYMENT",
      "TEST_RUN",
    ].includes(String(related.workObjectClass)),
  );
  const isService = object.workObjectClass === "SERVICE";
  const serviceDependencies = relatedObjects.filter(
    ({ event }) => event.relationKind === "DEPENDS_ON",
  );
  const dependencyComparison = compareDependencyPerspectives(
    serviceDependencies.map(({ event, related }) => ({
      relatedId: related.id,
      derivation: event.derivation,
    })),
  );
  const serviceRepositories = relatedObjects.filter(
    ({ event }) => event.relationKind === "CODE_REPOSITORY",
  );
  const serviceIncidents = relatedObjects.filter(
    ({ event }) => event.relationKind === "INCIDENT",
  );
  const serviceRules = relatedObjects.filter(
    ({ event }) => event.relationKind === "RULE",
  );
  const runtimeObservations = activityResponse.events.filter(
    (event) =>
      !event.targetRefId &&
      ["DEPLOYED", "ROLLED_BACK", "UPDATED", "ESCALATED"].includes(
        event.action,
      ),
  );
  const activeClaims = objectClaims.filter(
    (claim) =>
      claim.status === "ACTIVE" &&
      new Date(claim.leaseExpiresAt).getTime() > Date.now(),
  );

  return (
    <main>
      <p className="muted">
        Object-centric workspace · {isService ? "Service" : "Work object"}
      </p>
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

      {isService ? (
        <>
          <h2>Service overview</h2>
          <div className="grid">
            <section className="card">
              <h3>Owners</h3>
              {object.owners.length ? (
                <ul>
                  {object.owners.map((owner) => (
                    <li key={owner}>{owner}</li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No source-provided owners.</p>
              )}
            </section>

            <section className="card">
              <h3>Freshness</h3>
              <p>
                observed {object.observedAt}
                <br />
                updated {object.updatedAt}
                <br />
                source revision <code>{short(object.sourceRevision)}</code>
                <br />
                context {state.contextRevision.status}
              </p>
            </section>

            <section className="card">
              <h3>Open work</h3>
              {activeClaims.length ? (
                <ul>
                  {activeClaims.map((claim) => (
                    <li key={claim.id}>
                      <code>{claim.workKey}</code> · principal{" "}
                      <code>{short(claim.ownerPrincipalId)}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No active claims on this service.</p>
              )}
            </section>
          </div>

          <div className="grid">
            <section className="card">
              <h3>Dependencies</h3>
              {serviceDependencies.length ? (
                <ul>
                  {serviceDependencies.map(({ event, related }) => (
                    <li key={event.id}>
                      <Link href={`/work/${related.id}?sessionId=${sessionId}`}>
                        {title(related, related.id)}
                      </Link>{" "}
                      <span className="badge">{event.derivation}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">
                  No explicit DEPENDS_ON relations recorded.
                </p>
              )}
              <h4>Declared / static / observed comparison</h4>
              {dependencyComparison.length ? (
                <ul>
                  {dependencyComparison.map((row) => {
                    const related = byId.get(row.relatedId);
                    return (
                      <li key={row.relatedId}>
                        {title(related, row.relatedId)} ·{" "}
                        <span className="badge">
                          declared {row.declared ? "yes" : "no"}
                        </span>{" "}
                        <span className="badge">
                          static {row.static ? "yes" : "no"}
                        </span>{" "}
                        <span className="badge">
                          observed {row.observed ? "yes" : "no"}
                        </span>{" "}
                        <span className="badge">{row.status}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="muted">
                  No classified dependency perspectives are available.
                </p>
              )}
              <small className="muted">
                PERSPECTIVE_GAP means the declared, static and runtime views do
                not all report the same dependency. It can represent a real
                disagreement or a perspective that has not observed it yet.
              </small>
            </section>

            <section className="card">
              <h3>Code repositories</h3>
              {serviceRepositories.length ? (
                <ul>
                  {serviceRepositories.map(({ event, related }) => (
                    <li key={event.id}>
                      <Link href={`/work/${related.id}?sessionId=${sessionId}`}>
                        {title(related, related.id)}
                      </Link>{" "}
                      <span className="badge">{event.derivation}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">
                  No explicit CODE_REPOSITORY relations recorded.
                </p>
              )}
            </section>

            <section className="card">
              <h3>Incidents</h3>
              {serviceIncidents.length ? (
                <ul>
                  {serviceIncidents.map(({ event, related }) => (
                    <li key={event.id}>
                      <Link href={`/work/${related.id}?sessionId=${sessionId}`}>
                        {title(related, related.id)}
                      </Link>{" "}
                      <span className="badge">{event.derivation}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">
                  No explicit INCIDENT relations recorded.
                </p>
              )}
            </section>
          </div>

          <div className="grid">
            <section className="card">
              <h3>Runtime observations</h3>
              {runtimeObservations.length ? (
                <ul>
                  {runtimeObservations.map((event) => (
                    <li key={event.id}>
                      <span className="badge">{event.action}</span>{" "}
                      <span className="badge">{event.derivation}</span> ·{" "}
                      {event.occurredAt} · {event.sourceSystem}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">
                  No deployment, rollback, update or escalation observations.
                </p>
              )}
            </section>

            <section className="card">
              <h3>Decisions / rules</h3>
              {decisionsResponse.decisions.length || serviceRules.length ? (
                <ul>
                  {decisionsResponse.decisions.map((decision) => (
                    <li key={decision.id}>
                      <Link
                        href={`/decisions/${decision.id}?sessionId=${sessionId}`}
                      >
                        {decision.title}
                      </Link>{" "}
                      <span className="badge">{decision.status}</span>
                    </li>
                  ))}
                  {serviceRules.map(({ event, related }) => (
                    <li key={event.id}>
                      <Link href={`/work/${related.id}?sessionId=${sessionId}`}>
                        {title(related, related.id)}
                      </Link>{" "}
                      <span className="badge">RULE</span>{" "}
                      <span className="badge">{event.derivation}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">
                  No governed decisions or explicit RULE relations recorded.
                </p>
              )}
            </section>
          </div>
        </>
      ) : null}

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
                <th>Kind</th>
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
                    <td>{event.relationKind ?? "—"}</td>
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

      <h2>Linked code / PR</h2>
      <section className="card">
        {linkedCode.length ? (
          <table>
            <thead>
              <tr>
                <th>Object</th>
                <th>Class</th>
                <th>Relation</th>
                <th>Derivation</th>
              </tr>
            </thead>
            <tbody>
              {linkedCode.map(({ event, related }) => (
                <tr key={event.id}>
                  <td>
                    <Link href={`/work/${related.id}?sessionId=${sessionId}`}>
                      {title(related, related.id)}
                    </Link>
                  </td>
                  <td>{related.workObjectClass}</td>
                  <td>{event.action}</td>
                  <td>
                    <span className="badge">{event.derivation}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">
            No code, PR, review, build or deployment relation is explicitly
            recorded for this object.
          </p>
        )}
      </section>

      <h2>Decisions</h2>
      <section className="card">
        {decisionsResponse.decisions.length ? (
          <table>
            <thead>
              <tr>
                <th>Decision</th>
                <th>Status</th>
                <th>Review / publication</th>
              </tr>
            </thead>
            <tbody>
              {decisionsResponse.decisions.map((decision) => (
                <tr key={decision.id}>
                  <td>
                    <Link
                      href={`/decisions/${decision.id}?sessionId=${sessionId}`}
                    >
                      {decision.title}
                    </Link>
                  </td>
                  <td>{decision.status}</td>
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
          <p className="muted">
            No governed decisions are explicitly linked to this work object.
          </p>
        )}
      </section>

      <h2>Findings</h2>
      <section className="card">
        {findings.length ? (
          <ul>
            {findings.map((finding) => (
              <li key={String(finding.id)}>
                <strong>
                  {display(finding.payload.title) !== "—"
                    ? display(finding.payload.title)
                    : display(finding.payload.summary)}
                </strong>
                <br />
                <small className="muted">
                  event {finding.id} · actor {short(finding.actor_principal_id)}{" "}
                  · {finding.created_at}
                </small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">
            No findings are linked through a fenced claim for this object.
          </p>
        )}
      </section>

      <h2>Outcome</h2>
      <section className="card">
        {terminalActivity.length ? (
          <ul>
            {terminalActivity.map((event) => (
              <li key={event.id}>
                <span className="badge">{event.action}</span>{" "}
                <span className="badge">{event.derivation}</span> ·{" "}
                {event.occurredAt}
                {Object.keys(event.payload).length ? (
                  <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">
            No explicit RESOLVED or CLOSED activity has been recorded.
          </p>
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
