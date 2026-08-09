import { akp } from "../../../lib/api";

export default async function AuditPage() {
  const result = await akp<{
    events: Array<Record<string, unknown>>;
    nextBefore: string | null;
  }>("/v1/audit-events?limit=100");
  return (
    <main>
      <p className="muted">Acciones autorizadas, recursos y trazas</p>
      <h1>Auditoría</h1>
      <p>{result.events.length} eventos recientes</p>
      <pre>{JSON.stringify(result.events, null, 2)}</pre>
      {result.nextBefore ? (
        <p className="muted">Continuación: {result.nextBefore}</p>
      ) : null}
    </main>
  );
}
