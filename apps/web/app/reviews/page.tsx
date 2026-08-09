import Link from "next/link";
import { akp } from "../../lib/api";

export default async function ReviewsPage() {
  const result = await akp<{ reviews: Array<Record<string, unknown>> }>(
    "/v1/reviews",
  );
  return (
    <main>
      <p className="muted">Cambios propuestos antes de publicación</p>
      <h1>Revisiones</h1>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Estado</th>
            <th>Rama</th>
            <th>Creada</th>
          </tr>
        </thead>
        <tbody>
          {result.reviews.map((review) => (
            <tr key={String(review.id)}>
              <td>
                <Link href={`/reviews/${review.id}`}>{String(review.id)}</Link>
              </td>
              <td>{String(review.status)}</td>
              <td>{String(review.branch_name)}</td>
              <td>{String(review.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
