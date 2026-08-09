import { akp } from "../../../lib/api";
import { revalidatePath } from "next/cache";

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const review = await akp<Record<string, unknown>>(`/v1/reviews/${id}`);
  async function decide(formData: FormData) {
    "use server";
    const decision = String(formData.get("decision") ?? "");
    const reason = String(formData.get("reason") ?? "").trim();
    await akp(`/v1/reviews/${id}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision, reason }),
    });
    revalidatePath(`/reviews/${id}`);
  }
  return (
    <main>
      <p className="muted">Diff, impacto y gates</p>
      <h1>Revisión {id}</h1>
      <p>
        <span className="badge">{String(review.status)}</span>
      </p>
      {["PENDING", "CHANGES_REQUESTED"].includes(String(review.status)) ? (
        <form action={decide} className="card">
          <label>
            Razón de la decisión <input name="reason" required minLength={3} />
          </label>
          <p>
            <button name="decision" value="APPROVE">
              Aprobar
            </button>{" "}
            <button name="decision" value="REQUEST_CHANGES">
              Solicitar cambios
            </button>{" "}
            <button name="decision" value="REJECT">
              Rechazar
            </button>
          </p>
        </form>
      ) : null}
      <h2>Validación</h2>
      <pre>{JSON.stringify(review.validation_report, null, 2)}</pre>
      <h2>Impacto</h2>
      <pre>{JSON.stringify(review.impact_manifest, null, 2)}</pre>
      <h2>Diff Git</h2>
      <pre>{String(review.diff ?? "")}</pre>
    </main>
  );
}
