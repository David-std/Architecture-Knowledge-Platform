import { akp } from "../../lib/api";

interface EvalRun {
  id: string;
  vault_id: string;
  eval_pack: string;
  corpus_revision: string;
  status: string;
  created_at: string;
  metrics: {
    cases?: number;
    passed?: number;
    criticalFailures?: number;
    meanRecallAt5?: number;
    meanRecallAt10?: number;
    meanReciprocalRank?: number;
    meanNdcgAt10?: number;
    meanEvidenceRecall?: number;
    meanCitationPrecision?: number;
    unsupportedAnswerRate?: number;
    noAnswerAccuracy?: number;
    meanLatencyMs?: number;
    meanEstimatedTokens?: number;
    exactIdentifierRecall?: number;
    crossLanguageRecall?: number;
    results?: unknown[];
    [key: string]: unknown;
  };
}

function percentage(value: unknown): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${(numeric * 100).toFixed(1)}%` : "—";
}

function number(value: unknown, digits = 2): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : "—";
}

function bar(value: unknown, inverse = false) {
  const numeric = Number(value);
  const bounded = Number.isFinite(numeric)
    ? Math.max(0, Math.min(1, inverse ? 1 - numeric : numeric))
    : 0;
  return (
    <span
      aria-label={`${Math.round(bounded * 100)} percent`}
      style={{
        display: "inline-block",
        width: 88,
        height: 8,
        border: "1px solid var(--line)",
        borderRadius: 999,
        overflow: "hidden",
        verticalAlign: "middle",
      }}
    >
      <span
        style={{
          display: "block",
          width: `${bounded * 100}%`,
          height: "100%",
          background: "var(--accent)",
        }}
      />
    </span>
  );
}

export default async function EvalsPage() {
  const result = await akp<{ runs: EvalRun[] }>("/v1/evals");
  const runs = result.runs ?? [];
  const latest = runs[0];

  return (
    <main>
      <p className="muted">Comparación de recuperación, grounding y no-answer</p>
      <h1>Evaluaciones</h1>

      <div className="card" role="note">
        <strong>Límite de evidencia</strong>
        <p>
          Estos resultados describen el pack de evaluación registrado y la revisión de corpus indicada. Un run con estado PASSED no demuestra por sí solo calidad de producción ni sustituye un benchmark real-corpus/held-out.
        </p>
      </div>

      {latest ? (
        <div className="grid" style={{ marginTop: 16 }}>
          <div className="card">
            <span className="muted">Último estado</span>
            <p className="metric">{latest.status}</p>
          </div>
          <div className="card">
            <span className="muted">Recall@10</span>
            <p className="metric">{percentage(latest.metrics.meanRecallAt10)}</p>
          </div>
          <div className="card">
            <span className="muted">MRR</span>
            <p className="metric">{number(latest.metrics.meanReciprocalRank, 3)}</p>
          </div>
          <div className="card">
            <span className="muted">Unsupported answer rate</span>
            <p className="metric">{percentage(latest.metrics.unsupportedAnswerRate)}</p>
          </div>
        </div>
      ) : null}

      <h2>Runs persistidos</h2>
      {runs.length ? (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Pack / revisión</th>
                <th>Estado</th>
                <th>Recall@10</th>
                <th>MRR</th>
                <th>nDCG@10</th>
                <th>Evidencia</th>
                <th>Citas</th>
                <th>No-answer</th>
                <th>Unsupported</th>
                <th>Latencia</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    <code>{run.id.slice(0, 8)}</code>
                    <br />
                    <small>{new Date(run.created_at).toLocaleString()}</small>
                  </td>
                  <td>
                    {run.eval_pack}
                    <br />
                    <small>
                      <code>{run.corpus_revision.slice(0, 12)}</code>
                    </small>
                  </td>
                  <td>
                    <span className="badge">{run.status}</span>
                    <br />
                    <small>
                      {run.metrics.passed ?? 0}/{run.metrics.cases ?? 0} casos · {run.metrics.criticalFailures ?? 0} críticos
                    </small>
                  </td>
                  <td>
                    {bar(run.metrics.meanRecallAt10)}{" "}
                    {percentage(run.metrics.meanRecallAt10)}
                  </td>
                  <td>{number(run.metrics.meanReciprocalRank, 3)}</td>
                  <td>{number(run.metrics.meanNdcgAt10, 3)}</td>
                  <td>{percentage(run.metrics.meanEvidenceRecall)}</td>
                  <td>{percentage(run.metrics.meanCitationPrecision)}</td>
                  <td>{percentage(run.metrics.noAnswerAccuracy)}</td>
                  <td>
                    {bar(run.metrics.unsupportedAnswerRate, true)}{" "}
                    {percentage(run.metrics.unsupportedAnswerRate)}
                  </td>
                  <td>{number(run.metrics.meanLatencyMs, 1)} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card">No hay runs de evaluación visibles para los vaults autorizados.</div>
      )}

      {runs.length ? (
        <section>
          <h2>Coste y slices</h2>
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Tokens estimados</th>
                <th>Recall IDs exactos</th>
                <th>Recall cross-language</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={`cost-${run.id}`}>
                  <td>
                    <code>{run.id.slice(0, 8)}</code>
                  </td>
                  <td>{number(run.metrics.meanEstimatedTokens, 0)}</td>
                  <td>{percentage(run.metrics.exactIdentifierRecall)}</td>
                  <td>{percentage(run.metrics.crossLanguageRecall)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <details style={{ marginTop: 20 }}>
        <summary>Inspeccionar JSON de runs</summary>
        <pre>{JSON.stringify(runs, null, 2)}</pre>
      </details>
    </main>
  );
}
