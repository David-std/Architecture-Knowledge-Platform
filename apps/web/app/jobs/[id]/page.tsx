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

function time(value?: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
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

      {job.error ? (
        <section className="card" role="alert" style={{ marginTop: 16 }}>
          <h2>Fallo</h2>
          <pre>{JSON.stringify(job.error, null, 2)}</pre>
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
          <article className="card" key={event.event_id} style={{ marginTop: 12 }}>
            <h3>{event.event_type}</h3>
            <p className="muted">
              {event.causation_id ? `Causado por ${event.causation_id}` : "Evento raíz"} · {time(event.occurred_at)}
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
                        retry {time(delivery.nextAttemptAt)} · lease {time(delivery.leaseExpiresAt)}
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
