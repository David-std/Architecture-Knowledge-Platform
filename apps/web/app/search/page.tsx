import Link from "next/link";
import { akp } from "../../lib/api";

interface SearchResponse {
  channels: string[];
  degraded: boolean;
  hits: Array<{
    documentId: string;
    title: string;
    type: string;
    trust: string;
    score: number;
    excerpt: string;
    reasons: string[];
    citations: string[];
  }>;
  noAnswer: { reason: string; guidance: string } | null;
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const query = (await searchParams).q?.trim() ?? "";
  const result = query
    ? await akp<SearchResponse>("/v1/search", {
        method: "POST",
        body: JSON.stringify({ query, limit: 20, mode: "SOURCE_BACKED" }),
      })
    : null;
  const packet = query
    ? await akp<Record<string, unknown>>("/v1/context", {
        method: "POST",
        body: JSON.stringify({
          query,
          maxTokens: 1600,
          mode: "SOURCE_BACKED",
        }),
      })
    : null;
  return (
    <main>
      <p className="muted">Exacta + lexical + expansión del grafo</p>
      <h1>Búsqueda híbrida</h1>
      <form>
        <input
          name="q"
          defaultValue={query}
          placeholder="Pregunta o ID estable"
          aria-label="Consulta"
        />
        <button type="submit">Buscar</button>
      </form>
      {result?.degraded ? (
        <p className="muted">
          Canal vectorial desactivado; resultados reproducibles con tres canales
          locales.
        </p>
      ) : null}
      {result?.noAnswer ? (
        <div className="card">
          <strong>{result.noAnswer.reason}</strong>
          <p>{result.noAnswer.guidance}</p>
        </div>
      ) : null}
      {result?.hits.map((hit) => (
        <article
          className="card"
          key={hit.documentId}
          style={{ marginTop: 16 }}
        >
          <h2>
            <Link href={`/documents/${hit.documentId}`}>{hit.title}</Link>
          </h2>
          <p>
            <span className="badge">{hit.type}</span>
            <span className="badge">{hit.trust}</span>
          </p>
          <p>{hit.excerpt}</p>
          <p className="muted">
            {hit.reasons.join(" · ")} · score {hit.score.toFixed(4)}
          </p>
          <small>{hit.citations.join(" | ")}</small>
        </article>
      ))}
      {packet ? (
        <>
          <h2>ContextPacket acotado</h2>
          <pre>{JSON.stringify(packet, null, 2)}</pre>
        </>
      ) : null}
    </main>
  );
}
