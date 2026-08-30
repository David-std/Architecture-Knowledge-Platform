import { akp } from "../lib/api";
import { unstable_rethrow } from "next/navigation";

interface Status {
  status: string;
  capabilities: Record<string, boolean>;
  corpus: {
    documents: number;
    relations: number;
    sources: number;
    vault: Record<string, unknown> | null;
  };
  jobs: Array<{ state: string; count: number }>;
  reviews: Array<{ status: string; count: number }>;
}

export default async function Home() {
  let status: Status | null = null;
  let error = "";
  try {
    status = await akp<Status>("/v1/status");
  } catch (caught) {
    unstable_rethrow(caught);
    error = String(caught);
  }
  return (
    <main>
      <p className="muted">Consola operativa</p>
      <h1>Estado del conocimiento</h1>
      {error ? <div className="card">API no disponible: {error}</div> : null}
      {status ? (
        <>
          <div className="grid">
            <div className="card">
              <span className="muted">Documentos</span>
              <p className="metric">{status.corpus.documents}</p>
            </div>
            <div className="card">
              <span className="muted">Relaciones</span>
              <p className="metric">{status.corpus.relations}</p>
            </div>
            <div className="card">
              <span className="muted">Fuentes ingeridas</span>
              <p className="metric">{status.corpus.sources}</p>
            </div>
            <div className="card">
              <span className="muted">Servicio</span>
              <p className="metric">{status.status}</p>
            </div>
          </div>
          <h2>Capacidades</h2>
          <div className="card">
            {Object.entries(status.capabilities).map(([name, active]) => (
              <span className="badge" key={name}>
                {name}: {active ? "activa" : "degradada"}
              </span>
            ))}
          </div>
          <h2>Vault importado</h2>
          <pre>{JSON.stringify(status.corpus.vault, null, 2)}</pre>
        </>
      ) : null}
    </main>
  );
}
