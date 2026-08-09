import { akp } from "../../lib/api";

export default async function EvalsPage() {
  const result = await akp<{ runs: Array<Record<string, unknown>> }>(
    "/v1/evals",
  );
  return (
    <main>
      <p className="muted">Regresión de recuperación y contraejemplos</p>
      <h1>Evaluaciones</h1>
      <pre>{JSON.stringify(result.runs, null, 2)}</pre>
    </main>
  );
}
