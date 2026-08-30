import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { akp } from "../../lib/api";
import type { VaultOption } from "../../lib/vault-scope";

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
        Captura local permitida → SHA-256 → MinIO → extracción → revisión
      </p>
      <h1>Nueva ingesta</h1>
      <form action={submit} className="card">
        <input
          type="hidden"
          name="idempotencyKey"
          value={`web-ingest-${randomUUID()}`}
        />
        <p>
          <label>
            Vault
            <select name="scope" required>
              <option value="">Selecciona un vault autorizado</option>
              {vaults.map((vault) => (
                <option key={vault.id} value={`${vault.space_id}:${vault.id}`}>
                  {vault.name} ({vault.vault_key})
                </option>
              ))}
            </select>
          </label>
        </p>
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
