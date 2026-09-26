import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { akp } from "../../lib/api";
import type { VaultOption } from "../../lib/vault-scope";
import { InfoTooltip } from "../components/info-tooltip";

export default async function IngestPage() {
  const response = await akp<{ vaults: VaultOption[] }>("/v1/vaults");
  const vaults = response.vaults ?? [];
  async function submit(formData: FormData) {
    "use server";
    const sourceUri = String(formData.get("sourceUri") ?? "").trim();
    const title = String(formData.get("title") ?? "").trim();
    const mediaType = String(formData.get("mediaType") ?? "").trim();
    const idempotencyKey = String(formData.get("idempotencyKey") ?? "");
    const scope = String(formData.get("scope") ?? "").trim();
    const [spaceId, vaultId] = scope.split(":", 2);
    if (!spaceId || !vaultId) throw new Error("VAULT_SCOPE_REQUIRED");
    const result = await akp<{ jobId: string }>("/v1/ingest", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({
        spaceId,
        vaultId,
        sourceUri,
        title: title || undefined,
        mediaType: mediaType || undefined,
        policy: "REVIEW_REQUIRED",
      }),
    });
    redirect(`/jobs/${result.jobId}`);
  }
  return (
    <main>
      <p className="muted">
        Inicia una captura gobernada. Enviar el job no publica conocimiento ni
        garantiza que llegue a revisión.
      </p>
      <h1>Nueva ingesta</h1>
      <div className="card" role="note" style={{ marginBottom: 16 }}>
        <strong>Secuencia</strong>
        <p>
          Captura → extracción/OCR si aplica → compilación de propuesta →
          validación → revisión humana.
        </p>
      </div>
      <form action={submit} className="card ingest-form-card">
        <input
          type="hidden"
          name="idempotencyKey"
          value={`web-ingest-${randomUUID()}`}
        />
        <div className="ingest-grid">
          <label className="form-field-label">
            <span className="form-label-title">
              Vault
              <InfoTooltip text="Vault de destino donde se indexarán las fuentes y se generará el draft gobernado." />
            </span>
            <select name="scope" required className="form-select">
              <option value="">Selecciona un vault autorizado</option>
              {vaults.map((vault) => (
                <option key={vault.id} value={`${vault.space_id}:${vault.id}`}>
                  {vault.name} ({vault.vault_key})
                </option>
              ))}
            </select>
          </label>

          <label className="form-field-label">
            <span className="form-label-title">
              Ruta visible para el servidor
              <InfoTooltip text="Ruta que el proceso API/worker puede abrir dentro de AKP_INGEST_ROOTS. Una ruta que existe solo en tu PC no funciona en un servidor o contenedor remoto." />
            </span>
            <input
              name="sourceUri"
              required
              placeholder="/data/akp-ingest/oauth-spec.pdf"
              className="form-input"
            />
          </label>
        </div>
        <small className="muted form-field-example">
          Ejemplo: <code>/data/akp-ingest/oauth-spec.pdf</code>. La ruta debe
          existir desde el namespace del API/worker y estar dentro de una raíz
          autorizada; no es un selector de archivo del navegador.
        </small>

        <div className="ingest-grid" style={{ marginTop: 16 }}>
          <label className="form-field-label">
            <span className="form-label-title">
              Título descriptivo
              <InfoTooltip text="Título legible de la evidencia para identificarla en el catálogo de fuentes." />
            </span>
            <input
              name="title"
              placeholder="Especificación OAuth2 y Flujos de Autorización"
              className="form-input"
            />
          </label>

          <label className="form-field-label">
            <span className="form-label-title">
              Media type
              <InfoTooltip text="Tipo MIME del archivo (opcional). Por defecto se infiere por extensión o introspección de bytes." />
            </span>
            <input
              name="mediaType"
              placeholder="application/pdf"
              className="form-input"
            />
          </label>
        </div>

        <div className="form-actions-row">
          <button type="submit" className="action-button-primary">
            Iniciar ingesta
          </button>
        </div>
      </form>
      <p className="muted" style={{ marginTop: 16 }}>
        Si AKP corre en Docker u otra máquina, usa una ruta montada/visible allí
        y autorizada por AKP_INGEST_ROOTS. Sigue el estado en la página del job
        hasta que el sistema indique si existe una propuesta para revisión.
      </p>
    </main>
  );
}
