import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { akp } from "../lib/api";

type WorkObject = {
  id: string;
  provider: string;
  external_id: string;
  title?: string | null;
  authority: string;
  work_object_class: string;
};

type Review = {
  id: string;
  status: string;
  updated_at: string;
};

type Finding = {
  id: string;
  severity: string;
  code: string;
  summary: string;
  last_seen_at: string;
};

type Session = {
  id: string;
  purpose: string;
  active_participants: number;
  updated_at: string;
};

type Freshness = {
  vault_id: string;
  corpus_revision?: string | null;
  lexical_revision?: string | null;
  graph_revision?: string | null;
  context_pack_revision?: string | null;
  status: string;
  updated_at: string;
};

type WorkspaceHome = {
  generatedAt: string;
  projects: Array<{ id: string }>;
  goals: WorkObject[];
  workItems: WorkObject[];
  pullRequests: WorkObject[];
  incidentsAndDeployments: WorkObject[];
  pendingReviews: Review[];
  assuranceFindings: Finding[];
  activeSessions: Session[];
  activeClaims: Array<{ id: string }>;
  recentHandoffs: Array<{ id: string | number }>;
  freshness: Freshness[];
  connectors: Array<{ attention: number }>;
};

const severityRank: Record<string, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

function dateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("es", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

function workTitle(item: WorkObject): string {
  return item.title?.trim() || item.external_id;
}

function revisionParity(item: Freshness): boolean {
  return Boolean(
    item.corpus_revision &&
    item.lexical_revision === item.corpus_revision &&
    item.graph_revision === item.corpus_revision &&
    item.context_pack_revision === item.corpus_revision,
  );
}

export default async function Home() {
  let home: WorkspaceHome | null = null;
  try {
    home = await akp<WorkspaceHome>("/v1/operator/workspace-home");
  } catch (caught) {
    unstable_rethrow(caught);
  }

  if (!home) {
    return (
      <main className="workspace-home">
        <div className="home-header">
          <div>
            <h1>Inicio</h1>
            <p className="page-desc">Consola local del operador</p>
          </div>
        </div>
        <div className="empty-panel" role="status">
          <h2>No se pudo conectar con el espacio de trabajo</h2>
          <p>
            Comprueba que la sesión esté iniciada y el servicio local de AKP
            esté activo.
          </p>
          <Link href="/login" className="action-button-primary">
            Iniciar sesión
          </Link>
        </div>
      </main>
    );
  }

  const findings = [...home.assuranceFindings].sort(
    (left, right) =>
      (severityRank[left.severity.toUpperCase()] ?? 4) -
        (severityRank[right.severity.toUpperCase()] ?? 4) ||
      right.last_seen_at.localeCompare(left.last_seen_at),
  );

  const groupedFindings = [
    ...findings
      .reduce((groups, finding) => {
        const key = `${finding.severity}\u0000${finding.code}\u0000${finding.summary}`;
        const group = groups.get(key);
        if (group) group.count += 1;
        else groups.set(key, { finding, count: 1 });
        return groups;
      }, new Map<string, { finding: Finding; count: number }>())
      .values(),
  ];

  const unhealthy = home.freshness.filter(
    (item) => item.status !== "READY" || !revisionParity(item),
  );
  const connectorAttention = home.connectors.reduce(
    (sum, item) => sum + Number(item.attention ?? 0),
    0,
  );
  const delivery = [...home.pullRequests, ...home.incidentsAndDeployments];
  const totalVaults = home.freshness.length;
  const synchronizedVaults = totalVaults - unhealthy.length;
  const parityPercentage =
    totalVaults > 0
      ? Math.round((synchronizedVaults / totalVaults) * 100)
      : 100;

  return (
    <main className="workspace-home">
      {/* Workspace Header */}
      <div className="home-header">
        <div className="home-title-group">
          <h1>Consola de operaciones</h1>
          <p className="page-desc">
            Supervisión activa del flujo de trabajo, paridad de vaults y
            gobernanza del conocimiento canónico.
          </p>
        </div>

        <div className="home-header-actions">
          <Link className="action-button-outline" href="/search">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <span>Buscar conocimiento</span>
            <kbd className="search-kbd">⌘K</kbd>
          </Link>
          <Link className="action-button-primary" href="/author">
            <span>Proponer conocimiento</span>
          </Link>
        </div>
      </div>

      {/* Grounded Metric Cards with Context and Explicit Verbs */}
      <section
        aria-label="Indicadores clave de operación"
        className="metrics-grid"
      >
        <div className="metric-card">
          <div className="metric-card-top">
            <span className="metric-label">Revisiones pendientes</span>
            <span
              className={`metric-status-badge ${
                home.pendingReviews.length > 0 ? "warning" : "ok"
              }`}
            >
              {home.pendingReviews.length > 0
                ? `${home.pendingReviews.length} por resolver`
                : "Al día"}
            </span>
          </div>
          <div className="metric-value-row">
            <span className="metric-number">{home.pendingReviews.length}</span>
            <span className="metric-context">
              Propuestas de cambio sobre el Markdown canónico
            </span>
          </div>
          <div className="metric-card-bottom">
            <Link href="/reviews" className="metric-action-btn">
              Atender revisiones
            </Link>
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-card-top">
            <span className="metric-label">Hallazgos registrados</span>
            <span
              className={`metric-status-badge ${
                findings.length > 0 ? "warning" : "ok"
              }`}
            >
              {findings.length > 0
                ? `${findings.length} anomalías`
                : "Sin alertas"}
            </span>
          </div>
          <div className="metric-value-row">
            <span className="metric-number">{findings.length}</span>
            <span className="metric-context">
              Inconsistencias en identidades, esquemas o confianza
            </span>
          </div>
          <div className="metric-card-bottom">
            <Link href="/admin/assurance" className="metric-action-btn">
              Auditar hallazgos
            </Link>
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-card-top">
            <span className="metric-label">Paridad de vaults</span>
            <span
              className={`metric-status-badge ${
                unhealthy.length === 0 ? "ok" : "warning"
              }`}
            >
              {parityPercentage}% sincronizado
            </span>
          </div>
          <div className="metric-value-row">
            <span className="metric-number">
              {synchronizedVaults}
              <span className="metric-total"> / {totalVaults}</span>
            </span>
            <span className="metric-context">
              Consistencia entre Git canónico, Postgres y vectores
            </span>
          </div>
          {/* Visual parity progress meter */}
          <div
            className="parity-meter"
            role="progressbar"
            aria-valuenow={parityPercentage}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Porcentaje de paridad"
          >
            <div
              className={`parity-fill ${unhealthy.length === 0 ? "full" : ""}`}
              style={{ width: `${parityPercentage}%` }}
            />
          </div>
          <div className="metric-card-bottom">
            <Link href="/admin/health" className="metric-action-btn">
              Diagnosticar salud
            </Link>
          </div>
        </div>
      </section>

      {/* Main Operational Flow Grid */}
      <div className="operational-layout-grid">
        {/* Left Column: Attention & Pending Decisions */}
        <div className="operational-primary-col">
          {/* Section: Revisiones pendientes con affordance explícito */}
          <section
            className="operational-panel"
            aria-labelledby="reviews-title"
          >
            <div className="panel-header">
              <div>
                <h2 id="reviews-title">Revisiones de conocimiento</h2>
                <p className="panel-desc">
                  Propuestas recibidas que esperan validación antes de
                  publicarse en el repositorio canónico.
                </p>
              </div>
              <Link href="/reviews" className="panel-aux-link">
                Ver todas ({home.pendingReviews.length})
              </Link>
            </div>

            {home.pendingReviews.length ? (
              <div className="actionable-item-list">
                {home.pendingReviews.slice(0, 5).map((review) => (
                  <article key={review.id} className="actionable-item-card">
                    <div className="item-icon-wrapper" aria-hidden="true">
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                        <line x1="9" y1="15" x2="15" y2="15" />
                      </svg>
                    </div>

                    <div className="item-content">
                      <div className="item-title-row">
                        <span className="item-title">
                          Revisión {review.id.slice(0, 8)}
                        </span>
                        <span className="item-status-pill">
                          {review.status.toLowerCase()}
                        </span>
                      </div>
                      <p className="item-meta">
                        Última modificación: {dateLabel(review.updated_at)}
                      </p>
                    </div>

                    <div className="item-action-wrapper">
                      <Link
                        href={`/reviews/${review.id}`}
                        className="item-action-button"
                      >
                        Revisar propuesta
                      </Link>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="panel-empty-state">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="m9 12 2 2 4-4" />
                </svg>
                <p>No hay propuestas pendientes de revisión.</p>
                <Link href="/author" className="empty-action-link">
                  Crear nueva propuesta
                </Link>
              </div>
            )}
          </section>

          {/* Section: Hallazgos de Aseguramiento */}
          <section
            className="operational-panel"
            aria-labelledby="findings-title"
          >
            <div className="panel-header">
              <div>
                <h2 id="findings-title">Hallazgos de aseguramiento</h2>
                <p className="panel-desc">
                  Reglas de validación, identidades ambiguas o límites de
                  confianza señalados por el runtime.
                </p>
              </div>
              <Link href="/admin/assurance" className="panel-aux-link">
                Auditar ({findings.length})
              </Link>
            </div>

            {groupedFindings.length ? (
              <div className="actionable-item-list">
                {groupedFindings.slice(0, 5).map(({ finding, count }) => {
                  const severityClass = finding.severity.toLowerCase();
                  return (
                    <article key={finding.id} className="actionable-item-card">
                      <div
                        className={`item-icon-wrapper severity-${severityClass}`}
                        aria-hidden="true"
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                          <line x1="12" y1="9" x2="12" y2="13" />
                          <line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                      </div>

                      <div className="item-content">
                        <div className="item-title-row">
                          <span className="item-title">{finding.summary}</span>
                          <span className={`severity-badge ${severityClass}`}>
                            {finding.severity.toLowerCase()}
                          </span>
                        </div>
                        <p className="item-meta">
                          <code>{finding.code}</code>
                          {count > 1 ? ` · ${count} ocurrencias` : ""}
                          {" · "}
                          {dateLabel(finding.last_seen_at)}
                        </p>
                      </div>

                      <div className="item-action-wrapper">
                        <Link
                          href="/admin/assurance"
                          className="item-action-button outline"
                        >
                          Examinar
                        </Link>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="panel-empty-state">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="m9 12 2 2 4-4" />
                </svg>
                <p>
                  Todos los vaults cumplen con las directrices de aseguramiento.
                </p>
              </div>
            )}
          </section>
        </div>

        {/* Right Column: Active Sessions, Vault Freshness & External Activity */}
        <div className="operational-secondary-col">
          {/* Card: Salud de Vaults e Índices */}
          <section className="side-card" aria-labelledby="vaults-health-title">
            <div className="side-card-header">
              <h3 id="vaults-health-title">Estado de índices</h3>
              <Link href="/admin/health" className="side-link">
                Diagnóstico
              </Link>
            </div>
            <p className="side-card-desc">
              Sincronización de índices léxicos, semánticos y grafos.
            </p>

            {unhealthy.length > 0 ? (
              <ul className="side-entry-list">
                {unhealthy.slice(0, 3).map((item) => (
                  <li key={item.vault_id} className="side-entry-row alert">
                    <div className="side-entry-main">
                      <span className="side-entry-name">
                        Vault {item.vault_id.slice(0, 8)}
                      </span>
                      <span className="side-entry-sub">
                        Falta paridad · {dateLabel(item.updated_at)}
                      </span>
                    </div>
                    <Link href="/admin/health" className="side-action-btn">
                      Reparar
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="status-banner ok">
                <span className="status-dot green" aria-hidden="true" />
                <span>
                  Todos los vaults ({totalVaults}) mantienen paridad estricta.
                </span>
              </div>
            )}

            {connectorAttention > 0 && (
              <div className="connector-alert-strip">
                <div>
                  <strong>Conectores externos</strong>
                  <p>{connectorAttention} evento(s) requieren atención.</p>
                </div>
                <Link
                  href="/admin/connectors"
                  className="side-action-btn outline"
                >
                  Gestionar
                </Link>
              </div>
            )}
          </section>

          {/* Card: Sesiones activas del equipo */}
          <section className="side-card" aria-labelledby="sessions-title">
            <div className="side-card-header">
              <h3 id="sessions-title">Sesiones activas</h3>
              <Link href="/admin/team" className="side-link">
                Equipo
              </Link>
            </div>
            <p className="side-card-desc">
              Espacios de trabajo colaborativo concurrentes.
            </p>

            {home.activeSessions.length > 0 ? (
              <ul className="side-entry-list">
                {home.activeSessions.slice(0, 4).map((session) => (
                  <li key={session.id} className="side-entry-row">
                    <div className="side-entry-main">
                      <span className="side-entry-name">{session.purpose}</span>
                      <span className="side-entry-sub">
                        <span className="live-dot" aria-hidden="true" />
                        {session.active_participants} participante(s) ·{" "}
                        {dateLabel(session.updated_at)}
                      </span>
                    </div>
                    <Link
                      href={`/sessions/${session.id}`}
                      className="side-action-btn"
                    >
                      Ver
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="side-empty-text">
                No hay sesiones de trabajo activas en este momento.
              </p>
            )}
          </section>

          {/* Card: Objetivos y tareas */}
          <section className="side-card" aria-labelledby="work-title">
            <div className="side-card-header">
              <h3 id="work-title">Objetivos en curso</h3>
              <Link href="/decisions" className="side-link">
                Decisiones
              </Link>
            </div>
            <p className="side-card-desc">
              Objetivos y elementos de trabajo proyectados.
            </p>

            {home.goals.length || home.workItems.length ? (
              <ul className="side-entry-list">
                {[...home.goals, ...home.workItems].slice(0, 4).map((item) => (
                  <li key={item.id} className="side-entry-row">
                    <div className="side-entry-main">
                      <span className="side-entry-name">{workTitle(item)}</span>
                      <span className="side-entry-sub">
                        {item.work_object_class.toLowerCase()} ·{" "}
                        {item.authority}
                      </span>
                    </div>
                    <Link href={`/work/${item.id}`} className="side-action-btn">
                      Detalle
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="side-empty-text">Sin tareas activas asignadas.</p>
            )}
          </section>

          {/* Card: Despliegues y solicitudes externas */}
          {delivery.length > 0 && (
            <section className="side-card" aria-labelledby="delivery-title">
              <div className="side-card-header">
                <h3 id="delivery-title">Actividad externa</h3>
              </div>
              <ul className="side-entry-list">
                {delivery.slice(0, 3).map((item) => (
                  <li key={item.id} className="side-entry-row">
                    <div className="side-entry-main">
                      <span className="side-entry-name">{workTitle(item)}</span>
                      <span className="side-entry-sub">
                        {item.work_object_class.toLowerCase()} · {item.provider}
                      </span>
                    </div>
                    <Link href={`/work/${item.id}`} className="side-action-btn">
                      Ver
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>

      {/* Grounded Summary Strip */}
      <footer className="workspace-footer-strip">
        <div className="footer-summary-group">
          <span className="summary-pill">
            <strong>{home.projects.length}</strong> proyectos
          </span>
          <span className="summary-pill">
            <strong>{home.activeClaims.length}</strong> claims
          </span>
          <span className="summary-pill">
            <strong>{home.recentHandoffs.length}</strong> traspasos
          </span>
        </div>

        <nav className="footer-quick-links" aria-label="Enlaces del sistema">
          <Link href="/sources">Fuentes</Link>
          <span className="crumb-sep">·</span>
          <Link href="/graph">Grafo relacional</Link>
          <span className="crumb-sep">·</span>
          <Link href="/admin/audit">Auditoría</Link>
          <span className="crumb-sep">·</span>
          <Link href="/admin/health">Salud</Link>
        </nav>
      </footer>
    </main>
  );
}
