import Link from "next/link";
import { akp } from "../../../lib/api";

type Vault = {
  id: string;
  space_id: string;
  vault_key: string;
  name: string;
};

type ProfileRevision = {
  id: string;
  profile_id: string;
  version: string;
  profile_hash: string;
  status: string;
  compatibility_class: string | null;
  supersedes_revision_id: string | null;
  affected_document_count: number | null;
  corpus_revision: string | null;
  latest_dry_run_id: string | null;
  created_at: string;
};

type ProfilesResponse = {
  active: {
    source: "DURABLE_REVISION" | "V03_DEFAULT";
    revisionId: string | null;
    profileId: string;
    version: string;
    profileHash: string;
    status: string;
  };
  revisions: ProfileRevision[];
};

export default async function ProfilesPage({
  searchParams,
}: {
  searchParams: Promise<{ vaultId?: string }>;
}) {
  const query = await searchParams;
  const vaultResponse = await akp<{ vaults: Vault[] }>("/v1/vaults");
  const selected =
    vaultResponse.vaults.find((vault) => vault.id === query.vaultId) ??
    vaultResponse.vaults[0];

  if (!selected) {
    return (
      <main>
        <p className="muted">Gobernanza de KnowledgeProfile</p>
        <h1>Perfiles</h1>
        <div className="card">No hay vaults visibles para esta identidad.</div>
      </main>
    );
  }

  const params = new URLSearchParams({
    spaceId: selected.space_id,
    vaultId: selected.id,
  });
  const profiles = await akp<ProfilesResponse>(
    `/v1/schema/profiles?${params.toString()}`,
  );
  const pending = profiles.revisions.filter((revision) =>
    ["DRAFT", "VALIDATED", "REVIEW_REQUIRED"].includes(revision.status),
  );

  return (
    <main>
      <p className="muted">Gobernanza versionada por vault</p>
      <h1>Knowledge Profiles</h1>

      <div className="card">
        <strong>Vault</strong>
        <p>
          {selected.name} <span className="muted">({selected.vault_key})</span>
        </p>
        <p>
          {vaultResponse.vaults.map((vault, index) => (
            <span key={vault.id}>
              {index > 0 ? " · " : ""}
              <Link href={`/admin/profiles?vaultId=${vault.id}`}>
                {vault.name}
              </Link>
            </span>
          ))}
        </p>
      </div>

      <div className="grid">
        <section className="card">
          <p className="muted">Perfil activo</p>
          <h2>{profiles.active.profileId}</h2>
          <p>
            Versión <strong>{profiles.active.version}</strong>
          </p>
          <p>Fuente: {profiles.active.source}</p>
          <p className="muted">{profiles.active.profileHash.slice(0, 16)}…</p>
        </section>
        <section className="card">
          <p className="muted">Revisiones pendientes</p>
          <h2>{pending.length}</h2>
          <p>
            {pending.length
              ? pending
                  .map((revision) => `${revision.version} · ${revision.status}`)
                  .join(", ")
              : "Sin revisiones pendientes"}
          </p>
        </section>
      </div>

      <h2>Historial y compatibilidad</h2>
      {profiles.revisions.length === 0 ? (
        <div className="card">
          El vault usa el perfil de compatibilidad v0.3 y todavía no tiene
          revisiones durables.
        </div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Versión</th>
                <th>Estado</th>
                <th>Compatibilidad</th>
                <th>Impacto</th>
                <th>Acción requerida</th>
              </tr>
            </thead>
            <tbody>
              {profiles.revisions.map((revision) => (
                <tr key={revision.id}>
                  <td>{revision.version}</td>
                  <td>{revision.status}</td>
                  <td>{revision.compatibility_class ?? "Sin clasificar"}</td>
                  <td>
                    {revision.affected_document_count === null
                      ? "Sin dry-run"
                      : `${revision.affected_document_count} docs`}
                  </td>
                  <td>
                    {revision.compatibility_class === "NON_BREAKING"
                      ? revision.status === "VALIDATED"
                        ? "Activación pendiente"
                        : "Sin migración"
                      : revision.compatibility_class
                        ? "Revisión/migración requerida"
                        : "Ejecutar dry-run"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
