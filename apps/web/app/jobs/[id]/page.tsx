import { akp } from "../../../lib/api";

export default async function JobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const job = await akp<Record<string, unknown>>(`/v1/ingest/${id}`);
  return (
    <main>
      <p className="muted">Trazabilidad de ingesta</p>
      <h1>Job {id}</h1>
      <pre>{JSON.stringify(job, null, 2)}</pre>
    </main>
  );
}
