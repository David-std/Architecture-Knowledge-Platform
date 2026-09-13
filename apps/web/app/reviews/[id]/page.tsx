import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { akp } from "../../../lib/api";

interface ReviewResponse {
  id: string;
  space_id: string;
  status: string;
  base_commit?: string;
  head_commit?: string;
  merged_commit?: string | null;
  decision_reason?: string | null;
  impact_manifest?: Record<string, unknown>;
  validation_report?: Record<string, unknown>;
  comments?: Array<Record<string, unknown>>;
  diff?: string;
}

interface OperatorMe {
  actor: {
    memberships: Array<{
      spaceId: string;
      pathPrefix: string | null;
      permissions: string[];
    }>;
  } | null;
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function summary(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "—";
  return JSON.stringify(value);
}

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [review, me] = await Promise.all([
    akp<ReviewResponse>(`/v1/reviews/${id}`),
    akp<OperatorMe>("/v1/operator/me"),
  ]);
  const impact = review.impact_manifest ?? {};
  const validation = review.validation_report ?? {};
  const memberships = me.actor?.memberships ?? [];
  const reviewMembership = memberships.find(
    (membership) =>
      membership.spaceId === review.space_id &&
      membership.permissions.includes("knowledge:review"),
  );
  const adminMembership = memberships.find(
    (membership) =>
      membership.spaceId === review.space_id &&
      membership.permissions.includes("admin"),
  );
  const canDecide = Boolean(reviewMembership);
  const canApprove = reviewMembership?.pathPrefix === null;
  const canRollback = adminMembership?.pathPrefix === null;
  const pending = ["PENDING", "CHANGES_REQUESTED"].includes(review.status);
  const candidates = records(
    impact.knowledgeCandidates ?? impact.knowledge_candidates ?? impact.candidates,
  );
  const contradictions = records(impact.contradictions ?? impact.conflicts);
  const proposedChanges = records(impact.proposedChanges ?? impact.proposed_changes);
  const probes = records(validation.probeResults ?? impact.probes);
  const issues = records(validation.issues);
  const evidenceIds = strings(impact.evidenceIds ?? impact.evidence_ids);
  const impactedIds = strings(
    impact.impactedDocumentIds ?? impact.impacted_document_ids,
  );

  async function decide(formData: FormData) {
    "use server";
    const decision = String(formData.get("decision") ?? "");
    const reason = String(formData.get("reason") ?? "").trim();
    const idempotencyKey = String(formData.get("idempotencyKey") ?? "");
    await akp(`/v1/reviews/${id}/decision`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({ decision, reason }),
    });
    revalidatePath(`/reviews/${id}`);
  }

  async function rollback(formData: FormData) {
    "use server";
    const reason = String(formData.get("reason") ?? "").trim();
    const idempotencyKey = String(formData.get("idempotencyKey") ?? "");
    await akp(`/v1/reviews/${id}/rollback`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({ reason }),
    });
    revalidatePath(`/reviews/${id}`);
  }

  return (
    <main>
      <p className="muted">Evidencia, diff, impacto, probes y decisión humana</p>
      <h1>Revisión {id}</h1>
      <p>
        <span className="badge">{review.status}</span>
        <span className="badge">
          {String(impact.disposition ?? "UNSPECIFIED")}
        </span>
      </p>

      <div className="grid">
        <div className="card">
          <span className="muted">Base</span>
          <p>
            <code>{review.base_commit ?? "—"}</code>
          </p>
        </div>
        <div className="card">
          <span className="muted">Head propuesto</span>
          <p>
            <code>{review.head_commit ?? "—"}</code>
          </p>
        </div>
        <div className="card">
          <span className="muted">Merge publicado</span>
          <p>
            <code>{review.merged_commit ?? "No publicado"}</code>
          </p>
        </div>
        <div className="card">
          <span className="muted">Validación</span>
          <p>{issues.length ? `${issues.length} issues` : "Sin issues reportados"}</p>
        </div>
      </div>

      {pending && canDecide ? (
        <form action={decide} className="card" style={{ marginTop: 16 }}>
          <h2>Decisión</h2>
          <input
            type="hidden"
            name="idempotencyKey"
            value={`web-review-${id}-${randomUUID()}`}
          />
          <label>
            Razón
            <input name="reason" required minLength={3} />
          </label>
          <p>
            {canApprove ? (
              <button name="decision" value="APPROVE">
                Aprobar y publicar
              </button>
            ) : null}{" "}
            <button name="decision" value="REQUEST_CHANGES">
              Solicitar cambios
            </button>{" "}
            <button name="decision" value="REJECT">
              Rechazar
            </button>
          </p>
          {!canApprove ? (
            <p className="muted">
              La aprobación requiere acceso de revisión sin restricción de path; el servidor vuelve a validar el scope.
            </p>
          ) : null}
        </form>
      ) : pending ? (
        <div className="card" style={{ marginTop: 16 }}>
          Esta sesión puede leer la revisión, pero no decidirla.
        </div>
      ) : null}

      {review.status === "APPROVED" && canRollback ? (
        <form action={rollback} className="card" style={{ marginTop: 16 }}>
          <h2>Rollback gobernado</h2>
          <input
            type="hidden"
            name="idempotencyKey"
            value={`web-rollback-${id}-${randomUUID()}`}
          />
          <label>
            Motivo del rollback
            <input name="reason" required minLength={3} />
          </label>{" "}
          <button type="submit">Ejecutar rollback</button>
        </form>
      ) : null}

      <h2>Propuesta de compilación</h2>
      <div className="grid">
        <section className="card">
          <h3>Identidad</h3>
          <p>{summary(impact.identity)}</p>
        </section>
        <section className="card">
          <h3>Evidencia</h3>
          {evidenceIds.length ? (
            <ul>
              {evidenceIds.map((evidenceId) => (
                <li key={evidenceId}>
                  <code>{evidenceId}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">La evidencia detallada se conserva en el manifest.</p>
          )}
        </section>
        <section className="card">
          <h3>Impacto</h3>
          <p>{impactedIds.length} documentos explícitamente impactados.</p>
          {impactedIds.length ? (
            <ul>
              {impactedIds.map((documentId) => (
                <li key={documentId}>
                  <code>{documentId}</code>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>

      {candidates.length ? (
        <section>
          <h2>Candidatos de conocimiento</h2>
          {candidates.map((candidate, index) => (
            <article className="card" key={String(candidate.candidate_id ?? index)} style={{ marginTop: 12 }}>
              <p>
                <span className="badge">{summary(candidate.kind)}</span>
                <span className="badge">{summary(candidate.proposed_action)}</span>
              </p>
              <p>{summary(candidate.statement)}</p>
              <small>confidence {summary(candidate.confidence)}</small>
            </article>
          ))}
        </section>
      ) : null}

      <h2>Cambios de archivo</h2>
      {proposedChanges.length ? (
        <table>
          <thead>
            <tr>
              <th>Operación</th>
              <th>Path</th>
              <th>Razones</th>
            </tr>
          </thead>
          <tbody>
            {proposedChanges.map((change, index) => (
              <tr key={`${summary(change.path)}-${index}`}>
                <td>{summary(change.operation)}</td>
                <td>
                  <code>{summary(change.path)}</code>
                </td>
                <td>{summary(change.reasons)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">Sin cambios propuestos.</p>
      )}

      <div className="grid" style={{ marginTop: 20 }}>
        <section className="card">
          <h2>Contradicciones</h2>
          {contradictions.length ? (
            contradictions.map((conflict, index) => (
              <div key={index}>
                <strong>{summary(conflict.explanation ?? conflict.status)}</strong>
                <p>{summary(conflict)}</p>
              </div>
            ))
          ) : (
            <p className="muted">Sin contradicciones reportadas.</p>
          )}
        </section>
        <section className="card">
          <h2>Probes</h2>
          {probes.length ? (
            <ul>
              {probes.map((probe, index) => (
                <li key={String(probe.id ?? index)}>
                  <strong>{summary(probe.passed) === "true" ? "PASS" : "FAIL"}</strong>{" "}
                  {summary(probe.question ?? probe.description ?? probe.method)}
                  {probe.criticality ? ` · ${summary(probe.criticality)}` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Sin probes registrados.</p>
          )}
        </section>
      </div>

      <h2>Validación determinista</h2>
      {issues.length ? (
        <table>
          <thead>
            <tr>
              <th>Severidad</th>
              <th>Path</th>
              <th>Mensaje</th>
            </tr>
          </thead>
          <tbody>
            {issues.map((issue, index) => (
              <tr key={index}>
                <td>{summary(issue.severity)}</td>
                <td>{summary(issue.path)}</td>
                <td>{summary(issue.message ?? issue.code)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="card">Validación sin issues reportados.</p>
      )}

      <h2>Diff Git</h2>
      <pre>{review.diff || "Sin diff disponible."}</pre>

      {review.decision_reason ? (
        <p className="card">
          <strong>Razón de decisión:</strong> {review.decision_reason}
        </p>
      ) : null}

      <details>
        <summary>Inspeccionar manifest/validation JSON</summary>
        <pre>{JSON.stringify({ impact, validation }, null, 2)}</pre>
      </details>
    </main>
  );
}
