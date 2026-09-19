import { randomUUID } from "node:crypto";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { akp } from "../../../lib/api";

type Vault = {
  id: string;
  space_id: string;
  vault_key: string;
  name: string;
};

type AssuranceRun = {
  id: string;
  trigger: string;
  detectors: string[];
  status: string;
  cursor?: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  next_attempt_at?: string | null;
  completed_at?: string | null;
  created_at: string;
  result_summary?: Record<string, unknown>;
};

type AssuranceFinding = {
  id: string;
  run_id: string;
  detector: string;
  detector_version: string;
  severity: string;
  category: string;
  scope_id: string;
  target_ids: string[];
  evidence_ids: string[];
  support_set_ids: string[];
  code: string;
  summary: string;
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "FALSE_POSITIVE";
  proposed_action?: string | null;
  revision_set?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at?: string | null;
};

type Capabilities = {
  detectors: string[];
  implementedDetectors: string[];
  findingAuthority: string;
  externalContentTrust: string;
};

export default async function AssurancePage({
  searchParams,
}: {
  searchParams: Promise<{
    vaultId?: string;
    status?: string;
    severity?: string;
    category?: string;
    detector?: string;
  }>;
}) {
  const query = await searchParams;
  const vaultResponse = await akp<{ vaults: Vault[] }>("/v1/vaults");
  const selected =
    vaultResponse.vaults.find((vault) => vault.id === query.vaultId) ??
    vaultResponse.vaults[0];

  if (!selected) {
    return (
      <main>
        <p className="muted">Continuous Assurance</p>
        <h1>Assurance</h1>
        <div className="card">No hay vaults visibles para esta identidad.</div>
      </main>
    );
  }

  const runParams = new URLSearchParams({
    spaceId: selected.space_id,
    vaultId: selected.id,
    limit: "100",
  });
  const findingParams = new URLSearchParams({
    spaceId: selected.space_id,
    vaultId: selected.id,
    limit: "200",
  });
  if (query.status) findingParams.set("status", query.status);
  if (query.severity) findingParams.set("severity", query.severity);
  if (query.category) findingParams.set("category", query.category);
  if (query.detector) findingParams.set("detector", query.detector);

  const [runResponse, findingResponse, capabilities] = await Promise.all([
    akp<{ runs: AssuranceRun[] }>(
      `/v1/assurance/runs?${runParams.toString()}`,
    ),
    akp<{ findings: AssuranceFinding[] }>(
      `/v1/assurance/findings?${findingParams.toString()}`,
    ),
    akp<Capabilities>("/v1/assurance/capabilities"),
  ]);

  async function runAssurance(formData: FormData) {
    "use server";
    const spaceId = String(formData.get("spaceId") ?? "");
    const vaultId = String(formData.get("vaultId") ?? "");
    const idempotencyKey = String(formData.get("idempotencyKey") ?? "");
    if (!spaceId || !vaultId || !idempotencyKey) {
      throw new Error("ASSURANCE_RUN_SCOPE_REQUIRED");
    }
    await akp("/v1/assurance/runs", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({ spaceId, vaultId }),
    });
    revalidatePath("/admin/assurance");
  }

  async function requestFindingAction(formData: FormData) {
    "use server";
    const findingId = String(formData.get("findingId") ?? "");
    const action = String(formData.get("action") ?? "");
    const reason = String(formData.get("reason") ?? "").trim();
    if (!findingId || !["PROMOTION", "RECOMPILE", "REINDEX"].includes(action)) {
      throw new Error("ASSURANCE_FINDING_ACTION_REQUIRED");
    }
    await akp(`/v1/assurance/findings/${findingId}/actions`, {
      method: "POST",
      body: JSON.stringify({
        action,
        ...(reason ? { reason } : {}),
      }),
    });
    revalidatePath("/admin/assurance");
  }

  async function updateFinding(formData: FormData) {
    "use server";
    const findingId = String(formData.get("findingId") ?? "");
    const status = String(formData.get("status") ?? "");
    const reason = String(formData.get("reason") ?? "").trim();
    if (!findingId || !status) {
      throw new Error("ASSURANCE_FINDING_STATUS_REQUIRED");
    }
    await akp(`/v1/assurance/findings/${findingId}/status`, {
      method: "POST",
      body: JSON.stringify({
        status,
        ...(reason ? { reason } : {}),
      }),
    });
    revalidatePath("/admin/assurance");
  }

  const openCritical = findingResponse.findings.filter(
    (finding) =>
      finding.status === "OPEN" &&
      ["CRITICAL", "HIGH"].includes(finding.severity),
  ).length;

  return (
    <main>
      <p className="muted">
        Findings diagnósticos no canónicos, runs durables y lifecycle auditable
      </p>
      <h1>Continuous Assurance</h1>

      <div className="card">
        <strong>Vault</strong>
        <p>
          {selected.name} <span className="muted">({selected.vault_key})</span>
        </p>
        <p>
          {vaultResponse.vaults.map((vault, index) => (
            <span key={vault.id}>
              {index > 0 ? " · " : ""}
              <Link href={`/admin/assurance?vaultId=${vault.id}`}>
                {vault.name}
              </Link>
            </span>
          ))}
        </p>
      </div>

      <div className="grid">
        <section className="card">
          <span className="muted">Runs recientes</span>
          <p className="metric">{runResponse.runs.length}</p>
        </section>
        <section className="card">
          <span className="muted">Findings visibles</span>
          <p className="metric">{findingResponse.findings.length}</p>
        </section>
        <section className="card">
          <span className="muted">Open críticos / altos</span>
          <p className="metric">{openCritical}</p>
        </section>
      </div>

      <form action={runAssurance} className="card" style={{ marginTop: 16 }}>
        <input type="hidden" name="spaceId" value={selected.space_id} />
        <input type="hidden" name="vaultId" value={selected.id} />
        <input
          type="hidden"
          name="idempotencyKey"
          value={`web-assurance-${randomUUID()}`}
        />
        <strong>Ejecutar run manual</strong>
        <p className="muted">
          Ejecuta todos los detectores implementados. El finding resultante
          sigue siendo diagnóstico y no publica conocimiento.
        </p>
        <button type="submit">Ejecutar Assurance</button>
      </form>

      <h2>Findings</h2>
      <form method="get" className="card">
        <input type="hidden" name="vaultId" value={selected.id} />
        <label>
          Estado{" "}
          <select name="status" defaultValue={query.status ?? ""}>
            <option value="">Todos</option>
            <option value="OPEN">OPEN</option>
            <option value="ACKNOWLEDGED">ACKNOWLEDGED</option>
            <option value="RESOLVED">RESOLVED</option>
            <option value="FALSE_POSITIVE">FALSE_POSITIVE</option>
          </select>
        </label>{" "}
        <label>
          Severidad{" "}
          <select name="severity" defaultValue={query.severity ?? ""}>
            <option value="">Todas</option>
            {["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].map((severity) => (
              <option key={severity} value={severity}>
                {severity}
              </option>
            ))}
          </select>
        </label>{" "}
        <label>
          Detector{" "}
          <select name="detector" defaultValue={query.detector ?? ""}>
            <option value="">Todos</option>
            {capabilities.implementedDetectors.map((detector) => (
              <option key={detector} value={detector}>
                {detector}
              </option>
            ))}
          </select>
        </label>{" "}
        <label>
          Categoría{" "}
          <input name="category" defaultValue={query.category ?? ""} />
        </label>{" "}
        <button type="submit">Filtrar</button>
      </form>

      {findingResponse.findings.length ? (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Severidad</th>
                <th>Detector</th>
                <th>Estado</th>
                <th>Targets / evidencia</th>
                <th>Hallazgo</th>
                <th>Lifecycle</th>
              </tr>
            </thead>
            <tbody>
              {findingResponse.findings.map((finding) => (
                <tr key={finding.id}>
                  <td>
                    <span className="badge">{finding.severity}</span>
                  </td>
                  <td>
                    {finding.detector}
                    <br />
                    <small>
                      v{finding.detector_version} · {finding.category}
                    </small>
                    <br />
                    <code>{finding.code}</code>
                  </td>
                  <td>{finding.status}</td>
                  <td>
                    <small>targets</small>
                    <br />
                    {finding.target_ids.length
                      ? finding.target_ids.map((id) => (
                          <code key={id}>{id.slice(0, 28)} </code>
                        ))
                      : "—"}
                    <br />
                    <small>
                      evidence {finding.evidence_ids.length} · support sets{" "}
                      {finding.support_set_ids.length}
                    </small>
                    {finding.evidence_ids.length ? (
                      <details>
                        <summary>Evidence IDs</summary>
                        <pre>{JSON.stringify(finding.evidence_ids, null, 2)}</pre>
                      </details>
                    ) : null}
                  </td>
                  <td>
                    {finding.summary}
                    {finding.proposed_action ? (
                      <>
                        <br />
                        <small>Acción propuesta: {finding.proposed_action}</small>
                      </>
                    ) : null}
                    <br />
                    <small>
                      first {finding.first_seen_at} · last {finding.last_seen_at}
                    </small>
                  </td>
                  <td>
                    <form action={updateFinding}>
                      <input type="hidden" name="findingId" value={finding.id} />
                      <select name="status" defaultValue={finding.status}>
                        <option value="OPEN">OPEN</option>
                        <option value="ACKNOWLEDGED">ACKNOWLEDGED</option>
                        <option value="RESOLVED">RESOLVED</option>
                        <option value="FALSE_POSITIVE">FALSE_POSITIVE</option>
                      </select>
                      <input
                        name="reason"
                        placeholder="Motivo opcional"
                        maxLength={2000}
                      />
                      <button type="submit">Guardar</button>
                    </form>
                    {finding.proposed_action &&
                    ["PROMOTION", "RECOMPILE", "REINDEX"].includes(
                      finding.proposed_action,
                    ) &&
                    ["OPEN", "ACKNOWLEDGED"].includes(finding.status) ? (
                      <form
                        action={requestFindingAction}
                        style={{ marginTop: 8 }}
                      >
                        <input
                          type="hidden"
                          name="findingId"
                          value={finding.id}
                        />
                        <input
                          type="hidden"
                          name="action"
                          value={finding.proposed_action}
                        />
                        <input
                          name="reason"
                          placeholder="Motivo de la solicitud"
                          maxLength={2000}
                        />
                        <button type="submit">
                          Solicitar {finding.proposed_action}
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="card">No hay findings para los filtros seleccionados.</p>
      )}

      <h2>Historial de runs</h2>
      {runResponse.runs.length ? (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Trigger</th>
                <th>Estado</th>
                <th>Detectores</th>
                <th>Intentos</th>
                <th>Creado / completado</th>
              </tr>
            </thead>
            <tbody>
              {runResponse.runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    <code>{run.id.slice(0, 12)}</code>
                  </td>
                  <td>{run.trigger}</td>
                  <td>{run.status}</td>
                  <td>{run.detectors.length}</td>
                  <td>
                    {run.attempts}/{run.max_attempts}
                  </td>
                  <td>
                    {run.created_at}
                    <br />
                    <small>{run.completed_at ?? "—"}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="card">No hay runs de Assurance para este vault.</p>
      )}

      <p className="muted">
        Authority: {capabilities.findingAuthority} · contenido externo:{" "}
        {capabilities.externalContentTrust}
      </p>
    </main>
  );
}
