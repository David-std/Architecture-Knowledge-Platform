import Link from "next/link";
import { akp } from "../../../lib/api";

interface ArtifactItem {
  id?: string;
  kind?: string;
  text?: string;
  locator?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  headers?: string[];
  rows?: string[][];
}

interface DocumentArtifact {
  warnings?: string[];
  quality_metrics?: Record<string, string | number | boolean>;
  headings?: ArtifactItem[];
  paragraphs?: ArtifactItem[];
  tables?: ArtifactItem[];
  figures?: ArtifactItem[];
  equations?: ArtifactItem[];
  locators?: Array<Record<string, unknown>>;
}

interface SourceArtifact {
  id: string;
  kind: string;
  source_hash: string;
  extractor: string;
  extractor_version: string;
  quality: string;
  metadata?: Record<string, unknown>;
  document_artifact?: DocumentArtifact;
  structured_content_hash?: string;
  created_at?: string;
}

interface EvidenceRow {
  id: string;
  locator: Record<string, unknown>;
  content_hash: string;
  excerpt: string;
  review_status: string;
  created_at?: string;
}

interface SourceResponse {
  source: {
    id: string;
    title: string;
    media_type: string;
    sha256: string;
    byte_size: number;
    status: string;
    metadata?: Record<string, unknown>;
    created_at?: string;
  };
  artifacts: SourceArtifact[];
  evidence: EvidenceRow[];
  descendants: Array<{
    id: string;
    title: string;
    type: string;
    lifecycle: string;
    trust_tier: string;
    current_revision?: string;
    refresh_status?: string;
  }>;
  reviews: Array<{
    id: string;
    status: string;
    base_commit?: string;
    head_commit?: string;
    merged_commit?: string;
    created_at?: string;
  }>;
}

function locatorLabel(locator: Record<string, unknown>): string {
  const parts = [
    locator.kind,
    locator.page ? `p.${locator.page}` : null,
    locator.sheet ? `sheet ${locator.sheet}` : null,
    locator.timestamp_start !== undefined
      ? `${locator.timestamp_start}s–${locator.timestamp_end ?? "?"}s`
      : null,
  ].filter(Boolean);
  return parts.join(" · ") || "locator";
}

export default async function SourcePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await akp<SourceResponse>(`/v1/operator/sources/${id}`);
  const { source } = result;

  return (
    <main>
      <p className="muted">Fuente inmutable, extracción, evidencia y descendientes</p>
      <h1>{source.title || id}</h1>
      <p>
        <span className="badge">{source.media_type}</span>
        <span className="badge">{source.status}</span>
      </p>

      <div className="grid">
        <div className="card">
          <span className="muted">SHA-256</span>
          <p>
            <code>{source.sha256}</code>
          </p>
        </div>
        <div className="card">
          <span className="muted">Tamaño inmutable</span>
          <p className="metric">{source.byte_size.toLocaleString()}</p>
          <small>bytes</small>
        </div>
        <div className="card">
          <span className="muted">Artefactos</span>
          <p className="metric">{result.artifacts.length}</p>
        </div>
        <div className="card">
          <span className="muted">Evidencias</span>
          <p className="metric">{result.evidence.length}</p>
        </div>
      </div>

      <h2>Extracción estructurada</h2>
      {result.artifacts.length ? (
        result.artifacts.map((artifact) => {
          const document = artifact.document_artifact ?? {};
          const preview = [
            ...(document.headings ?? []),
            ...(document.paragraphs ?? []),
          ]
            .filter((item) => item.text)
            .slice(0, 8);
          return (
            <article className="card" key={artifact.id} style={{ marginTop: 16 }}>
              <h3>
                {artifact.extractor} <small>{artifact.extractor_version}</small>
              </h3>
              <p>
                <span className="badge">{artifact.quality}</span>
                <span className="badge">{artifact.kind}</span>
              </p>
              {document.warnings?.length ? (
                <p className="muted">Warnings: {document.warnings.join(" · ")}</p>
              ) : null}

              {preview.length ? (
                <>
                  <h3>Bloques</h3>
                  {preview.map((item, index) => (
                    <div key={item.id ?? index} style={{ marginBottom: 12 }}>
                      <span className="badge">{item.kind ?? "block"}</span>
                      {item.locator ? (
                        <small>{locatorLabel(item.locator)}</small>
                      ) : null}
                      <p>{item.text}</p>
                    </div>
                  ))}
                </>
              ) : (
                <p className="muted">El artefacto no contiene preview textual.</p>
              )}

              {(document.tables ?? []).length ? (
                <>
                  <h3>Tablas</h3>
                  {(document.tables ?? []).slice(0, 4).map((table, tableIndex) => (
                    <div key={table.id ?? tableIndex} style={{ overflowX: "auto" }}>
                      <p className="muted">
                        {table.locator ? locatorLabel(table.locator) : "table"}
                      </p>
                      <table>
                        {table.headers?.length ? (
                          <thead>
                            <tr>
                              {table.headers.map((header, index) => (
                                <th key={`${header}-${index}`}>{header}</th>
                              ))}
                            </tr>
                          </thead>
                        ) : null}
                        <tbody>
                          {(table.rows ?? []).slice(0, 10).map((row, rowIndex) => (
                            <tr key={rowIndex}>
                              {row.map((cell, cellIndex) => (
                                <td key={cellIndex}>{cell}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </>
              ) : null}

              {(document.figures ?? []).length ? (
                <p>
                  <strong>Figuras:</strong> {document.figures?.length}
                </p>
              ) : null}
              {(document.equations ?? []).length ? (
                <p>
                  <strong>Ecuaciones:</strong> {document.equations?.length}
                </p>
              ) : null}
              <details>
                <summary>Inspeccionar artefacto JSON</summary>
                <pre>{JSON.stringify(artifact, null, 2)}</pre>
              </details>
            </article>
          );
        })
      ) : (
        <div className="card">Sin artefactos estructurados.</div>
      )}

      <h2>Evidencia</h2>
      {result.evidence.length ? (
        <table>
          <thead>
            <tr>
              <th>Locator</th>
              <th>Excerpt</th>
              <th>Review</th>
              <th>Hash</th>
            </tr>
          </thead>
          <tbody>
            {result.evidence.map((evidence) => (
              <tr key={evidence.id}>
                <td>{locatorLabel(evidence.locator)}</td>
                <td>{evidence.excerpt}</td>
                <td>{evidence.review_status}</td>
                <td>
                  <code>{evidence.content_hash.slice(0, 16)}…</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">Aún no hay evidencia persistida.</p>
      )}

      <div className="grid" style={{ marginTop: 20 }}>
        <section className="card">
          <h2>Conocimiento compilado</h2>
          {result.descendants.length ? (
            <ul>
              {result.descendants.map((document) => (
                <li key={document.id}>
                  <Link href={`/documents/${document.id}`}>{document.title}</Link>{" "}
                  <span className="badge">{document.type}</span>
                  <span className="badge">{document.lifecycle}</span>
                  <span className="badge">{document.trust_tier}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Sin descendientes compilados.</p>
          )}
        </section>
        <section className="card">
          <h2>Revisiones relacionadas</h2>
          {result.reviews.length ? (
            <ul>
              {result.reviews.map((review) => (
                <li key={review.id}>
                  <Link href={`/reviews/${review.id}`}>Revisión {review.id.slice(0, 8)}</Link>{" "}
                  <span className="badge">{review.status}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Sin revisiones relacionadas.</p>
          )}
        </section>
      </div>

      <details style={{ marginTop: 20 }}>
        <summary>Inspeccionar metadata JSON</summary>
        <pre>{JSON.stringify(source.metadata ?? {}, null, 2)}</pre>
      </details>
    </main>
  );
}
