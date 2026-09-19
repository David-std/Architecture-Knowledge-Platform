import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { akp } from "../lib/api";

type WorkObject = {
  id: string;
  provider: string;
  object_type: string;
  external_id: string;
  title?: string | null;
  authority: string;
  source_revision?: string | null;
  work_object_class: string;
  updated_at: string;
};

type Review = {
  id: string;
  status: string;
  created_at: string;
  updated_at: string;
};

type Finding = {
  id: string;
  severity: string;
  category: string;
  detector: string;
  code: string;
  summary: string;
  status: string;
  proposed_action?: string | null;
  last_seen_at: string;
};

type Session = {
  id: string;
  project_id?: string | null;
  purpose: string;
  state: Record<string, unknown>;
  revision_set_hash?: string | null;
  active_participants: number;
  updated_at: string;
};

type Claim = {
  id: string;
  session_id: string;
  work_key: string;
  fencing_token: string | number;
  lease_expires_at: string;
  owner_principal_kind: string;
  owner_principal_label: string;
};

type Handoff = {
  id: string | number;
  session_id: string;
  claim_id?: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

type Freshness = {
  vault_id: string;
  corpus_revision?: string | null;
  lexical_revision?: string | null;
  vector_revision?: string | null;
  graph_revision?: string | null;
  context_pack_revision?: string | null;
  status: string;
  warnings?: unknown[];
  updated_at: string;
};

type WorkspaceHome = {
  generatedAt: string;
  projects: Array<{
    id: string;
    slug: string;
    vault_id: string;
    metadata: Record<string, unknown>;
    created_at: string;
  }>;
  goals: WorkObject[];
  workItems: WorkObject[];
  pullRequests: WorkObject[];
  incidentsAndDeployments: WorkObject[];
  pendingReviews: Review[];
  assuranceFindings: Finding[];
  activeSessions: Session[];
  activeClaims: Claim[];
  recentHandoffs: Handoff[];
  freshness: Freshness[];
  connectors: Array<{
    vault_id: string;
    state: string;
    count: number;
    attention: number;
  }>;
  federation: Array<{
    space_id: string;
    trust_state: string;
    discovery_mode: string;
    count: number;
    last_seen_at?: string | null;
  }>;
};

function display(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "—";
}

function workTitle(item: WorkObject): string {
  return item.title?.trim() || item.external_id;
}

function revisionParity(item: Freshness): boolean {
  const required = [
    item.lexical_revision,
    item.graph_revision,
    item.context_pack_revision,
  ].filter((value): value is string => Boolean(value));
  return (
    Boolean(item.corpus_revision) &&
    required.length === 3 &&
    required.every((value) => value === item.corpus_revision)
  );
}

export default async function Home() {
  let home: WorkspaceHome | null = null;
  let error = "";
  try {
    home = await akp<WorkspaceHome>("/v1/operator/workspace-home");
  } catch (caught) {
    unstable_rethrow(caught);
    error = String(caught);
  }

  if (!home) {
    return (
      <main>
        <p className="muted">Workspace</p>
        <h1>Trabajo actual</h1>
        <div className="card">
          {error ? `Workspace no disponible: ${error}` : "Sin datos."}
        </div>
      </main>
    );
  }

  const activeWork = home.workItems.length + home.goals.length;
  const deliverySignals =
    home.pullRequests.length + home.incidentsAndDeployments.length;
  const connectorAttention = home.connectors.reduce(
    (sum, item) => sum + Number(item.attention ?? 0),
    0,
  );
  const staleIndexes = home.freshness.filter(
    (item) => item.status !== "READY" || !revisionParity(item),
  ).length;

  return (
    <main>
      <p className="muted">
        Contexto de trabajo, decisiones, agentes y salud del conocimiento
      </p>
      <h1>Workspace Home</h1>

      <div className="grid">
        <section className="card">
          <span className="muted">Proyectos / trabajo activo</span>
          <p className="metric">{home.projects.length + activeWork}</p>
        </section>
        <section className="card">
          <span className="muted">Revisiones pendientes</span>
          <p className="metric">{home.pendingReviews.length}</p>
        </section>
        <section className="card">
          <span className="muted">PR / incidentes / despliegues</span>
          <p className="metric">{deliverySignals}</p>
        </section>
        <section className="card">
          <span className="muted">Agentes / claims activos</span>
          <p className="metric">
            {home.activeSessions.length}/{home.activeClaims.length}
          </p>
        </section>
        <section className="card">
          <span className="muted">Findings abiertos</span>
          <p className="metric">{home.assuranceFindings.length}</p>
        </section>
        <section className="card">
          <span className="muted">Salud a revisar</span>
          <p className="metric">{staleIndexes + connectorAttention}</p>
        </section>
      </div>

      <div className="grid" style={{ marginTop: 18 }}>
        <section className="card">
          <h2>Proyectos y objetivos</h2>
          {home.projects.length || home.goals.length ? (
            <ul>
              {home.projects.slice(0, 8).map((project) => (
                <li key={project.id}>
                  <strong>{project.slug}</strong>
                  {typeof project.metadata.commit === "string" ? (
                    <small>
                      {" "}
                      · commit{" "}
                      <code>
                        {String(project.metadata.commit).slice(0, 10)}
                      </code>
                    </small>
                  ) : null}
                </li>
              ))}
              {home.goals.slice(0, 8).map((goal) => (
                <li key={goal.id}>
                  <span className="badge">{goal.work_object_class}</span>{" "}
                  {workTitle(goal)}
                  <small className="muted"> · authority {goal.authority}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Sin proyectos u objetivos activos.</p>
          )}
        </section>

        <section className="card">
          <h2>Trabajo en curso</h2>
          {home.workItems.length ? (
            <ul>
              {home.workItems.slice(0, 12).map((item) => (
                <li key={item.id}>
                  {workTitle(item)}
                  <br />
                  <small>
                    {item.provider} · {item.external_id} · {item.authority}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Sin work items proyectados.</p>
          )}
        </section>

        <section className="card">
          <h2>Decisiones / revisiones</h2>
          {home.pendingReviews.length ? (
            <ul>
              {home.pendingReviews.slice(0, 10).map((review) => (
                <li key={review.id}>
                  <Link href={`/reviews/${review.id}`}>
                    Revisión {review.id.slice(0, 10)}
                  </Link>{" "}
                  <span className="badge">{review.status}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No hay revisiones pendientes.</p>
          )}
          <Link href="/reviews">Abrir Review Workspace →</Link>
        </section>

        <section className="card">
          <h2>PR, incidentes y despliegues</h2>
          {[...home.pullRequests, ...home.incidentsAndDeployments].length ? (
            <ul>
              {[...home.pullRequests, ...home.incidentsAndDeployments]
                .slice(0, 12)
                .map((item) => (
                  <li key={item.id}>
                    <span className="badge">{item.work_object_class}</span>{" "}
                    {workTitle(item)}
                    <br />
                    <small>
                      {item.provider} · revision {display(item.source_revision)}
                    </small>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="muted">Sin señales de delivery recientes.</p>
          )}
        </section>
      </div>

      <h2>Agentes, claims y handoffs</h2>
      <div className="grid">
        <section className="card">
          <h3>Sesiones activas</h3>
          {home.activeSessions.length ? (
            <ul>
              {home.activeSessions.slice(0, 10).map((session) => (
                <li key={session.id}>
                  <strong>{session.purpose}</strong>
                  <br />
                  <small>
                    {session.active_participants} participantes · revision{" "}
                    <code>
                      {session.revision_set_hash?.slice(0, 12) ?? "sin pin"}
                    </code>
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Sin sesiones activas.</p>
          )}
        </section>
        <section className="card">
          <h3>Claims activos</h3>
          {home.activeClaims.length ? (
            <ul>
              {home.activeClaims.slice(0, 12).map((claim) => (
                <li key={claim.id}>
                  <code>{claim.work_key}</code>
                  <br />
                  <small>
                    {claim.owner_principal_kind} · {claim.owner_principal_label}{" "}
                    · fencing {String(claim.fencing_token)} · vence{" "}
                    {claim.lease_expires_at}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Sin claims activos.</p>
          )}
        </section>
        <section className="card">
          <h3>Handoffs recientes</h3>
          {home.recentHandoffs.length ? (
            <ul>
              {home.recentHandoffs.slice(0, 8).map((handoff) => (
                <li key={String(handoff.id)}>
                  sesión <code>{handoff.session_id.slice(0, 10)}</code>
                  <br />
                  <small>{handoff.created_at}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Sin handoffs recientes.</p>
          )}
        </section>
      </div>

      <h2>Assurance y frescura</h2>
      <div className="grid">
        <section className="card">
          <h3>Findings prioritarios</h3>
          {home.assuranceFindings.length ? (
            <ul>
              {home.assuranceFindings.slice(0, 10).map((finding) => (
                <li key={finding.id}>
                  <span className="badge">{finding.severity}</span>{" "}
                  <strong>{finding.code}</strong>
                  <br />
                  {finding.summary}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Sin findings abiertos.</p>
          )}
          <Link href="/admin/assurance">Triage Assurance →</Link>
        </section>

        <section className="card">
          <h3>Context/index freshness</h3>
          {home.freshness.length ? (
            <ul>
              {home.freshness.map((item) => (
                <li key={item.vault_id}>
                  <span
                    className="badge"
                    title={
                      revisionParity(item)
                        ? "Índices requeridos en paridad con corpus"
                        : "Alguna revisión no coincide con el corpus"
                    }
                  >
                    {item.status}
                  </span>{" "}
                  vault <code>{item.vault_id.slice(0, 10)}</code>
                  <br />
                  <small>
                    {revisionParity(item)
                      ? "revisiones en paridad"
                      : "stale/degraded"}
                    {" · "}
                    {item.updated_at}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Sin estado de índices disponible.</p>
          )}
          <Link href="/admin/health">Diagnóstico completo →</Link>
        </section>

        <section className="card">
          <h3>Connectors / federation</h3>
          <p>
            Connectors con atención: <strong>{connectorAttention}</strong>
          </p>
          <p>
            Peers visibles:{" "}
            <strong>
              {home.federation.reduce(
                (sum, item) => sum + Number(item.count ?? 0),
                0,
              )}
            </strong>
          </p>
          <p>
            <Link href="/admin/connectors">Estado de connectors →</Link>
          </p>
        </section>
      </div>

      <p className="muted">Actualizado {home.generatedAt}</p>
    </main>
  );
}
