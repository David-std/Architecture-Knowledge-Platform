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
  reviewPolicy?: Record<string, unknown>;
  approvalProgress?: {
    reviewRound: number;
    count: number;
    minimumApprovals: number;
    remainingApprovals: number;
    pinned: boolean;
  };
  approvals?: Array<Record<string, unknown>>;
  evidenceDetails?: Array<Record<string, unknown>>;
  assuranceFindings?: Array<Record<string, unknown>>;
  graphImpact?: Array<Record<string, unknown>>;
  codeImpact?: Array<Record<string, unknown>>;
  temporalImpact?: {
    head: Record<string, unknown> | null;
    facts: Array<Record<string, unknown>>;
  };
  affectedEvals?: Array<Record<string, unknown>>;
  affectedTests?: Array<Record<string, unknown>>;
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
  const comments = review.comments ?? [];
  const approvals = review.approvals ?? [];
  const evidenceDetails = review.evidenceDetails ?? [];
  const assuranceFindings = review.assuranceFindings ?? [];
  const graphImpact = review.graphImpact ?? [];
  const codeImpact = review.codeImpact ?? [];
  const temporalHead = review.temporalImpact?.head ?? null;
  const temporalFacts = review.temporalImpact?.facts ?? [];
  const affectedEvals = review.affectedEvals ?? [];
  const affectedTests = review.affectedTests ?? [];
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

      <section className="card" style={{ marginTop: 16 }}>
        <h2>Gobernanza de revisión</h2>
        <div className="grid">
          <div>
            <span className="muted">Política</span>
            <p>{summary(review.reviewPolicy ?? "No reportada")}</p>
          </div>
          <div>
            <span className="muted">Aprobaciones</span>
            <p>
              {review.approvalProgress
                ? `${review.approvalProgress.count}/${review.approvalProgress.minimumApprovals}`
                : "No disponible"}
            </p>
            {review.approvalProgress ? (
              <small>
                round {review.approvalProgress.reviewRound} · remaining{" "}
                {review.approvalProgress.remainingApprovals} ·{" "}
                {review.approvalProgress.pinned ? "pinned" : "dynamic"}
              </small>
            ) : null}
          </div>
        </div>
        {approvals.length ? (
          <ul>
            {approvals.map((approval, index) => (
              <li key={String(approval.id ?? index)}>
                {summary(
                  approval.reviewer_role ??
                    approval.reviewerRole ??
                    approval.principal_kind,
                )}{" "}
                · {summary(approval.reason)} ·{" "}
                {summary(approval.created_at ?? approval.createdAt)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Aún no hay aprobaciones registradas.</p>
        )}
      </section>

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

      <h2>Comentarios de revisión</h2>
      {comments.length ? (
        <div className="card">
          {comments.map((comment, index) => (
            <article
              key={String(comment.id ?? index)}
              style={{ marginBottom: 12 }}
            >
              <strong>{summary(comment.body)}</strong>
              <br />
              <small>
                {comment.path
                  ? `${summary(comment.path)}:${summary(comment.line)} · `
                  : ""}
                {summary(comment.created_at)}
              </small>
            </article>
          ))}
        </div>
      ) : (
        <p className="card muted">No hay comentarios registrados.</p>
      )}

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

      <h2>Excerpts y locators de evidencia</h2>
      {evidenceDetails.length ? (
        <div className="card">
          {evidenceDetails.map((entry, index) => (
            <article
              key={String(entry.id ?? index)}
              style={{ marginBottom: 16 }}
            >
              <p>
                <strong>
                  {summary(entry.source_title ?? entry.source_id)}
                </strong>
                <br />
                <small>{locatorSummary(entry.locator)}</small>
              </p>
              <blockquote>{summary(entry.excerpt)}</blockquote>
              <small>
                evidence <code>{summary(entry.id)}</code>
              </small>
            </article>
          ))}
        </div>
      ) : (
        <p className="card muted">
          No hay excerpts persistidos para los evidence IDs de esta revisión.
        </p>
      )}

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

      <h2>Impacto integrado</h2>
      <div className="grid">
        <section className="card">
          <h3>Graph impact</h3>
          {graphImpact.length ? (
            <ul>
              {graphImpact.map((edge, index) => (
                <li key={String(edge.id ?? index)}>
                  <code>{summary(edge.from_external_id ?? edge.from)}</code> —
                  {summary(edge.relation_type)} a{" "}
                  <code>{summary(edge.to_external_id ?? edge.to)}</code>
                  <br />
                  <small>provenance {summary(edge.provenance)}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              No hay relaciones de conocimiento persistidas para los documentos
              impactados.
            </p>
          )}
        </section>

        <section className="card">
          <h3>Temporal impact</h3>
          <p>
            Truth head:{" "}
            <code>
              {summary(temporalHead?.revision_hash ?? "sin revisión")}
            </code>
          </p>
          {temporalFacts.length ? (
            <ul>
              {temporalFacts.map((fact, index) => (
                <li key={String(fact.id ?? index)}>
                  <strong>{summary(fact.subject_ref)}</strong>{" "}
                  {summary(fact.predicate)} {summary(fact.object)}
                  <br />
                  <small>
                    valid {summary(fact.valid_from)} a{" "}
                    {summary(fact.valid_to ?? "open")} · recorded{" "}
                    {summary(fact.recorded_at)}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              No hay hechos temporales enlazados por la evidencia de esta
              revisión.
            </p>
          )}
        </section>

        <section className="card">
          <h3>Code blast radius</h3>
          {codeImpact.length ? (
            <ul>
              {codeImpact.map((link, index) => (
                <li key={String(link.id ?? index)}>
                  <code>{summary(link.code_repository)}</code> @{" "}
                  <code>{summary(link.code_commit_sha)}</code>
                  <br />
                  {summary(link.relation_type)} ·{" "}
                  {summary(asRecord(link.code_node_identity).canonicalKey)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              No hay bridges de conocimiento a código aprobados para esta
              revisión o sus documentos impactados.
            </p>
          )}
        </section>

        <section className="card">
          <h3>Tests afectados</h3>
          {affectedTests.length ? (
            <ul>
              {affectedTests.map((test, index) => (
                <li key={String(test.test_node_id ?? index)}>
                  <strong>{summary(test.canonical_key)}</strong>
                  <br />
                  <small>
                    {summary(test.derivation)} · confidence{" "}
                    {summary(test.confidence)} · revision{" "}
                    {summary(test.provenance_revision)}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              No hay tests vinculados por bridges CODE revisados.
            </p>
          )}
        </section>

        <section className="card">
          <h3>Evaluaciones afectadas</h3>
          {affectedEvals.length ? (
            <ul>
              {affectedEvals.map((evaluation, index) => (
                <li key={String(evaluation.event_id ?? index)}>
                  <span className="badge">
                    {summary(evaluation.status ?? "REQUESTED")}
                  </span>{" "}
                  {summary(evaluation.eval_pack ?? "pending")} · corpus{" "}
                  <code>{summary(evaluation.corpus_revision)}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              No hay eval run durable enlazado a esta revisión todavía.
            </p>
          )}
        </section>

        <section className="card">
          <h3>Assurance findings relacionados</h3>
          {assuranceFindings.length ? (
            <ul>
              {assuranceFindings.map((finding, index) => (
                <li key={String(finding.id ?? index)}>
                  <span className="badge">{summary(finding.severity)}</span>{" "}
                  <strong>{summary(finding.code)}</strong>
                  <br />
                  {summary(finding.summary)}
                  <br />
                  <small>
                    {summary(finding.detector)} · {summary(finding.status)}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              No hay findings OPEN/ACKNOWLEDGED relacionados por target.
            </p>
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
