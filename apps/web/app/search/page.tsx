import Link from "next/link";
import { akp, akpOptional } from "../../lib/api";
import { InfoTooltip } from "../components/info-tooltip";
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

const intentLabels: Record<(typeof intents)[number], string> = {
  EXACT_LOOKUP: "Encontrar un ID, nombre o alias exacto",
  CONCEPTUAL: "Explorar un concepto",
  COMPARISON: "Comparar fuentes o afirmaciones",
  WORKFLOW_EXECUTION: "Encontrar pasos de un proceso",
  SOURCE_VERIFICATION: "Verificar una afirmación contra sus fuentes",
  PROJECT_CODE: "Buscar contexto de código",
  GLOBAL_SYNTHESIS: "Reunir contexto amplio del vault",
  IMPACT_ANALYSIS: "Explorar impacto y dependencias",
  NO_RETRIEVAL_REQUIRED: "No recuperar conocimiento",
};

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

export interface SearchResponse {
  intent: string;
  plan?: {
    requestedIntent?: string;
    channels?: string[];
    omittedChannels?: string[];
  };
  channels: string[];
  warnings: string[];
  degraded: boolean;
  retrievalOutcome?: "SUPPORTED" | "EXPLORATORY_ONLY" | "NO_CANDIDATES";
  hits: SearchHit[];
  exploratoryHits?: SearchHit[];
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

export function searchResultPresentation(result: SearchResponse): {
  supportedCount: number;
  exploratoryCount: number;
  outcome: "SUPPORTED" | "EXPLORATORY_ONLY" | "NO_CANDIDATES";
} {
  const exploratoryCount = result.exploratoryHits?.length ?? 0;
  const outcome =
    result.retrievalOutcome ??
    (result.hits.length > 0
      ? "SUPPORTED"
      : exploratoryCount > 0
        ? "EXPLORATORY_ONLY"
        : "NO_CANDIDATES");
  return {
    supportedCount: result.hits.length,
    exploratoryCount,
    outcome,
  };
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
    tokenizer?: {
      label?: string;
      quality?: "EXACT" | "APPROXIMATE";
      approximate?: boolean;
    };
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
  retrievalConfiguration?: {
    reasoning?: {
      requested?: "DIRECT" | "PLAN";
      execution?: "DIRECT" | "PLAN" | "DIRECT_FALLBACK";
      trace?: unknown;
    };
    warnings?: string[];
  };
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
  searchParams: Promise<{
    q?: string;
    vaultId?: string;
    intent?: string;
    reasoningMode?: string;
  }>;
}) {
  const params = await searchParams;
  const query = params.q?.trim() ?? "";
  const requestedIntent = intents.includes(
    params.intent as (typeof intents)[number],
  )
    ? params.intent
    : undefined;
  const requestedReasoningMode =
    params.reasoningMode === "PLAN" ? "PLAN" : "DIRECT";
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
          body: JSON.stringify({
            ...commonRequest,
            maxTokens: 1600,
            reasoningMode: requestedReasoningMode,
          }),
        })
      : null;
  const presentation = result ? searchResultPresentation(result) : null;
  const exploratoryHits = result?.exploratoryHits ?? [];
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
      <p className="muted">
        Recupera documentos y evidencia autorizados. Esta vista encuentra
        fuentes; no genera ni simula una respuesta final del modelo.
      </p>
      <h1>Encontrar fuentes</h1>
      <form className="card search-form-card">
        <div className="search-form-grid">
          <label className="form-field-label">
            <span className="form-label-title">
              Vault
              <InfoTooltip text="Repositorio de conocimiento autorizado donde se ejecutará la recuperación híbrida." />
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
          <details className="search-advanced-control">
            <summary>Opciones avanzadas de búsqueda</summary>
            <label className="form-field-label">
              <span className="form-label-title">Tipo de consulta</span>
              <select
                name="intent"
                defaultValue={requestedIntent ?? ""}
                className="form-select"
              >
                <option value="">Detección automática</option>
                {intents.map((intent) => (
                  <option key={intent} value={intent}>
                    {intentLabels[intent]}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field-label">
              <span className="form-label-title">
                Ejecución de razonamiento
              </span>
              <select
                name="reasoningMode"
                defaultValue={requestedReasoningMode}
                className="form-select"
              >
                <option value="DIRECT">Directa determinista</option>
                <option value="PLAN">Planner acotado con fallback</option>
              </select>
            </label>
          </details>
        </div>
        <div className="search-input-block">
          <label className="form-field-label">
            <span className="form-label-title">
              Consulta de conocimiento
              <InfoTooltip text="Escribe una pregunta en lenguaje natural o un identificador canónico exacto (ej: RULE-AUTH-001) para recuperar evidencia contextual." />
            </span>
            <div className="search-input-row">
              <input
                name="q"
                defaultValue={query}
                placeholder="Pregunta en lenguaje natural o ID canónico de documento…"
                aria-label="Consulta"
                className="search-query-input"
              />
              <button
                type="submit"
                className="action-button-primary search-submit-btn"
              >
                Buscar
              </button>
            </div>
          </label>
          <small className="muted form-field-example">
            Ejemplo sustancial: &quot;¿Cuáles son las políticas de idempotencia
            y outbox?&quot; o por ID estable <code>RULE-EVENT-001</code>
          </small>
        </div>
      </form>

      {query && !selected ? (
        <div className="card" role="alert">
          La consulta no se ejecutó: {selection.status}.
        </div>
      ) : null}

      {result && !result.noAnswer ? (
        <section className="card" role="status" style={{ marginTop: 16 }}>
          <h2>
            {result.hits.length ? "Fuentes encontradas" : "Sin coincidencias"}
          </h2>
          <p>
            {result.degraded
              ? "La recuperación tuvo cobertura parcial. Revisa los límites antes de usar estas fuentes."
              : "Estas fuentes son candidatos autorizados para inspección; su posición no equivale a verdad o aprobación."}
          </p>
        </section>
      ) : null}

      {result ? (
        <details className="card" style={{ marginTop: 16 }}>
          <summary>Inspeccionar diagnóstico técnico de recuperación</summary>
          <div className="grid" style={{ marginTop: 12 }}>
            <div className="card">
              <span className="muted">Consulta</span>
              <p>{query}</p>
            </div>
            <div className="card">
              <span className="muted">Intent efectivo</span>
              <p>{result.intent}</p>
              <small>
                {requestedIntent
                  ? `Solicitado: ${requestedIntent}`
                  : "Detectado por planner"}
              </small>
            </div>
            <div className="card">
              <span className="muted">Canales efectivos</span>
              <p>{result.channels.join(" · ") || "—"}</p>
            </div>
            <div className="card">
              <span className="muted">Estado técnico</span>
              <p>{result.degraded ? "DEGRADED" : "SUPPORTED"}</p>
              <small>
                {result.warnings.join(" · ") || "Sin degradaciones"}
              </small>
            </div>
          </div>
        </details>
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

      {presentation?.outcome === "EXPLORATORY_ONLY" &&
      exploratoryHits.length > 0 ? (
        <section className="card" role="status" style={{ marginTop: 16 }}>
          <h2>Coincidencias exploratorias</h2>
          <p>
            Se recuperaron candidatos autorizados, pero no alcanzaron el nivel
            de soporte necesario para tratarlos como evidencia de una respuesta.
            Puedes inspeccionarlos para reformular la búsqueda.
          </p>
          {exploratoryHits.map((hit, index) => (
            <article
              key={`exploratory-${hit.documentId}`}
              style={{ marginTop: index === 0 ? 12 : 20 }}
            >
              <p className="muted">Coincidencia exploratoria {index + 1}</p>
              <h3>
                <Link href={`/documents/${hit.documentId}`}>{hit.title}</Link>
              </h3>
              <p>{hit.excerpt}</p>
              <small className="muted">
                No es evidencia aprobada para responder · score{" "}
                {hit.score.toFixed(4)}
                {hit.fusionContributions?.length
                  ? ` · canales ${hit.fusionContributions
                      .map((entry) => entry.channel)
                      .join(" · ")}`
                  : ""}
              </small>
            </article>
          ))}
        </section>
      ) : null}

      {result?.hits.length ? <h2>Fuentes recuperadas</h2> : null}
      {result?.hits.map((hit, index) => {
        const evidence = evidenceByDocument.get(hit.documentId);
        return (
          <article
            className="card"
            key={hit.documentId}
            style={{ marginTop: 16 }}
          >
            <p className="muted">Fuente {index + 1}</p>
            <h3>
              <Link href={`/documents/${hit.documentId}`}>{hit.title}</Link>
            </h3>
            <p className="muted">
              {hit.lifecycle === "ACTIVE" ? "Vigente" : "Estado especial"} ·{" "}
              {hit.refreshStatus === "CURRENT"
                ? "actualizada"
                : "actualización pendiente o degradada"}
            </p>
            <p>{hit.excerpt}</p>
            <details>
              <summary>Por qué apareció esta fuente</summary>
              <p className="muted">
                score {hit.score.toFixed(4)} · type {hit.type} · trust{" "}
                {hit.trust} · lifecycle {hit.lifecycle} · freshness{" "}
                {hit.refreshStatus}
              </p>
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
              {hit.warnings?.length ? (
                <p className="muted">Warnings: {hit.warnings.join(" · ")}</p>
              ) : null}
            </details>
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
          </article>
        );
      })}

      {packet?.retrievalConfiguration?.reasoning ? (
        <section className="card" role="status" style={{ marginTop: 16 }}>
          <h2>Estado del reasoning planner</h2>
          <p>
            Solicitado{" "}
            <strong>
              {packet.retrievalConfiguration.reasoning.requested ??
                requestedReasoningMode}
            </strong>{" "}
            · ejecución{" "}
            <strong>
              {packet.retrievalConfiguration.reasoning.execution ?? "UNKNOWN"}
            </strong>
          </p>
          {packet.retrievalConfiguration.reasoning.execution ===
          "DIRECT_FALLBACK" ? (
            <p>
              Reasoning planner unavailable or failed. La consulta continuó con
              el fallback directo determinista y este resultado no debe
              interpretarse como ejecución del plan solicitado.
            </p>
          ) : (
            <p className="muted">
              No se activó degradación del planner para este ContextPacket.
            </p>
          )}
        </section>
      ) : null}

      {packet &&
      ((packet.gaps ?? []).length > 0 ||
        (packet.conflicts ?? []).length > 0) ? (
        <section className="card" role="note" style={{ marginTop: 16 }}>
          <h2>Límites del contexto recuperado</h2>
          {(packet.gaps ?? []).map((gap) => (
            <p key={`visible-gap-${gap}`}>Falta: {gap}</p>
          ))}
          {(packet.conflicts ?? []).map((conflict) => (
            <p key={`visible-conflict-${conflict}`}>Conflicto: {conflict}</p>
          ))}
        </section>
      ) : null}

      {packet ? (
        <details className="card" style={{ marginTop: 16 }}>
          <summary>Inspeccionar ContextPacket técnico</summary>
          <section style={{ marginTop: 12 }}>
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
                  {packet.budget?.tokenizer?.quality
                    ? ` · ${packet.budget.tokenizer.quality}`
                    : packet.budget?.tokenizer?.approximate
                      ? " · APPROXIMATE"
                      : ""}
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
        </details>
      ) : null}
    </main>
  );
}
