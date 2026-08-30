import Link from "next/link";
import { akp } from "../../lib/api";

export default async function JobsPage() {
  const result = await akp<{ jobs: Array<Record<string, unknown>> }>(
    "/v1/ingest",
  );
  return (
    <main>
      <p className="muted">Cola durable con lease, reintentos y eventos</p>
      <h1>Ingesta</h1>
      <table>
        <thead>
          <tr>
            <th>Job</th>
            <th>Fuente</th>
            <th>Estado</th>
            <th>Intentos</th>
          </tr>
        </thead>
        <tbody>
          {result.jobs.map((job) => (
            <tr key={String(job.id)}>
              <td>
                <Link href={`/jobs/${job.id}`}>{String(job.id)}</Link>
              </td>
              <td>Ruta local omitida por seguridad</td>
              <td>{String(job.state)}</td>
              <td>{String(job.attempts)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
