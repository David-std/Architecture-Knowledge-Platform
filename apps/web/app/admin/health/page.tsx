import { akp } from "../../../lib/api";

interface HealthResponse {
  status: string;
  services: {
    database?: { ok?: boolean };
    rawStore?: { ok?: boolean; status?: number | null };
    extractor?: { ok?: boolean; status?: number | null };
  };
  providers?: {
    capabilities?: Array<Record<string, unknown>>;
    adapters?: Array<{
      adapter?: string;
      status?: string;
      reason?: string | null;
      local?: boolean;
      ocr?: boolean;
      transcription?: boolean;
    }>;
    routing?: Record<string, unknown>;
  } | null;
  indexes: Array<{
    vault_id: string;
    corpus_revision?: string | null;
    lexical_revision?: string | null;
    vector_revision?: string | null;
    graph_revision?: string | null;
    context_pack_revision?: string | null;
    status?: string;
    warnings?: string[];
    retrieval_configuration_version?: string;
  }>;
  outbox: Array<{ status: string; count: number }>;
  stuckJobs: Array<{
    id: string;
    vault_id: string;
    state: string;
    attempts: number;
    max_attempts: number;
    lease_owner?: string | null;
    lease_expires_at?: string | null;
    next_attempt_at?: string | null;
    updated_at?: string;
    error?: unknown;
  }>;
}

function serviceBadge(ok?: boolean): string {
  return ok ? "UP" : "DEGRADED";
}

function parity(index: HealthResponse["indexes"][number]): {
  status: string;
  detail: string;
} {
  const corpus = index.corpus_revision;
  const tracked = [
    ["lexical", index.lexical_revision],
    ["vector", index.vector_revision],
    ["graph", index.graph_revision],
    ["context", index.context_pack_revision],
  ] as const;
  const mismatches = tracked
    .filter(([, revision]) => revision && corpus && revision !== corpus)
    .map(([name]) => name);
  const missing = tracked
    .filter(([, revision]) => !revision)
    .map(([name]) => name);
  if (mismatches.length) {
    return { status: "MISMATCH", detail: `Distintos: ${mismatches.join(", ")}` };
  }
  if (missing.length) {
    return { status: "PARTIAL", detail: `Sin revisión: ${missing.join(", ")}` };
  }
  return { status: "ALIGNED", detail: "Corpus e índices reportan la misma revisión." };
}

export default async function HealthPage() {
  const [health, errors] = await Promise.all([
    akp<HealthResponse>("/v1/operator/health"),
    akp<Record<string, unknown>>("/v1/error-book"),
  ]);
  const pending = health.outbox.find((entry) => entry.status === "PENDING")?.count ?? 0;
  const retry = health.outbox.find((entry) => entry.status === "RETRY")?.count ?? 0;
  const quarantined =
    health.outbox.find((entry) => entry.status === "QUARANTINED")?.count ?? 0;
  const adapters = health.providers?.adapters ?? [];

  return (
    <main>
      <p className="muted">Servicios, providers, paridad de índices y trabajo durable</p>
      <h1>Salud operativa</h1>
      <p>
        <span className="badge">{health.status}</span>
      </p>

      <div className="grid">
        <section className="card">
          <span className="muted">Database</span>
          <p className="metric">{serviceBadge(health.services.database?.ok)}</p>
        </section>
        <section className="card">
          <span className="muted">Raw store</span>
          <p className="metric">{serviceBadge(health.services.rawStore?.ok)}</p>
          <small>HTTP {health.services.rawStore?.status ?? "—"}</small>
        </section>
        <section className="card">
          <span className="muted">Extractor</span>
          <p className="metric">{serviceBadge(health.services.extractor?.ok)}</p>
          <small>HTTP {health.services.extractor?.status ?? "—"}</small>
        </section>
        <section className="card">
          <span className="muted">Stuck jobs</span>
          <p className="metric">{health.stuckJobs.length}</p>
        </section>
      </div>

      <h2>Document Intelligence providers</h2>
      {adapters.length ? (
        <table>
          <thead>
            <tr>
              <th>Adapter</th>
              <th>Estado</th>
              <th>Local</th>
              <th>Capacidades</th>
              <th>Razón</th>
            </tr>
          </thead>
          <tbody>
            {adapters.map((adapter, index) => (
              <tr key={`${adapter.adapter ?? "adapter"}-${index}`}>
                <td>{adapter.adapter ?? "—"}</td>
                <td>{adapter.status ?? "UNKNOWN"}</td>
                <td>{adapter.local ? "sí" : "no"}</td>
                <td>
                  {adapter.ocr ? <span className="badge">OCR</span> : null}
                  {adapter.transcription ? (
                    <span className="badge">TRANSCRIPT</span>
                  ) : null}
                </td>
                <td>{adapter.reason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="card">El extractor no reportó capacidades de proveedor.</p>
      )}

      <h2>Paridad corpus / índices</h2>
      {health.indexes.length ? (
        <table>
          <thead>
            <tr>
              <th>Vault</th>
              <th>Estado</th>
              <th>Paridad</th>
              <th>Corpus</th>
              <th>Lexical</th>
              <th>Vector</th>
              <th>Graph</th>
              <th>Context</th>
            </tr>
          </thead>
          <tbody>
            {health.indexes.map((index) => {
              const indexParity = parity(index);
              return (
                <tr key={index.vault_id}>
                  <td>
                    <code>{index.vault_id.slice(0, 8)}</code>
                  </td>
                  <td>{index.status ?? "UNKNOWN"}</td>
                  <td>
                    <span className="badge">{indexParity.status}</span>
                    <br />
                    <small>{indexParity.detail}</small>
                  </td>
                  <td>{index.corpus_revision?.slice(0, 10) ?? "—"}</td>
                  <td>{index.lexical_revision?.slice(0, 10) ?? "—"}</td>
                  <td>{index.vector_revision?.slice(0, 10) ?? "—"}</td>
                  <td>{index.graph_revision?.slice(0, 10) ?? "—"}</td>
                  <td>{index.context_pack_revision?.slice(0, 10) ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="muted">No hay revisiones de índices visibles.</p>
      )}

      <h2>Outbox</h2>
      <div className="grid">
        <div className="card">
          <span className="muted">Pending</span>
          <p className="metric">{pending}</p>
        </div>
        <div className="card">
          <span className="muted">Retry</span>
          <p className="metric">{retry}</p>
        </div>
        <div className="card">
          <span className="muted">Quarantine</span>
          <p className="metric">{quarantined}</p>
        </div>
      </div>

      <h2>Jobs atascados</h2>
      {health.stuckJobs.length ? (
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Estado</th>
              <th>Intentos</th>
              <th>Lease / retry</th>
              <th>Última actualización</th>
            </tr>
          </thead>
          <tbody>
            {health.stuckJobs.map((job) => (
              <tr key={job.id}>
                <td>
                  <a href={`/jobs/${job.id}`}>{job.id.slice(0, 8)}</a>
                </td>
                <td>{job.state}</td>
                <td>
                  {job.attempts}/{job.max_attempts}
                </td>
                <td>
                  lease {job.lease_expires_at ?? "—"}
                  <br />
                  retry {job.next_attempt_at ?? "—"}
                </td>
                <td>{job.updated_at ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="card">No se detectaron jobs atascados en el scope autorizado.</p>
      )}

      <div className="grid" style={{ marginTop: 20 }}>
        <section className="card">
          <h2>OpenTelemetry</h2>
          <p>
            <span className="badge">P7_PENDING</span>
          </p>
          <p className="muted">
            P6 no infiere export saludable a partir de variables o APIs. El estado de exportación real se mostrará cuando P7 conecte SDK/exporter/Collector.
          </p>
        </section>
        <section className="card">
          <h2>Backup recency</h2>
          <p>
            <span className="badge">NOT_REPORTED</span>
          </p>
          <p className="muted">
            El runtime actual ejecuta backup/restore gates, pero no persiste una marca canónica de último backup para esta vista.
          </p>
        </section>
      </div>

      <details style={{ marginTop: 20 }}>
        <summary>Error Book</summary>
        <pre>{JSON.stringify(errors, null, 2)}</pre>
      </details>
      <details>
        <summary>Inspeccionar health JSON</summary>
        <pre>{JSON.stringify(health, null, 2)}</pre>
      </details>
    </main>
  );
}
