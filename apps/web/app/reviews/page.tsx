import Link from "next/link";
import { akp } from "../../lib/api";

interface ReviewRow {
  id: string;
  status: string;
  branch_name: string;
  created_at: string;
  updated_at?: string;
  author_name?: string | null;
  vault_id?: string | null;
  vault_name?: string | null;
  vault_key?: string | null;
  impact_manifest?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function reviewTitle(review: ReviewRow): string {
  const impact = asRecord(review.impact_manifest);
  if (typeof impact.summary === "string" && impact.summary.trim()) {
    return impact.summary.trim();
  }
  const changes = Array.isArray(impact.proposedChanges)
    ? impact.proposedChanges
    : [];
  const first = asRecord(changes[0]);
  if (typeof first.path === "string" && first.path.trim()) {
    return `Cambio en ${first.path}`;
  }
  return "Propuesta de conocimiento";
}

function actionLabel(status: string): string {
  if (status === "PENDING") return "Revisar propuesta";
  if (status === "CHANGES_REQUESTED") return "Ver cambios solicitados";
  if (status === "APPROVED") return "Ver publicación";
  if (status === "REJECTED") return "Ver rechazo";
  return "Ver detalle";
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("es", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(date);
}

export default async function ReviewsPage() {
  const result = await akp<{ reviews: ReviewRow[] }>("/v1/reviews");
  return (
    <main>
      <p className="muted">
        Cambios propuestos que aún dependen de la política de revisión y
        publicación.
      </p>
      <h1>Revisiones</h1>
      {result.reviews.length ? (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Propuesta</th>
                <th>Estado</th>
                <th>Vault</th>
                <th>Autor</th>
                <th>Actualizada</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody>
              {result.reviews.map((review) => (
                <tr key={review.id}>
                  <td>
                    <strong>{reviewTitle(review)}</strong>
                    <br />
                    <small className="muted">
                      ID <code>{review.id.slice(0, 8)}</code> · rama{" "}
                      <code>{review.branch_name}</code>
                    </small>
                  </td>
                  <td>
                    <span className="badge">{review.status}</span>
                  </td>
                  <td>
                    {review.vault_name ?? "Vault autorizado"}
                    <br />
                    <small className="muted">
                      {review.vault_key ??
                        (review.vault_id
                          ? review.vault_id.slice(0, 8)
                          : "sin identificador")}
                    </small>
                  </td>
                  <td>{review.author_name ?? "No disponible"}</td>
                  <td>{dateLabel(review.updated_at ?? review.created_at)}</td>
                  <td>
                    <Link href={`/reviews/${review.id}`}>
                      {actionLabel(review.status)}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card" role="status">
          No hay propuestas visibles en tu alcance.
        </div>
      )}
    </main>
  );
}
