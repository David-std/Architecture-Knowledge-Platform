import { akp } from "../../lib/api";
import { selectVault, type VaultOption } from "../../lib/vault-scope";
import { GraphExplorer, type OperatorGraph } from "./graph-explorer";

export default async function GraphPage({
  searchParams,
}: {
  searchParams: Promise<{ vaultId?: string }>;
}) {
  const params = await searchParams;
  const registry = await akp<{ vaults: VaultOption[] }>("/v1/vaults");
  const selection = selectVault(registry.vaults ?? [], params.vaultId);
  const selected = selection.vault;
  const graph = selected
    ? await akp<OperatorGraph>(
        `/v1/operator/graph?vaultId=${encodeURIComponent(selected.id)}&limit=180`,
      )
    : null;

  return (
    <main style={{ width: "min(1500px, 100%)" }}>
      <p className="muted">Grafo tipado, caminos e impacto bajo scope autorizado</p>
      <h1>Grafo de conocimiento</h1>
      <form className="card">
        <label>
          Vault
          <select name="vaultId" defaultValue={selected?.id ?? ""} required>
            <option value="">Selecciona un vault autorizado</option>
            {(registry.vaults ?? []).map((vault) => (
              <option key={vault.id} value={vault.id}>
                {vault.name} ({vault.vault_key})
              </option>
            ))}
          </select>
        </label>{" "}
        <button type="submit">Explorar</button>
      </form>

      {!selected ? (
        <div className="card" style={{ marginTop: 16 }}>
          No se cargó el grafo: {selection.status}. Selecciona un vault visible para mantener la exploración dentro de un scope explícito.
        </div>
      ) : null}

      {graph ? (
        <>
          <div className="grid" style={{ marginTop: 16 }}>
            <div className="card">
              <span className="muted">Nodos</span>
              <p className="metric">{graph.nodes.length}</p>
            </div>
            <div className="card">
              <span className="muted">Relaciones</span>
              <p className="metric">{graph.edges.length}</p>
            </div>
            <div className="card">
              <span className="muted">Huérfanos</span>
              <p className="metric">{graph.orphanDocuments}</p>
            </div>
            <div className="card">
              <span className="muted">Cobertura</span>
              <p className="metric">{graph.truncated ? "TRUNCATED" : "BOUNDED"}</p>
            </div>
          </div>

          <h2>Explorador</h2>
          <GraphExplorer graph={graph} />

          <details style={{ marginTop: 20 }}>
            <summary>Inspeccionar JSON del grafo</summary>
            <pre>{JSON.stringify(graph, null, 2)}</pre>
          </details>
        </>
      ) : null}
    </main>
  );
}
