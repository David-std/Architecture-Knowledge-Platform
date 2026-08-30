import { akp } from "../../../lib/api";

export default async function SourcePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const source = await akp<Record<string, unknown>>(`/v1/sources/${id}`);
  return (
    <main>
      <p className="muted">Fuente inmutable y derivados</p>
      <h1>{String(source.title ?? id)}</h1>
      <p>
        <span className="badge">{String(source.media_type)}</span>
        <span className="badge">{String(source.status)}</span>
      </p>
      <pre>
        {JSON.stringify(
          {
            sha256: source.sha256,
            byteSize: source.byte_size,
            metadata: source.metadata,
          },
          null,
          2,
        )}
      </pre>
      <h2>Artefactos</h2>
      <pre>{JSON.stringify(source.artifacts, null, 2)}</pre>
      <h2>Evidencia</h2>
      <pre>{JSON.stringify(source.evidence, null, 2)}</pre>
    </main>
  );
}
