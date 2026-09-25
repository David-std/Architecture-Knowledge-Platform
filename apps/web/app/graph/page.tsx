import { akp } from "../../lib/api";
import { selectVault, type VaultOption } from "../../lib/vault-scope";
import { InfoTooltip } from "../components/info-tooltip";
import { GraphExplorer, type OperatorGraph } from "./graph-explorer";

export default async function GraphPage({
  searchParams,
}: {
  searchParams: Promise<{ vaultId?: string; asOf?: string }>;
}) {
  const params = await searchParams;
  const registry = await akp<{ vaults: VaultOption[] }>("/v1/vaults");
  const selection = selectVault(registry.vaults ?? [], params.vaultId);
  const selected = selection.vault;
  const asOf = params.asOf?.trim() ?? "";
  const graphQuery = selected
    ? new URLSearchParams({
        vaultId: selected.id,
        limit: "1000",
        ...(asOf ? { asOf } : {}),
      })
    : null;
  const graph = graphQuery
    ? await akp<OperatorGraph>(`/v1/operator/graph?${graphQuery.toString()}`)
    : null;
  const staleNodes =
    graph?.nodes.filter(
      (node) =>
        !["CURRENT", "FRESH", "READY"].includes(
          String(node.refresh_status).toUpperCase(),
        ),
    ) ?? [];

  return (
    <main style={{ width: "min(1500px, 100%)" }}>
      <p className="muted">
        Explora documentos y sus relaciones dentro del vault autorizado.
      </p>
      <h1>Grafo de conocimiento</h1>
      <form className="card graph-query-card">
        <div className="graph-form-grid">
          <label className="form-field-label">
            <span className="form-label-title">
              Vault
              <InfoTooltip text="Vault de conocimiento autorizado cuyas entidades y caminos tipados se proyectarán." />
            </span>
            <select
              name="vaultId"
              defaultValue={selected?.id ?? ""}
              required
              className="form-select"
            >
              <option value="">Selecciona un vault autorizado</option>
              {(registry.vaults ?? []).map((vault) => (
                <option key={vault.id} value={vault.id}>
                  {vault.name} ({vault.vault_key})
                </option>
              ))}
            </select>
          </label>

          <label className="form-field-label">
            <span className="form-label-title">
              Ver una fecha anterior (opcional)
              <InfoTooltip text="Marca temporal ISO-8601 opcional para explorar la proyección histórica del grafo en ese instante de tiempo." />
            </span>
            <input
              type="text"
              name="asOf"
              defaultValue={asOf}
              placeholder="2026-09-19T17:12:00-05:00"
              className="form-input"
            />
          </label>
        </div>
        <small className="muted form-field-example">
          Déjalo vacío para ver el estado actual.
        </small>
        <div className="form-actions-row">
          <button type="submit" className="action-button-primary">
            Explorar grafo
          </button>
        </div>
      </form>

      {!selected ? (
        <div className="card" style={{ marginTop: 16 }}>
          No se cargó el grafo: {selection.status}. Selecciona un vault visible
          para mantener la exploración dentro de un scope explícito.
        </div>
      ) : null}

      {graph ? (
        <>
          <p className="muted" role="status">
            {graph.truncated
              ? "Vista incompleta: se alcanzó el límite de 1000 nodos."
              : "Se cargaron todos los documentos importados accesibles de este vault."}{" "}
            Las relaciones proceden de enlaces Markdown resueltos y campos de
            relación declarados; los enlaces sin resolver no aparecen como
            aristas.
          </p>
          {graph.truncated || staleNodes.length ? (
            <section className="card" role="status" style={{ marginTop: 16 }}>
              <strong>Estado del grafo</strong>
              <p>
                {graph.truncated
                  ? "La consulta alcanzó el límite de 1000 nodos. Este grafo no representa el vault completo."
                  : "Se cargaron todos los documentos importados accesibles de este vault."}
              </p>
              <p>
                {staleNodes.length} nodo(s) tienen una revisión pendiente o un
                estado de actualización diferente de actual.
              </p>
            </section>
          ) : null}
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
              <p className="metric">
                {graph.truncated ? "TRUNCATED" : "BOUNDED"}
              </p>
            </div>
            <div className="card">
              <span className="muted">Capas</span>
              <p className="metric">{graph.byLayer.length}</p>
              <small>
                {graph.byLayer
                  .map((entry) => `${entry.graph_domain}:${entry.nodes}`)
                  .join(" · ") || "—"}
              </small>
            </div>
            <div className="card">
              <span className="muted">Temporal mode</span>
              <p className="metric">
                {graph.asOf ? "HISTORICAL SNAPSHOT" : "CURRENT SNAPSHOT"}
              </p>
              {graph.asOf ? (
                <small>
                  Query effective time{" "}
                  <time dateTime={graph.asOf}>{graph.asOf}</time>
                </small>
              ) : (
                <small>No historical as_of filter.</small>
              )}
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
