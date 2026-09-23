import { akp } from "../../lib/api";
import { AuthoringForm } from "./authoring-form";

type Vault = {
  id: string;
  space_id: string;
  vault_key: string;
  name: string;
};

export default async function AuthorPage() {
  const result = await akp<{ vaults: Vault[] }>("/v1/vaults");
  if (!result.vaults.length) {
    return (
      <main>
        <p className="muted">Authoring</p>
        <h1>Nuevo conocimiento</h1>
        <div className="card">
          No hay vaults visibles para esta identidad. El editor no amplía scope.
        </div>
      </main>
    );
  }

  return (
    <main>
      <p className="muted">
        Recovery local → Save gobernado → review → publicación autorizada
      </p>
      <h1>Authoring Workspace</h1>
      <AuthoringForm vaults={result.vaults} />
    </main>
  );
}
