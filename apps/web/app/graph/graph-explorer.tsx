"use client";

import { useMemo, useRef, useState } from "react";

export interface GraphNode {
  id: string;
  entityId: string;
  nodeSource: "KNOWLEDGE" | "FEDERATED";
  graph_domain: string;
  scope_id: string;
  kind: string;
  canonical_key: string;
  vault_id: string;
  external_id?: string | null;
  path?: string;
  title: string;
  type: string;
  layer?: string;
  lifecycle: string;
  trust_tier: string;
  refresh_status: string;
  current_revision?: string;
  updated_at?: string;
  payload?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  entityId: string;
  edgeSource: "KNOWLEDGE" | "FEDERATED";
  from: string;
  to: string;
  type: string;
  weight?: number | null;
  owner_graph_domain: string;
  derivation?: string | null;
  confidence?: number | null;
  provenance?: unknown;
  provenance_revision?: string | null;
  source_ids?: unknown[];
  evidence_ids?: unknown[];
  locator_refs?: unknown[];
  support_set_id?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
  recorded_at?: string | null;
}

export interface OperatorGraph {
  scope: { vaultIds: string[] };
  asOf: string | null;
  truncated: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  byLayer: Array<{ graph_domain: string; nodes: number }>;
  byRelationType: Array<{ relation_type: string; edges: number }>;
  orphanDocuments: number;
}

interface Position {
  x: number;
  y: number;
}

const VISUAL_NODE_LIMIT = 80;
const CATALOG_PAGE_SIZE = 25;

function graphLayout(nodes: GraphNode[]): Map<string, Position> {
  const result = new Map<string, Position>();
  if (!nodes.length) return result;
  const centerX = 480;
  const centerY = 340;
  const radius = Math.max(180, Math.min(300, nodes.length * 8));
  nodes.forEach((node, index) => {
    const angle = (index / nodes.length) * Math.PI * 2 - Math.PI / 2;
    const ring = 0.72 + (index % 3) * 0.14;
    result.set(node.id, {
      x: centerX + Math.cos(angle) * radius * ring,
      y: centerY + Math.sin(angle) * radius * ring,
    });
  });
  return result;
}

function shortestPath(
  seed: string,
  target: string,
  edges: GraphEdge[],
): { nodes: Set<string>; edges: Set<string> } {
  if (!seed || !target) return { nodes: new Set(), edges: new Set() };
  if (seed === target) return { nodes: new Set([seed]), edges: new Set() };
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }
  const queue = [seed];
  const parent = new Map<string, { node: string; edge: GraphEdge }>();
  const seen = new Set([seed]);
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of outgoing.get(current) ?? []) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      parent.set(edge.to, { node: current, edge });
      if (edge.to === target) {
        const pathNodes = new Set<string>([target]);
        const pathEdges = new Set<string>();
        let cursor = target;
        while (cursor !== seed) {
          const step = parent.get(cursor);
          if (!step) break;
          pathNodes.add(step.node);
          pathEdges.add(step.edge.id);
          cursor = step.node;
        }
        return { nodes: pathNodes, edges: pathEdges };
      }
      queue.push(edge.to);
    }
  }
  return { nodes: new Set(), edges: new Set() };
}

function impactTraversal(
  seed: string,
  depth: number,
  edges: GraphEdge[],
): Set<string> {
  if (!seed) return new Set();
  const result = new Set<string>([seed]);
  let frontier = new Set<string>([seed]);
  for (let level = 0; level < depth; level += 1) {
    const next = new Set<string>();
    for (const edge of edges) {
      if (frontier.has(edge.from) && !result.has(edge.to)) {
        result.add(edge.to);
        next.add(edge.to);
      }
    }
    frontier = next;
    if (!frontier.size) break;
  }
  return result;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function GraphExplorer({ graph }: { graph: OperatorGraph }) {
  const layers = useMemo(
    () => [...new Set(graph.nodes.map((node) => node.graph_domain))].sort(),
    [graph.nodes],
  );
  const relationTypes = useMemo(
    () => [...new Set(graph.edges.map((edge) => edge.type))].sort(),
    [graph.edges],
  );
  const trustTiers = useMemo(
    () => [...new Set(graph.nodes.map((node) => node.trust_tier))].sort(),
    [graph.nodes],
  );
  const freshnessStates = useMemo(
    () => [...new Set(graph.nodes.map((node) => node.refresh_status))].sort(),
    [graph.nodes],
  );
  const [enabledLayers, setEnabledLayers] = useState<Set<string>>(
    () => new Set(layers),
  );
  const [enabledRelations, setEnabledRelations] = useState<Set<string>>(
    () => new Set(relationTypes),
  );
  const [trust, setTrust] = useState("ALL");
  const [freshness, setFreshness] = useState("ALL");
  const [selectedId, setSelectedId] = useState(graph.nodes[0]?.id ?? "");
  const [targetId, setTargetId] = useState("");
  const [impactDepth, setImpactDepth] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [catalogPage, setCatalogPage] = useState(1);
  const dragging = useRef<{
    x: number;
    y: number;
    panX: number;
    panY: number;
  } | null>(null);

  const filteredNodes = useMemo(
    () =>
      graph.nodes.filter(
        (node) =>
          enabledLayers.has(node.graph_domain) &&
          (trust === "ALL" || node.trust_tier === trust) &&
          (freshness === "ALL" || node.refresh_status === freshness),
      ),
    [graph.nodes, enabledLayers, trust, freshness],
  );
  const visibleNodeIds = useMemo(
    () => new Set(filteredNodes.map((node) => node.id)),
    [filteredNodes],
  );
  const filteredEdges = useMemo(
    () =>
      graph.edges.filter(
        (edge) =>
          enabledLayers.has(edge.owner_graph_domain) &&
          enabledRelations.has(edge.type) &&
          visibleNodeIds.has(edge.from) &&
          visibleNodeIds.has(edge.to),
      ),
    [graph.edges, enabledLayers, enabledRelations, visibleNodeIds],
  );
  const visualNodes = useMemo(() => {
    const bounded = filteredNodes.slice(0, VISUAL_NODE_LIMIT);
    const included = new Set(bounded.map((node) => node.id));
    for (const candidateId of [selectedId, targetId]) {
      if (!candidateId || included.has(candidateId)) continue;
      const candidate = filteredNodes.find((node) => node.id === candidateId);
      if (!candidate) continue;
      if (bounded.length >= VISUAL_NODE_LIMIT) {
        const removed = bounded.pop();
        if (removed) included.delete(removed.id);
      }
      bounded.push(candidate);
      included.add(candidate.id);
    }
    return bounded;
  }, [filteredNodes, selectedId, targetId]);
  const visualNodeIds = useMemo(
    () => new Set(visualNodes.map((node) => node.id)),
    [visualNodes],
  );
  const visualEdges = useMemo(
    () =>
      filteredEdges.filter(
        (edge) =>
          visualNodeIds.has(edge.from) && visualNodeIds.has(edge.to),
      ),
    [filteredEdges, visualNodeIds],
  );
  const positions = useMemo(() => graphLayout(visualNodes), [visualNodes]);
  const catalogPageCount = Math.max(
    1,
    Math.ceil(filteredNodes.length / CATALOG_PAGE_SIZE),
  );
  const effectiveCatalogPage = Math.min(catalogPage, catalogPageCount);
  const catalogNodes = filteredNodes.slice(
    (effectiveCatalogPage - 1) * CATALOG_PAGE_SIZE,
    effectiveCatalogPage * CATALOG_PAGE_SIZE,
  );
  const selected = graph.nodes.find((node) => node.id === selectedId) ?? null;
  const selectedPayload = selected?.payload ?? {};
  const path = useMemo(
    () => shortestPath(selectedId, targetId, filteredEdges),
    [selectedId, targetId, filteredEdges],
  );
  const impact = useMemo(
    () => impactTraversal(selectedId, impactDepth, filteredEdges),
    [selectedId, impactDepth, filteredEdges],
  );
  const pathEdges = useMemo(
    () => filteredEdges.filter((edge) => path.edges.has(edge.id)),
    [filteredEdges, path.edges],
  );
  const derivationSummary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of filteredEdges) {
      const key = edge.derivation ?? "LEGACY_RELATION";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1]);
  }, [filteredEdges]);

  function toggleLayer(layer: string) {
    setEnabledLayers((current) => {
      const next = new Set(current);
      if (next.has(layer)) next.delete(layer);
      else next.add(layer);
      return next;
    });
  }

  function toggleRelation(type: string) {
    setEnabledRelations((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  return (
    <div>
      <div className="grid">
        <section className="card">
          <h3>Filtros de nodos</h3>
          <label>
            Trust
            <select
              value={trust}
              onChange={(event) => setTrust(event.target.value)}
            >
              <option value="ALL">Todos</option>
              {trustTiers.map((tier) => (
                <option key={tier} value={tier}>
                  {tier}
                </option>
              ))}
            </select>
          </label>{" "}
          <label>
            Freshness
            <select
              value={freshness}
              onChange={(event) => setFreshness(event.target.value)}
            >
              <option value="ALL">Todos</option>
              {freshnessStates.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </select>
          </label>
          <div style={{ marginTop: 12 }}>
            <strong>Capas</strong>
            <br />
            {layers.map((layer) => (
              <label
                key={layer}
                style={{ marginRight: 10, display: "inline-block" }}
              >
                <input
                  type="checkbox"
                  checked={enabledLayers.has(layer)}
                  onChange={() => toggleLayer(layer)}
                  style={{ minWidth: 0, width: "auto" }}
                />{" "}
                {layer}
              </label>
            ))}
          </div>
        </section>
        <section className="card">
          <h3>Camino / impacto</h3>
          <label>
            Target
            <select
              value={targetId}
              onChange={(event) => setTargetId(event.target.value)}
            >
              <option value="">Sin target</option>
              {filteredNodes
                .filter((node) => node.id !== selectedId)
                .map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.title}
                  </option>
                ))}
            </select>
          </label>{" "}
          <label>
            Impact depth
            <select
              value={impactDepth}
              onChange={(event) => setImpactDepth(Number(event.target.value))}
            >
              {[1, 2, 3].map((depth) => (
                <option key={depth} value={depth}>
                  {depth}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">
            {targetId
              ? path.nodes.size
                ? `Camino dirigido encontrado: ${path.nodes.size} nodos.`
                : "No existe camino dirigido visible entre seed y target."
              : `${impact.size} nodos en el impacto saliente visible.`}
          </p>
        </section>
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        <h3>Relaciones</h3>
        {relationTypes.map((type) => (
          <label
            key={type}
            style={{ marginRight: 12, display: "inline-block" }}
          >
            <input
              type="checkbox"
              checked={enabledRelations.has(type)}
              onChange={() => toggleRelation(type)}
              style={{ minWidth: 0, width: "auto" }}
            />{" "}
            {type}
          </label>
        ))}
      </section>

      <div className="grid" style={{ marginTop: 16 }}>
        <section className="card">
          <h3>Why connected?</h3>
          {!targetId ? (
            <p className="muted">
              Selecciona un target para inspeccionar el camino y su provenance.
            </p>
          ) : pathEdges.length ? (
            <ol>
              {pathEdges.map((edge) => (
                <li key={edge.id}>
                  <strong>{edge.type}</strong> ·{" "}
                  {edge.derivation ?? "LEGACY_RELATION"}
                  {edge.confidence !== null && edge.confidence !== undefined
                    ? ` · confidence ${edge.confidence}`
                    : ""}
                  <br />
                  <small>
                    revision {edge.provenance_revision ?? "—"} · support{" "}
                    {edge.support_set_id ?? "—"}
                  </small>
                  <details>
                    <summary>Provenance / evidence</summary>
                    <pre>
                      {JSON.stringify(
                        {
                          provenance: edge.provenance,
                          sourceIds: edge.source_ids ?? [],
                          evidenceIds: edge.evidence_ids ?? [],
                          locatorRefs: edge.locator_refs ?? [],
                          validFrom: edge.valid_from ?? null,
                          validTo: edge.valid_to ?? null,
                          recordedAt: edge.recorded_at ?? null,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">No hay camino dirigido visible.</p>
          )}
        </section>
        <section className="card">
          <h3>Derivación visible</h3>
          {derivationSummary.length ? (
            <ul>
              {derivationSummary.map(([derivation, count]) => (
                <li key={derivation}>
                  {derivation}: {count}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Sin aristas visibles.</p>
          )}
          <small>
            SOURCE_EXPLICIT/HUMAN_ASSERTED = declarado · STATICALLY_RESOLVED =
            estático · RUNTIME_OBSERVED/DYNAMICALLY_PROVEN = observado.
          </small>
        </section>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(260px, 340px)",
          gap: 16,
          marginTop: 16,
        }}
      >
        <section className="card" style={{ padding: 8, overflow: "hidden" }}>
          <div style={{ display: "flex", gap: 8, padding: 8 }}>
            <button
              type="button"
              aria-label="Acercar grafo"
              title="Acercar"
              onClick={() => setZoom((value) => clamp(value * 1.2, 0.4, 2.5))}
            >
              +
            </button>
            <button
              type="button"
              aria-label="Alejar grafo"
              title="Alejar"
              onClick={() => setZoom((value) => clamp(value / 1.2, 0.4, 2.5))}
            >
              −
            </button>
            <button
              type="button"
              aria-label="Centrar grafo"
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
            >
              Centrar
            </button>
            <span className="muted" aria-live="polite">
              {Math.round(zoom * 100)}%
            </span>
          </div>
          <p id="graph-render-status" className="muted" role="status">
            Render visual: {visualNodes.length} de {filteredNodes.length} nodos
            filtrados · {visualEdges.length} de {filteredEdges.length} relaciones.
            Los cálculos de camino e impacto usan todo el set filtrado.
            {filteredNodes.length > VISUAL_NODE_LIMIT
              ? " Usa el catálogo paginado para seleccionar nodos fuera del presupuesto visual inicial."
              : ""}
          </p>
          <svg
            viewBox="0 0 960 680"
            role="img"
            aria-label="Grafo de conocimiento interactivo"
            aria-describedby="graph-render-status"
            style={{
              width: "100%",
              minHeight: 560,
              cursor: dragging.current ? "grabbing" : "grab",
            }}
            onWheel={(event) => {
              event.preventDefault();
              setZoom((value) =>
                clamp(value * (event.deltaY < 0 ? 1.08 : 0.92), 0.4, 2.5),
              );
            }}
            onPointerDown={(event) => {
              dragging.current = {
                x: event.clientX,
                y: event.clientY,
                panX: pan.x,
                panY: pan.y,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const origin = dragging.current;
              if (!origin) return;
              setPan({
                x: origin.panX + (event.clientX - origin.x) / zoom,
                y: origin.panY + (event.clientY - origin.y) / zoom,
              });
            }}
            onPointerUp={(event) => {
              dragging.current = null;
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
          >
            <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
              {visualEdges.map((edge) => {
                const from = positions.get(edge.from);
                const to = positions.get(edge.to);
                if (!from || !to) return null;
                const highlighted = path.edges.has(edge.id);
                const impacted = impact.has(edge.from) && impact.has(edge.to);
                return (
                  <g key={edge.id}>
                    <line
                      x1={from.x}
                      y1={from.y}
                      x2={to.x}
                      y2={to.y}
                      stroke={
                        highlighted
                          ? "var(--accent)"
                          : impacted
                            ? "#7f8fb3"
                            : "#394768"
                      }
                      strokeWidth={highlighted ? 4 : impacted ? 2 : 1}
                      opacity={highlighted || impacted ? 1 : 0.62}
                    />
                    <text
                      x={(from.x + to.x) / 2}
                      y={(from.y + to.y) / 2 - 4}
                      fill="#9eacc9"
                      fontSize="10"
                      textAnchor="middle"
                    >
                      {edge.type}
                    </text>
                  </g>
                );
              })}
              {visualNodes.map((node) => {
                const position = positions.get(node.id);
                if (!position) return null;
                const selectedNode = node.id === selectedId;
                const onPath = path.nodes.has(node.id);
                const impacted = impact.has(node.id);
                return (
                  <g
                    key={node.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Seleccionar ${node.title}`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => setSelectedId(node.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ")
                        setSelectedId(node.id);
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    <circle
                      cx={position.x}
                      cy={position.y}
                      r={selectedNode ? 15 : 11}
                      fill={
                        onPath
                          ? "var(--accent)"
                          : impacted
                            ? "#7f8fb3"
                            : "#19233c"
                      }
                      stroke={selectedNode ? "#edf2ff" : "#70d6c1"}
                      strokeWidth={selectedNode ? 3 : 1.5}
                    />
                    <text
                      x={position.x}
                      y={position.y + 27}
                      fill="#edf2ff"
                      fontSize="11"
                      textAnchor="middle"
                    >
                      {node.title.length > 24
                        ? `${node.title.slice(0, 22)}…`
                        : node.title}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        </section>

        <aside className="card">
          <h2>Detalle de nodo</h2>
          {selected ? (
            <>
              <h3>{selected.title}</h3>
              <p>
                <span className="badge">{selected.type}</span>
                <span className="badge">{selected.trust_tier}</span>
                <span className="badge">{selected.lifecycle}</span>
                <span className="badge">{selected.refresh_status}</span>
              </p>
              <dl>
                <dt className="muted">ID</dt>
                <dd>
                  <code>{selected.id}</code>
                </dd>
                <dt className="muted">Layer / domain</dt>
                <dd>
                  {selected.layer ?? "—"} · {selected.graph_domain}
                </dd>
                <dt className="muted">Source / kind</dt>
                <dd>
                  {selected.nodeSource} · {selected.kind}
                </dd>
                <dt className="muted">Scope</dt>
                <dd>
                  <code>{selected.scope_id}</code>
                </dd>
                <dt className="muted">Canonical key</dt>
                <dd>
                  <code>{selected.canonical_key}</code>
                </dd>
                <dt className="muted">File / line</dt>
                <dd>
                  {typeof selectedPayload.path === "string"
                    ? selectedPayload.path
                    : (selected.path ?? "—")}
                  {typeof selectedPayload.lineStart === "number"
                    ? `:${selectedPayload.lineStart}`
                    : ""}
                  {typeof selectedPayload.lineEnd === "number"
                    ? `-${selectedPayload.lineEnd}`
                    : ""}
                </dd>
                <dt className="muted">Revision</dt>
                <dd>
                  <code>{selected.current_revision ?? "—"}</code>
                </dd>
                <dt className="muted">Actualizado</dt>
                <dd>
                  {selected.updated_at
                    ? new Date(selected.updated_at).toLocaleString()
                    : "—"}
                </dd>
              </dl>
              {selected.nodeSource === "KNOWLEDGE" ? (
                <a href={`/documents/${selected.entityId}`}>Abrir documento</a>
              ) : null}
              <p className="muted">
                Click en otro nodo cambia el seed. El resaltado de impacto sigue
                relaciones salientes hasta la profundidad seleccionada.
              </p>
            </>
          ) : (
            <p className="muted">Selecciona un nodo.</p>
          )}
        </aside>
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>Catálogo de nodos</h2>
        <p className="muted">
          Página {effectiveCatalogPage} de {catalogPageCount} ·{" "}
          {filteredNodes.length} nodos filtrados. Seleccionar un nodo lo mantiene
          dentro del presupuesto visual aunque quede fuera de los primeros{" "}
          {VISUAL_NODE_LIMIT}.
        </p>
        {catalogNodes.length ? (
          <>
            <table>
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Domain</th>
                  <th>Type</th>
                  <th>Freshness</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {catalogNodes.map((node) => (
                  <tr key={node.id}>
                    <td>{node.title}</td>
                    <td>{node.graph_domain}</td>
                    <td>{node.type}</td>
                    <td>{node.refresh_status}</td>
                    <td>
                      <button
                        type="button"
                        aria-pressed={node.id === selectedId}
                        onClick={() => setSelectedId(node.id)}
                      >
                        {node.id === selectedId ? "Seleccionado" : "Seleccionar"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="inline-actions" style={{ marginTop: 12 }}>
              <button
                type="button"
                disabled={effectiveCatalogPage <= 1}
                onClick={() =>
                  setCatalogPage(Math.max(1, effectiveCatalogPage - 1))
                }
              >
                ← Anterior
              </button>
              <button
                type="button"
                disabled={effectiveCatalogPage >= catalogPageCount}
                onClick={() =>
                  setCatalogPage(
                    Math.min(catalogPageCount, effectiveCatalogPage + 1),
                  )
                }
              >
                Siguiente →
              </button>
            </div>
          </>
        ) : (
          <p className="muted" role="status">
            No hay nodos que coincidan con los filtros actuales.
          </p>
        )}
      </section>
    </div>
  );
}
