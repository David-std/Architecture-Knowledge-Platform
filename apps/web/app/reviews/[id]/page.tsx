import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { akp } from "../../../lib/api";
import {
  asRecord,
  asStrings,
  normalizeReviewManifest,
} from "../../../lib/review-manifest";

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

function summary(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (value === null || value === undefined) return "—";
  return JSON.stringify(value);
}

function locatorSummary(value: unknown): string {
  const locator = asRecord(value);
  const parts = [
    ["kind", locator.kind],
    ["path", locator.path],
    ["page", locator.page],
    ["slide", locator.slide],
    ["paragraph", locator.paragraph],
    ["table", locator.table],
    ["start_line", locator.start_line],
    ["start_char", locator.start_char],
  ]
    .filter(
      (entry): entry is [string, string | number] =>
        typeof entry[1] === "string" || typeof entry[1] === "number",
    )
    .map(([key, item]) => `${key}=${item}`);
  return parts.length ? parts.join(" · ") : "Locator estructurado disponible";
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
  const normalized = normalizeReviewManifest(impact, validation);
  const {
    reviewContext,
    identity,
    evidence,
    existingCandidates,
    candidates,
    contradictions,
    proposedChanges,
    probes,
    evidenceIds,
    impactedIds,
    warnings,
  } = normalized;
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
  const issues = Array.isArray(validation.issues)
    ? validation.issues.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
  const identityCandidates = asStrings(identity.candidates);
  const hasCompilerContext = Object.keys(reviewContext).length > 0;

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
      <p className="muted">
        Evidencia, diff, impacto, probes y decisión humana
      </p>
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
          <p>
            {issues.length
              ? `${issues.length} issues`
              : "Sin issues reportados"}
          </p>
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
              La aprobación requiere acceso de revisión sin restricción de path;
              el servidor vuelve a validar el scope.
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
      {!hasCompilerContext ? (
        <p className="card muted">
          Esta revisión no conserva el contexto estructurado del compiler. Se
          muestran los campos históricos disponibles sin reconstruir ni inferir
          información ausente.
        </p>
      ) : null}
      <div className="grid">
        <section className="card">
          <h3>Identidad</h3>
          <p>
            <span className="badge">
              {summary(identity.classification ?? "NO_REPORTADA")}
            </span>
          </p>
          <p>{summary(identity.reason)}</p>
          {typeof identity.existingDocumentId === "string" ? (
            <p>
              Documento existente: <code>{identity.existingDocumentId}</code>
            </p>
          ) : null}
          {identityCandidates.length ? (
            <ul>
              {identityCandidates.map((documentId) => (
                <li key={documentId}>
                  <code>{documentId}</code>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
        <section className="card">
          <h3>Evidencia</h3>
          {evidence.length ? (
            evidence.map((item, index) => (
              <article key={String(item.id ?? index)}>
                <p>
                  <code>{summary(item.id)}</code>
                </p>
                <p>{locatorSummary(item.locator)}</p>
                {typeof item.excerptHash === "string" ? (
                  <small>
                    hash <code>{item.excerptHash}</code>
                  </small>
                ) : null}
              </article>
            ))
          ) : evidenceIds.length ? (
            <ul>
              {evidenceIds.map((evidenceId) => (
                <li key={evidenceId}>
                  <code>{evidenceId}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Sin evidencia estructurada persistida.</p>
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

      {warnings.length ? (
        <section className="card" style={{ marginTop: 16 }}>
          <h3>Warnings del compiler</h3>
          <ul>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {existingCandidates.length ? (
        <section>
          <h2>Conocimiento existente considerado</h2>
          <table>
            <thead>
              <tr>
                <th>Documento</th>
                <th>Tipo</th>
                <th>Trust</th>
                <th>Score</th>
                <th>Razones</th>
              </tr>
            </thead>
            <tbody>
              {existingCandidates.map((candidate, index) => (
                <tr key={String(candidate.documentId ?? index)}>
                  <td>
                    <strong>{summary(candidate.title)}</strong>
                    <br />
                    <code>{summary(candidate.path)}</code>
                  </td>
                  <td>{summary(candidate.type)}</td>
                  <td>{summary(candidate.trust)}</td>
                  <td>{summary(candidate.score)}</td>
                  <td>{asStrings(candidate.reasons).join(" · ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <h2>Candidatos de conocimiento</h2>
      {candidates.length ? (
        candidates.map((candidate, index) => {
          const candidateEvidence = asStrings(
            candidate.evidenceIds ?? candidate.evidence_ids,
          );
          return (
            <article
              className="card"
              key={String(
                candidate.candidateId ?? candidate.candidate_id ?? index,
              )}
              style={{ marginTop: 12 }}
            >
              <p>
                <span className="badge">{summary(candidate.kind)}</span>
                <span className="badge">
                  {summary(
                    candidate.proposedAction ?? candidate.proposed_action,
                  )}
                </span>
              </p>
              <p>{summary(candidate.statement)}</p>
              {candidate.scope ? (
                <p className="muted">{summary(candidate.scope)}</p>
              ) : null}
              <small>confidence {summary(candidate.confidence)}</small>
              {typeof candidate.existingDocumentId === "string" ? (
                <p>
                  Documento existente:{" "}
                  <code>{candidate.existingDocumentId}</code>
                </p>
              ) : null}
              {candidateEvidence.length ? (
                <p>
                  Evidencia:{" "}
                  {candidateEvidence.map((item) => (
                    <code key={item} style={{ marginRight: 8 }}>
                      {item}
                    </code>
                  ))}
                </p>
              ) : null}
            </article>
          );
        })
      ) : (
        <p className="muted">Sin candidatos de conocimiento persistidos.</p>
      )}

      <h2>Cambios de archivo</h2>
      {proposedChanges.length ? (
        <table>
          <thead>
            <tr>
              <th>Operación</th>
              <th>Path</th>
              <th>Razones</th>
              <th>Evidencia</th>
            </tr>
          </thead>
          <tbody>
            {proposedChanges.map((change, index) => (
              <tr key={`${summary(change.path)}-${index}`}>
                <td>{summary(change.operation)}</td>
                <td>
                  <code>{summary(change.path)}</code>
                </td>
                <td>{asStrings(change.reasons).join(" · ") || "—"}</td>
                <td>
                  {asStrings(change.evidenceIds ?? change.evidence_ids).join(
                    " · ",
                  ) || "—"}
                </td>
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
            contradictions.map((conflict, index) => {
              const supportingEvidence = asStrings(
                conflict.evidenceIds ??
                  conflict.evidence_ids ??
                  conflict.evidence,
              );
              return (
                <article
                  key={String(
                    conflict.candidateId ?? conflict.candidate_id ?? index,
                  )}
                  style={{ marginBottom: 16 }}
                >
                  <p>
                    <span className="badge">
                      {summary(conflict.severity ?? conflict.proposedStatus)}
                    </span>
                  </p>
                  <p>
                    <strong>
                      {summary(conflict.explanation ?? conflict.reason)}
                    </strong>
                  </p>
                  <table>
                    <tbody>
                      <tr>
                        <th>Candidato</th>
                        <td>
                          <code>
                            {summary(
                              conflict.candidateId ??
                                conflict.candidate_id ??
                                conflict.candidate,
                            )}
                          </code>
                        </td>
                      </tr>
                      <tr>
                        <th>Existente</th>
                        <td>
                          <code>
                            {summary(
                              conflict.existingDocumentId ??
                                conflict.existing_document_id ??
                                conflict.existing,
                            )}
                          </code>
                        </td>
                      </tr>
                      <tr>
                        <th>Evidencia</th>
                        <td>
                          {supportingEvidence.length
                            ? supportingEvidence.join(" · ")
                            : "No reportada"}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </article>
              );
            })
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
                  <strong>
                    {typeof probe.passed === "boolean"
                      ? probe.passed
                        ? "PASS"
                        : "FAIL"
                      : "PENDIENTE"}
                  </strong>{" "}
                  {summary(probe.question ?? probe.description ?? probe.method)}
                  {probe.criticality ? ` · ${summary(probe.criticality)}` : ""}
                  {asStrings(probe.evidenceIds ?? probe.evidence_ids).length
                    ? ` · evidencia ${asStrings(
                        probe.evidenceIds ?? probe.evidence_ids,
                      ).join(", ")}`
                    : ""}
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
