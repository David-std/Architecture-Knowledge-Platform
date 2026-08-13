import { redirect } from "next/navigation";
import { akp } from "../../lib/api";

interface VaultOption {
  id: string;
  space_id: string;
  name: string;
  vault_key: string;
}

export default async function IngestPage() {
  const response = await akp<{ vaults: VaultOption[] }>("/v1/vaults");
  const vaults = response.vaults ?? [];
  async function submit(formData: FormData) {
    "use server";
    const sourceUri = String(formData.get("sourceUri") ?? "").trim();
    const title = String(formData.get("title") ?? "").trim();
    const mediaType = String(formData.get("mediaType") ?? "").trim();
    const scope = String(formData.get("scope") ?? "").trim();
    const [spaceId, vaultId] = scope.split(":", 2);
    if (!spaceId || !vaultId) throw new Error("VAULT_SCOPE_REQUIRED");
    const result = await akp<{ jobId: string }>("/v1/ingest", {
      method: "POST",
      body: JSON.stringify({
        spaceId,
        vaultId,
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
