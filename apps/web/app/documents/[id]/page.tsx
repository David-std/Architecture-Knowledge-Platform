import { akp } from "../../../lib/api";

export default async function DocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const document = await akp<Record<string, unknown>>(
    `/v1/documents/${encodeURIComponent(id)}`,
  );
  return (
    <main>
      <p className="muted">Documento versionado</p>
      <h1>{String(document.title)}</h1>
      <p>
        <span className="badge">{String(document.type)}</span>
        <span className="badge">{String(document.trust_tier)}</span>
      </p>
      <p className="muted">
        {String(document.path)} @ {String(document.current_revision)}
      </p>
      <pre>{String(document.body)}</pre>
      <h2>Relaciones</h2>
      <pre>{JSON.stringify(document.relations, null, 2)}</pre>
    </main>
  );
}
