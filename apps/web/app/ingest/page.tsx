import { redirect } from "next/navigation";
import { akp } from "../../lib/api";

export default function IngestPage() {
  async function submit(formData: FormData) {
    "use server";
    const sourceUri = String(formData.get("sourceUri") ?? "").trim();
    const title = String(formData.get("title") ?? "").trim();
    const mediaType = String(formData.get("mediaType") ?? "").trim();
    const result = await akp<{ jobId: string }>("/v1/ingest", {
      method: "POST",
      body: JSON.stringify({
        spaceId: "00000000-0000-0000-0000-000000000003",
        sourceUri,
        title: title || undefined,
        mediaType: mediaType || undefined,
        policy: "REVIEW_REQUIRED",
        idempotencyKey: `web-${crypto.randomUUID()}`,
      }),
    });
    redirect(`/jobs/${result.jobId}`);
  }
  return (
    <main>
      <p className="muted">
        Captura local permitida → SHA-256 → MinIO → extracción → revisión
      </p>
      <h1>Nueva ingesta</h1>
      <form action={submit} className="card">
        <p>
          <label>
            Ruta capturada <input name="sourceUri" required />
          </label>
        </p>
        <p>
          <label>
            Título <input name="title" />
          </label>
        </p>
        <p>
          <label>
            Media type <input name="mediaType" placeholder="application/pdf" />
          </label>
        </p>
        <button type="submit">Enviar a revisión</button>
      </form>
      <p className="muted">
        La ruta debe estar dentro de una raíz configurada en AKP_INGEST_ROOTS.
      </p>
    </main>
  );
}
