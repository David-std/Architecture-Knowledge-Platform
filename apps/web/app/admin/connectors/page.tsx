import Link from "next/link";
import { akp } from "../../../lib/api";

type Vault = {
  id: string;
  space_id: string;
  vault_key: string;
  name: string;
};

type Connector = {
  id: string;
  space_id: string;
  vault_id: string;
  connector_key: string;
  source_system: string;
  state: string;
  descriptor: {
    objectTypes?: string[];
    permissionFidelity?: string;
    replication?: string;
    dataResidency?: string;
    deletionPropagation?: string;
    freshnessSlaSeconds?: number;
    contentTrust?: string;
    incremental?: { cursor?: boolean; webhook?: boolean };
  };
  last_event_at?: string | null;
  checkpoint_updated_at?: string | null;
  applied_sequence: number | string;
  webhook_status: string;
  pending_events: number;
  gap_events: number;
  retry_events: number;
  rejected_events: number;
  total_apply_attempts: number;
  last_error_code?: string | null;
  active_objects: number;
  uncertain_acl_objects: number;
  tombstones: number;
};

type HealthResponse = {
  connectors: Connector[];
};

export default async function ConnectorsPage({
  searchParams,
}: {
  searchParams: Promise<{ vaultId?: string }>;
}) {
  const query = await searchParams;
  const [vaultResponse, health] = await Promise.all([
    akp<{ vaults: Vault[] }>("/v1/vaults"),
    akp<HealthResponse>("/v1/operator/health"),
  ]);
  const selected =
    vaultResponse.vaults.find((vault) => vault.id === query.vaultId) ??
    vaultResponse.vaults[0];

  if (!selected) {
    return (
      <main>
        <p className="muted">Source connectors</p>
        <h1>Connectors</h1>
        <div className="card">No hay vaults visibles para esta identidad.</div>
      </main>
    );
  }

  const connectors = health.connectors.filter(
    (connector) => connector.vault_id === selected.id,
  );
  const pending = connectors.reduce(
    (total, connector) => total + Number(connector.pending_events ?? 0),
    0,
  );
  const gaps = connectors.reduce(
    (total, connector) => total + Number(connector.gap_events ?? 0),
    0,
  );
  const uncertainAcl = connectors.reduce(
    (total, connector) => total + Number(connector.uncertain_acl_objects ?? 0),
    0,
  );
  const rejected = connectors.reduce(
    (total, connector) => total + Number(connector.rejected_events ?? 0),
    0,
  );

  return (
    <main>
      <p className="muted">
        Checkpoints, frescura, ACL, gaps y propagación de borrados
      </p>
      <h1>Source connectors</h1>

      <div className="card">
        <strong>Vault</strong>
        <p>
          {selected.name} <span className="muted">({selected.vault_key})</span>
        </p>
        <p>
          {vaultResponse.vaults.map((vault, index) => (
            <span key={vault.id}>
              {index > 0 ? " · " : ""}
              <Link href={`/admin/connectors?vaultId=${vault.id}`}>
                {vault.name}
              </Link>
            </span>
          ))}
        </p>
      </div>

      <div className="grid">
        <section className="card">
          <span className="muted">Connectors</span>
          <p className="metric">{connectors.length}</p>
        </section>
        <section className="card">
          <span className="muted">Eventos pendientes</span>
          <p className="metric">{pending}</p>
        </section>
        <section className="card">
          <span className="muted">Gaps de secuencia</span>
          <p className="metric">{gaps}</p>
        </section>
        <section className="card">
          <span className="muted">Objetos con ACL incierto</span>
          <p className="metric">{uncertainAcl}</p>
        </section>
        <section className="card">
          <span className="muted">Eventos rechazados</span>
          <p className="metric">{rejected}</p>
        </section>
      </div>

      {connectors.length ? (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Connector</th>
                <th>Estado / checkpoint</th>
                <th>Sync / retry</th>
                <th>Permisos</th>
                <th>Objetos</th>
                <th>Webhook / borrados</th>
              </tr>
            </thead>
            <tbody>
              {connectors.map((connector) => (
                <tr key={connector.id}>
                  <td>
                    <strong>{connector.connector_key}</strong>
                    <br />
                    <small>{connector.source_system}</small>
                    <br />
                    <code>{connector.id.slice(0, 12)}</code>
                  </td>
                  <td>
                    {connector.state}
                    <br />
                    checkpoint {String(connector.applied_sequence)}
                    <br />
                    <small>
                      actualizado {connector.checkpoint_updated_at ?? "—"}
                    </small>
                  </td>
                  <td>
                    último evento {connector.last_event_at ?? "—"}
                    <br />
                    <small>
                      pending {connector.pending_events} · gaps{" "}
                      {connector.gap_events} · retry {connector.retry_events}
                    </small>
                    <br />
                    <small>
                      intentos {connector.total_apply_attempts} · rejected{" "}
                      {connector.rejected_events}
                    </small>
                    {connector.last_error_code ? (
                      <>
                        <br />
                        <code>{connector.last_error_code}</code>
                      </>
                    ) : null}
                  </td>
                  <td>
                    {connector.descriptor.permissionFidelity ?? "—"}
                    <br />
                    <small>
                      ACL incierto: {connector.uncertain_acl_objects}
                    </small>
                    <br />
                    <small>
                      residencia {connector.descriptor.dataResidency ?? "—"}
                    </small>
                  </td>
                  <td>
                    activos {connector.active_objects}
                    <br />
                    <small>
                      replication {connector.descriptor.replication ?? "—"} ·
                      trust {connector.descriptor.contentTrust ?? "—"}
                    </small>
                    <br />
                    <small>
                      SLA{" "}
                      {connector.descriptor.freshnessSlaSeconds
                        ? `${connector.descriptor.freshnessSlaSeconds}s`
                        : "no declarado"}
                    </small>
                  </td>
                  <td>
                    {connector.webhook_status}
                    <br />
                    <small>
                      cursor{" "}
                      {connector.descriptor.incremental?.cursor ? "sí" : "no"} ·
                      webhook{" "}
                      {connector.descriptor.incremental?.webhook ? "sí" : "no"}
                    </small>
                    <br />
                    <small>
                      {connector.descriptor.deletionPropagation ?? "—"} ·
                      tombstones {connector.tombstones}
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="card">
          No hay source connectors registrados para este vault.
        </p>
      )}
    </main>
  );
}
