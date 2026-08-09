import Link from "next/link";
import { akp } from "../../lib/api";

export default async function SourcesPage() {
  const result = await akp<{ sources: Array<Record<string, unknown>> }>(
    "/v1/sources",
  );
  return (
    <main>
      <p className="muted">Objetos crudos inmutables y procedencia</p>
      <h1>Fuentes</h1>
      <div className="card">
        <p>
          Las fuentes se almacenan por SHA-256 en MinIO. Sus extractos no se
          convierten automáticamente en reglas.
        </p>
      </div>
      <table>
        <thead>
          <tr>
            <th>Fuente</th>
            <th>Tipo</th>
            <th>SHA-256</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          {result.sources.map((source) => (
            <tr key={String(source.id)}>
              <td>
                <Link href={`/sources/${source.id}`}>
                  {String(source.title ?? source.id)}
                </Link>
              </td>
              <td>{String(source.media_type ?? "")}</td>
              <td>
                <code>{String(source.sha256).slice(0, 20)}…</code>
              </td>
              <td>{String(source.status)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
