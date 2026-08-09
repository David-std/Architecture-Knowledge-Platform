import { akp } from "../../../lib/api";

export default async function HealthPage() {
  const [status, indexes, errors] = await Promise.all([
    akp<Record<string, unknown>>("/v1/status"),
    akp<Record<string, unknown>>("/v1/indexes"),
    akp<Record<string, unknown>>("/v1/error-book"),
  ]);
  return (
    <main>
      <p className="muted">Salud, revisiones de índices y Error Book</p>
      <h1>Salud operativa</h1>
      <h2>Runtime</h2>
      <pre>{JSON.stringify(status, null, 2)}</pre>
      <h2>Índices</h2>
      <pre>{JSON.stringify(indexes, null, 2)}</pre>
      <h2>Error Book</h2>
      <pre>{JSON.stringify(errors, null, 2)}</pre>
    </main>
  );
}
