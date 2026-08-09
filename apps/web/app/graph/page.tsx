import { akp } from "../../lib/api";

export default async function GraphPage() {
  const graph = await akp<Record<string, unknown>>("/v1/graph/summary");
  return (
    <main>
      <p className="muted">Auditoría estructural del grafo</p>
      <h1>Grafo de conocimiento</h1>
      <pre>{JSON.stringify(graph, null, 2)}</pre>
    </main>
  );
}
