import { akp } from "../../../lib/api";

interface JobEvent {
  id: string | number;
  state: string;
  event_type: string;
  payload?: Record<string, unknown>;
  created_at?: string;
}

interface OutboxEvent {
  event_id: string;
  event_type: string;
  causation_id?: string | null;
  occurred_at?: string;
  deliveries?: Array<{
    consumer?: string;
    status?: string;
    attempts?: number;
    nextAttemptAt?: string | null;
    leaseExpiresAt?: string | null;
    lastError?: unknown;
  }>;
}

interface OperatorJobResponse {
  job: {
    id: string;
    state: string;
    attempts: number;
    max_attempts: number;
    lease_owner?: string | null;
    lease_expires_at?: string | null;
    heartbeat_at?: string | null;
    next_attempt_at?: string | null;
    cancelled_at?: string | null;
    error?: unknown;
    result?: unknown;
    updated_at?: string;
    stage_outputs?: Record<string, unknown>;
  };
  providerTasks: Record<
    string,
    {
      taskId?: string;
      status?: string;
      taskType?: string;
      mode?: string;
      eventTime?: string;
      updatedAt?: string;
      metadata?: Record<string, unknown>;
    }
  >;
  events: JobEvent[];
  outbox: OutboxEvent[];
}

interface FailureSummary {
  code: string;
  message: string;
  stage: string;
  retryable: string;
}

function time(value?: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

function scalar(value: unknown): string | null {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return null;
}

function firstScalar(
  record: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = scalar(record[key]);
    if (value !== null && value.trim()) return value;
  }
  return null;
}

function failureSummary(error: unknown): FailureSummary {
  if (typeof error === "string") {
    return {
      code: "UNSPECIFIED",
      message: error,
      stage: "—",
      retryable: "No reportado",
    };
  }
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return {
      code: "UNSPECIFIED",
      message: "Fallo registrado sin mensaje estructurado.",
      stage: "—",
      retryable: "No reportado",
    };
  }
  const record = error as Record<string, unknown>;
  return {
    code:
      firstScalar(record, ["code", "errorCode", "error_code", "name", "type"]) ??
      "UNSPECIFIED",
    message:
      firstScalar(record, ["message", "detail", "reason", "error"]) ??
      "Fallo registrado sin mensaje estructurado.",
    stage:
      firstScalar(record, ["stage", "phase", "step", "provider"]) ?? "—",
    retryable:
      firstScalar(record, ["retryable", "retriable", "transient"]) ??
      "No reportado",
  };
}

export default async function JobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await akp<OperatorJobResponse>(`/v1/operator/jobs/${id}`);
  const { job } = result;
  const providerEntries = Object.entries(result.providerTasks ?? {});
  const failure = job.error ? failureSummary(job.error) : null;

  return (
    <main>
      <p className="muted">Estado durable, leases, proveedores y outbox</p>
      <h1>Job {id}</h1>
      <p>
        <span className="badge">{job.state}</span>
        {job.cancelled_at ? <span className="badge">CANCELLED</span> : null}
      </p>

      <div className="grid">
        <div className="card">
          <span className="muted">Intentos</span>
          <p className="metric">
            {job.attempts} / {job.max_attempts}
          </p>
        </div>
        <div className="card">
          <span className="muted">Lease owner</span>
          <p>{job.lease_owner ?? "Sin lease activo"}</p>
          <small>expira {time(job.lease_expires_at)}</small>
        </div>
        <div className="card">
          <span className="muted">Heartbeat</span>
          <p>{time(job.heartbeat_at)}</p>
        </div>
        <div className="card">
          <span className="muted">Próximo retry</span>
          <p>{time(job.next_attempt_at)}</p>
        </div>
      </div>

      {failure ? (
        <section className="card" role="alert" style={{ marginTop: 16 }}>
          <h2>Fallo operativo</h2>
          <div className="grid">
            <div>
              <span className="muted">Código</span>
              <p>
                <code>{failure.code}</code>
              </p>
            </div>
            <div>
              <span className="muted">Etapa</span>
              <p>{failure.stage}</p>
            </div>
            <div>
              <span className="muted">Retryable</span>
              <p>{failure.retryable}</p>
            </div>
            <div>
              <span className="muted">Retry durable</span>
              <p>{time(job.next_attempt_at)}</p>
            </div>
          </div>
          <p>
            <strong>{failure.message}</strong>
          </p>
          <p className="muted">
            Intentos consumidos: {job.attempts} de {job.max_attempts}. El estado
            y el próximo retry mostrados aquí provienen del job durable.
          </p>
          <details>
            <summary>Inspeccionar error JSON</summary>
            <pre>{JSON.stringify(job.error, null, 2)}</pre>
          </details>
        </section>
      ) : null}

      <h2>Provider tasks</h2>
      {providerEntries.length ? (
        <table>
          <thead>
            <tr>
              <th>Proveedor</th>
              <th>Task</th>
              <th>Estado</th>
              <th>Modo</th>
              <th>Actualizado</th>
            </tr>
          </thead>
          <tbody>
            {providerEntries.map(([provider, task]) => (
              <tr key={provider}>
                <td>{provider}</td>
                <td>
                  <code>{task.taskId ?? "—"}</code>
                </td>
                <td>{task.status ?? "—"}</td>
                <td>{task.mode ?? "—"}</td>
                <td>{time(task.eventTime ?? task.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">Este job no tiene tareas de proveedor externas.</p>
      )}

      <h2>Historial de transiciones</h2>
      {result.events.length ? (
        <table>
          <thead>
            <tr>
              <th>Evento</th>
              <th>Estado</th>
              <th>Fecha</th>
              <th>Detalle</th>
            </tr>
          </thead>
          <tbody>
            {result.events.map((event) => (
              <tr key={String(event.id)}>
                <td>{event.event_type}</td>
                <td>{event.state}</td>
                <td>{time(event.created_at)}</td>
                <td>
                  <details>
                    <summary>Ver payload</summary>
                    <pre>{JSON.stringify(event.payload ?? {}, null, 2)}</pre>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">Sin eventos persistidos.</p>
      )}

      <h2>Correlación de outbox</h2>
      {result.outbox.length ? (
        result.outbox.map((event) => (
          <article
            className="card"
            key={event.event_id}
            style={{ marginTop: 12 }}
          >
            <h3>{event.event_type}</h3>
            <p className="muted">
              {event.causation_id
                ? `Causado por ${event.causation_id}`
                : "Evento raíz"}{" "}
              · {time(event.occurred_at)}
            </p>
            {(event.deliveries ?? []).length ? (
              <table>
                <thead>
                  <tr>
                    <th>Consumer</th>
                    <th>Estado</th>
                    <th>Intentos</th>
                    <th>Retry/lease</th>
                  </tr>
                </thead>
                <tbody>
                  {event.deliveries?.map((delivery, index) => (
                    <tr key={`${delivery.consumer ?? "delivery"}-${index}`}>
                      <td>{delivery.consumer ?? "—"}</td>
                      <td>{delivery.status ?? "—"}</td>
                      <td>{delivery.attempts ?? 0}</td>
                      <td>
                        retry {time(delivery.nextAttemptAt)} · lease{" "}
                        {time(delivery.leaseExpiresAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">Sin deliveries registrados.</p>
            )}
          </article>
        ))
      ) : (
        <p className="muted">Sin eventos de outbox correlacionados.</p>
      )}

      <details style={{ marginTop: 20 }}>
        <summary>Inspeccionar estado JSON completo</summary>
        <pre>{JSON.stringify(result, null, 2)}</pre>
      </details>
    </main>
  );
}
