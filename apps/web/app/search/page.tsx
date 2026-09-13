import Link from "next/link";
import { akp, akpOptional } from "../../lib/api";
import {
  scopedSearchRequest,
  selectVault,
  type VaultOption,
} from "../../lib/vault-scope";

const intents = [
  "EXACT_LOOKUP",
  "CONCEPTUAL",
  "COMPARISON",
  "WORKFLOW_EXECUTION",
  "SOURCE_VERIFICATION",
  "PROJECT_CODE",
  "GLOBAL_SYNTHESIS",
  "IMPACT_ANALYSIS",
  "NO_RETRIEVAL_REQUIRED",
] as const;

interface FusionContribution {
  channel: string;
  rank: number;
  channelWeight: number;
  reason: string;
}

interface SearchHit {
  documentId: string;
  title: string;
  type: string;
  trust: string;
  lifecycle: string;
  refreshStatus: string;
  score: number;
  excerpt: string;
  reasons: string[];
  citations: string[];
  warnings?: string[];
  fusionContributions?: FusionContribution[];
}

interface SearchResponse {
  intent: string;
  plan?: {
    requestedIntent?: string;
    channels?: string[];
    omittedChannels?: string[];
  };
  channels: string[];
  warnings: string[];
  degraded: boolean;
  hits: SearchHit[];
  noAnswer: {
    status?: string;
    reason: string;
    searchedChannels?: string[];
    gaps?: string[];
    conflicts?: string[];
    recommendedActions?: string[];
    guidance: string;
  } | null;
}

interface EvidenceProjection {
  evidence: Array<{
    id: string;
    path: string;
    title: string;
    current_revision: string;
  }>;
  locators: Array<{
    id: string;
    source_id: string;
    source_title?: string;
    locator: Record<string, unknown>;
  }>;
}

interface ContextSection {
  kind: string;
  title?: string;
  content: string;
  documentId?: string;
  selectionReason?: string;
  retrievalChannels?: string[];
  sourceOrEvidenceIds?: string[];
}

interface ContextPacket {
  status?: string;
  intent?: string;
  searchedChannels?: string[];
  budget?: {
    maxTokens?: number;
    usedTokens?: number;
    contentTokens?: number;
    metadataTokens?: number;
    serializedTokens?: number;
    tokenizer?: { label?: string; approximate?: boolean };
  };
  sections?: ContextSection[];
  gaps?: string[];
  conflicts?: string[];
  requiredActions?: string[];
  recommendedActions?: string[];
  continuations?: Array<{
    handle?: string;
    reason?: string;
    remainingTokens?: number;
  }>;
  [key: string]: unknown;
}

function evidenceLocatorLabel(locator: Record<string, unknown>): string {
  const parts = [
    locator.kind ? String(locator.kind) : "evidence",
    typeof locator.page === "number" ? `p.${locator.page}` : null,
    typeof locator.sheet === "string" ? `sheet ${locator.sheet}` : null,
    typeof locator.startLine === "number"
      ? `lines ${locator.startLine}-${String(locator.endLine ?? "?")}`
      : null,
    typeof locator.startMs === "number"
      ? `${locator.startMs}-${String(locator.endMs ?? "?")} ms`
      : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

function tokenSummary(packet: ContextPacket): string {
  const used = packet.budget?.usedTokens ?? packet.budget?.serializedTokens;
  const maximum = packet.budget?.maxTokens;
  return used !== undefined && maximum !== undefined
    ? `${used} / ${maximum}`
    : "No disponible";
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; vaultId?: string; intent?: string }>;
}) {
  const params = await searchParams;
  const query = params.q?.trim() ?? "";
  const requestedIntent = intents.includes(
    params.intent as (typeof intents)[number],
  )
    ? params.intent
    : undefined;
  const registry = await akp<{ vaults: VaultOption[] }>("/v1/vaults");
  const selection = selectVault(registry.vaults ?? [], params.vaultId);
  const selected = selection.vault;
  const commonRequest =
    query && selected
      ? scopedSearchRequest(query, selected, {
          ...(requestedIntent ? { intent: requestedIntent } : {}),
          mode: "SOURCE_BACKED",
        })
      : null;
  const result =
    commonRequest && selected
      ? await akp<SearchResponse>("/v1/search", {
          method: "POST",
          body: JSON.stringify({ ...commonRequest, limit: 20 }),
        })
      : null;
  const packet =
    commonRequest && selected
      ? await akp<ContextPacket>("/v1/context", {
          method: "POST",
          body: JSON.stringify({ ...commonRequest, maxTokens: 1600 }),
        })
      : null;
  const evidenceEntries = result
    ? await Promise.all(
        result.hits
          .filter((hit) => hit.citations.length > 0)
          .map(
            async (hit) =>
              [
                hit.documentId,
                await akpOptional<EvidenceProjection>(
                  `/v1/documents/${encodeURIComponent(hit.documentId)}/evidence`,
                ),
              ] as const,
          ),
      )
    : [];
  const evidenceByDocument = new Map(evidenceEntries);

  return (
    <main>
      <p className="muted">Consulta, fusión, evidencia y contexto operativo</p>
      <h1>Búsqueda híbrida</h1>
      <form className="card">
        <div className="grid">
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
          </label>
          <label>
            Intent solicitado
            <select name="intent" defaultValue={requestedIntent ?? ""}>
              <option value="">Detección automática</option>
              {intents.map((intent) => (
                <option key={intent} value={intent}>
                  {intent}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p>
          <input
            name="q"
            defaultValue={query}
            placeholder="Pregunta o ID estable"
            aria-label="Consulta"
          />{" "}
          <button type="submit">Buscar</button>
        </p>
      </form>

      {query && !selected ? (
        <div className="card" role="alert">
          La consulta no se ejecutó: {selection.status}.
        </div>
      ) : null}

      {result ? (
        <section>
          <h2>Plan efectivo</h2>
          <div className="grid">
            <div className="card">
              <span className="muted">Consulta</span>
              <p>{query}</p>
            </div>
            <div className="card">
              <span className="muted">Intent efectivo</span>
              <p className="metric" style={{ fontSize: "1.1rem" }}>
                {result.intent}
              </p>
              {requestedIntent ? (
                <small>Solicitado: {requestedIntent}</small>
              ) : (
                <small>Detectado por planner</small>
              )}
            </div>
            <div className="card">
              <span className="muted">Canales efectivos</span>
              <p>
                {result.channels.map((channel) => (
                  <span className="badge" key={channel}>
                    {channel}
                  </span>
                ))}
              </p>
            </div>
            <div className="card">
              <span className="muted">Estado</span>
              <p>
                <span className="badge">
                  {result.degraded ? "DEGRADED" : "SUPPORTED"}
                </span>
              </p>
              <small>
                {result.warnings.join(" · ") || "Sin degradaciones"}
              </small>
            </div>
          </div>
        </section>
      ) : null}

      {result?.noAnswer ? (
        <section className="card" role="status" style={{ marginTop: 16 }}>
          <h2>Conocimiento insuficiente</h2>
          <strong>{result.noAnswer.reason}</strong>
          <p>{result.noAnswer.guidance}</p>
          {(result.noAnswer.gaps ?? []).map((gap) => (
            <p className="muted" key={gap}>
              Gap: {gap}
            </p>
          ))}
          {(result.noAnswer.recommendedActions ?? []).map((action) => (
            <p key={action}>Acción recomendada: {action}</p>
          ))}
        </section>
      ) : null}

      {result?.hits.length ? <h2>Resultados rankeados</h2> : null}
      {result?.hits.map((hit, index) => {
        const evidence = evidenceByDocument.get(hit.documentId);
        return (
          <article
            className="card"
            key={hit.documentId}
            style={{ marginTop: 16 }}
          >
            <p className="muted">
              #{index + 1} · score {hit.score.toFixed(4)}
            </p>
            <h3>
              <Link href={`/documents/${hit.documentId}`}>{hit.title}</Link>
            </h3>
            <p>
              <span className="badge">{hit.type}</span>
              <span className="badge">{hit.trust}</span>
              <span className="badge">{hit.lifecycle}</span>
              <span className="badge">freshness {hit.refreshStatus}</span>
            </p>
            <p>{hit.excerpt}</p>
            <p className="muted">{hit.reasons.join(" · ")}</p>
            {hit.fusionContributions?.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Canal</th>
                    <th>Rank</th>
                    <th>Peso</th>
                    <th>Razón RRF</th>
                  </tr>
                </thead>
                <tbody>
                  {hit.fusionContributions.map((contribution) => (
                    <tr key={`${hit.documentId}-${contribution.channel}`}>
                      <td>{contribution.channel}</td>
                      <td>{contribution.rank}</td>
                      <td>{contribution.channelWeight}</td>
                      <td>{contribution.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            <div>
              <strong>Citaciones/evidencia:</strong>
              {(evidence?.evidence.length ?? 0) > 0 ||
              (evidence?.locators.length ?? 0) > 0 ? (
                <>
                  <ul>
                    {evidence?.evidence.map((citation) => (
                      <li key={`document-${citation.id}`}>
                        <Link href={`/documents/${citation.id}`}>
                          {citation.title || citation.path}
                        </Link>{" "}
                        <small className="muted">
                          {citation.path}@{citation.current_revision}
                        </small>
                      </li>
                    ))}
                    {evidence?.locators.map((locator) => (
                      <li key={`evidence-${locator.id}`}>
                        <Link href={`/sources/${locator.source_id}`}>
                          {locator.source_title ||
                            `evidencia ${locator.id.slice(0, 8)}`}
                        </Link>{" "}
                        <small className="muted">
                          {evidenceLocatorLabel(locator.locator)}
                        </small>
                      </li>
                    ))}
                  </ul>
                  <small className="muted">
                    Referencias del ranking: {hit.citations.join(" · ")}
                  </small>
                </>
              ) : (
                <p className="muted">
                  {hit.citations.length
                    ? hit.citations.join(" · ")
                    : "Sin referencias"}
                </p>
              )}
            </div>
            {hit.warnings?.length ? (
              <p className="muted">Warnings: {hit.warnings.join(" · ")}</p>
            ) : null}
          </article>
        );
      })}

      {packet ? (
        <section>
          <h2>ContextPacket</h2>
          <div className="grid">
            <div className="card">
              <span className="muted">Estado</span>
              <p>{packet.status ?? "UNKNOWN"}</p>
            </div>
            <div className="card">
              <span className="muted">Presupuesto</span>
              <p>{tokenSummary(packet)} tokens</p>
              <small>
                {packet.budget?.tokenizer?.label ?? "tokenizer desconocido"}
                {packet.budget?.tokenizer?.approximate ? " · aproximado" : ""}
              </small>
            </div>
            <div className="card">
              <span className="muted">Canales buscados</span>
              <p>{(packet.searchedChannels ?? []).join(" · ") || "—"}</p>
            </div>
          </div>

          {(packet.sections ?? []).map((section, index) => (
            <article
              className="card"
              key={`${section.kind}-${index}`}
              style={{ marginTop: 16 }}
            >
              <p>
                <span className="badge">{section.kind}</span>
                {(section.retrievalChannels ?? []).map((channel) => (
                  <span className="badge" key={channel}>
                    {channel}
                  </span>
                ))}
              </p>
              <h3>
                {section.documentId ? (
                  <Link href={`/documents/${section.documentId}`}>
                    {section.title ?? section.documentId}
                  </Link>
                ) : (
                  (section.title ?? `Sección ${index + 1}`)
                )}
              </h3>
              <p>{section.content}</p>
              <small>{section.selectionReason ?? ""}</small>
            </article>
          ))}

          <div className="grid" style={{ marginTop: 16 }}>
            <div className="card">
              <h3>Gaps</h3>
              {(packet.gaps ?? []).length ? (
                <ul>
                  {packet.gaps?.map((gap) => (
                    <li key={gap}>{gap}</li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Sin gaps reportados.</p>
              )}
            </div>
            <div className="card">
              <h3>Conflictos</h3>
              {(packet.conflicts ?? []).length ? (
                <ul>
                  {packet.conflicts?.map((conflict) => (
                    <li key={conflict}>{conflict}</li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Sin conflictos reportados.</p>
              )}
            </div>
          </div>

          {(packet.continuations ?? []).length ? (
            <div className="card" style={{ marginTop: 16 }}>
              <h3>Continuaciones</h3>
              <ul>
                {packet.continuations?.map((continuation, index) => (
                  <li key={continuation.handle ?? index}>
                    <code>{continuation.handle ?? "continuation"}</code> —{" "}
                    {continuation.reason ?? "más contexto disponible"}
                    {continuation.remainingTokens !== undefined
                      ? ` · ${continuation.remainingTokens} tokens restantes`
                      : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <details style={{ marginTop: 16 }}>
            <summary>Inspeccionar JSON del ContextPacket</summary>
            <pre>{JSON.stringify(packet, null, 2)}</pre>
          </details>
        </section>
      ) : null}
    </main>
  );
}
