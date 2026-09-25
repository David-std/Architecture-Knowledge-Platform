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
        Captura local permitida · SHA-256 · MinIO · Extracción · Revisión
      </p>
      <h1>Nueva ingesta</h1>
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
              Ruta capturada
              <InfoTooltip text="Ruta absoluta o relativa del archivo o directorio de evidencia dentro de AKP_INGEST_ROOTS." />
            </span>
            <input
              name="sourceUri"
              required
              placeholder="c:/repos/architecture/specs/oauth-spec.pdf"
              className="form-input"
            />
          </label>
        </div>
        <small className="muted form-field-example">
          Ejemplo sustancial:{" "}
          <code>c:/repos/architecture/specs/oauth-spec.pdf</code> (debe residir
          en una raíz autorizada).
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
            Enviar a revisión
          </button>
        </div>
      </form>
      <p className="muted" style={{ marginTop: 16 }}>
        La ruta debe estar dentro de una raíz configurada en AKP_INGEST_ROOTS.
      </p>
    </main>
  );
}
