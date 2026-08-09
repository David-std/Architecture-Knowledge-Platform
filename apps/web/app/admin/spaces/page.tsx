import { akp } from "../../../lib/api";

export default async function SpacesPage() {
  const vaults = await akp<Record<string, unknown>>("/v1/vaults");
  return (
    <main>
      <p className="muted">
        Espacios visibles para la identidad de servicio web
      </p>
      <h1>Espacios y corpus</h1>
      <div className="card">
        La administración de membresías se conserva server-side; esta primera UI
        es de inspección.
      </div>
      <pre>{JSON.stringify(vaults, null, 2)}</pre>
    </main>
  );
}
