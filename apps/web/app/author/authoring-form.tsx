"use client";

import Link from "next/link";
import { useActionState, useEffect, useMemo, useState } from "react";
import { saveAuthorDraft, submitAuthorReview } from "./actions";
import { InfoTooltip } from "../components/info-tooltip";
import {
  AUTHOR_RECOVERY_STORAGE_KEY,
  parseAuthorRecovery,
  serializeAuthorRecovery,
} from "./authoring-recovery";
import type { AuthorActionState, AuthorDraftState } from "./authoring-types";

type Vault = {
  id: string;
  space_id: string;
  vault_key: string;
  name: string;
};

const INITIAL_ACTION_STATE: AuthorActionState = { phase: "EDITING" };

function templateDocument(): string {
  return [
    "---",
    "id: RULE-CHANGE-ME",
    "type: rule",
    "title: Describe the governed knowledge change",
    "status: ACTIVE",
    "knowledge_layer: rules",
    "---",
    "",
    "# Describe the governed knowledge change",
    "",
    "Explain the rule, decision, constraint, or reusable knowledge here.",
    "",
    "## Evidence / rationale",
    "",
    "Reference the evidence that supports this proposal. The server will still",
    "validate the document and the reviewer remains responsible for publication.",
    "",
  ].join("\n");
}

function initialDraft(vault: Vault): AuthorDraftState {
  return {
    spaceId: vault.space_id,
    vaultId: vault.id,
    summary: "",
    path: "20-knowledge/rules/new-rule.md",
    reason: "",
    content: templateDocument(),
    updatedAt: "",
  };
}

export function AuthoringForm({ vaults }: { vaults: Vault[] }) {
  const first = vaults[0]!;
  const [draft, setDraft] = useState<AuthorDraftState>(() =>
    initialDraft(first),
  );
  const [recoveredAt, setRecoveredAt] = useState<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState(
    "Autosave local listo. Este estado no es conocimiento canónico.",
  );
  const [saveState, saveAction, saving] = useActionState(
    saveAuthorDraft,
    INITIAL_ACTION_STATE,
  );
  const [submitState, submitAction, submitting] = useActionState(
    submitAuthorReview,
    INITIAL_ACTION_STATE,
  );

  const locked =
    saveState.phase === "SAVED" || submitState.phase === "SUBMITTED";
  const activeReviewId =
    submitState.reviewId ??
    (saveState.phase === "SAVED" ? saveState.reviewId : undefined);

  useEffect(() => {
    const recovered = parseAuthorRecovery(
      window.localStorage.getItem(AUTHOR_RECOVERY_STORAGE_KEY),
    );
    if (!recovered) return;
    if (!vaults.some((vault) => vault.id === recovered.vaultId)) {
      window.localStorage.removeItem(AUTHOR_RECOVERY_STORAGE_KEY);
      setRecoveryNotice(
        "Se descartó un recovery local cuyo vault ya no está autorizado.",
      );
      return;
    }
    setDraft(recovered);
    setRecoveredAt(recovered.updatedAt);
    setRecoveryNotice(
      "Recovery local restaurado. Todavía no se ha guardado ni publicado en AKP.",
    );
  }, [vaults]);

  useEffect(() => {
    if (locked) return;
    const timeout = window.setTimeout(() => {
      const serialized = serializeAuthorRecovery({
        spaceId: draft.spaceId,
        vaultId: draft.vaultId,
        summary: draft.summary,
        path: draft.path,
        reason: draft.reason,
        content: draft.content,
      });
      window.localStorage.setItem(AUTHOR_RECOVERY_STORAGE_KEY, serialized);
      const parsed = parseAuthorRecovery(serialized);
      setRecoveredAt(parsed?.updatedAt ?? null);
      setRecoveryNotice(
        "Recovery local actualizado. No crea commits, reviews ni publicaciones.",
      );
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [draft, locked]);

  useEffect(() => {
    if (saveState.phase !== "SAVED") return;
    window.localStorage.removeItem(AUTHOR_RECOVERY_STORAGE_KEY);
    setRecoveredAt(null);
    setRecoveryNotice(
      "Recovery local limpiado: el contenido ya tiene un draft Git gobernado.",
    );
  }, [saveState.phase]);

  const selectedVault = useMemo(
    () => vaults.find((vault) => vault.id === draft.vaultId) ?? first,
    [draft.vaultId, first, vaults],
  );

  function update<K extends keyof AuthorDraftState>(
    key: K,
    value: AuthorDraftState[K],
  ) {
    setDraft((current) => {
      if (key === "vaultId") {
        const nextVault = vaults.find((vault) => vault.id === value);
        if (nextVault) {
          return {
            ...current,
            vaultId: nextVault.id,
            spaceId: nextVault.space_id,
          };
        }
      }
      return { ...current, [key]: value };
    });
  }

  function discardRecovery() {
    window.localStorage.removeItem(AUTHOR_RECOVERY_STORAGE_KEY);
    setDraft(initialDraft(selectedVault));
    setRecoveredAt(null);
    setRecoveryNotice(
      "Recovery local descartado. No se eliminó ningún draft Git ni review.",
    );
  }

  return (
    <div>
      <section className="card">
        <strong>Fronteras del flujo</strong>
        <ol>
          <li>
            <strong>Autosave:</strong> recovery local del navegador; no
            canónico.
          </li>
          <li>
            <strong>Save:</strong> valida y crea un commit Git de draft aislado.
          </li>
          <li>
            <strong>Submit review:</strong> registra el envío al flujo de
            revisión.
          </li>
          <li>
            <strong>Publish:</strong> solo ocurre por una decisión autorizada en
            Review Workspace.
          </li>
        </ol>
      </section>

      <div
        className="card recovery-notice-card"
        role="status"
        aria-live="polite"
      >
        <div className="recovery-notice-info">
          <span className="recovery-status-pill">Recovery local</span>
          <span className="recovery-notice-text">
            {recoveryNotice}
            {recoveredAt ? (
              <>
                {" "}
                Último recovery:{" "}
                <time dateTime={recoveredAt}>{recoveredAt}</time>.
              </>
            ) : null}
          </span>
        </div>
        {!locked ? (
          <div className="recovery-notice-action">
            <button
              type="button"
              onClick={discardRecovery}
              className="action-button-secondary-compact"
            >
              Descartar recovery local
            </button>
          </div>
        ) : null}
      </div>

      <form
        action={saveAction}
        className="card authoring-form-card"
        style={{ marginTop: 16 }}
      >
        <input type="hidden" name="spaceId" value={draft.spaceId} />

        <div className="author-grid-2col">
          <label>
            <span className="form-label-title">
              Vault
              <InfoTooltip text="Repositorio canónico de conocimiento autorizado donde se alojará este documento." />
            </span>
            <select
              name="vaultId"
              value={draft.vaultId}
              disabled={locked || saving}
              onChange={(event) => update("vaultId", event.target.value)}
            >
              {vaults.map((vault) => (
                <option key={vault.id} value={vault.id}>
                  {vault.name} ({vault.vault_key})
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="form-label-title">
              Path gobernado
              <InfoTooltip text="Ruta relativa del archivo Markdown (.md) dentro del repositorio Git, según el espacio de nombres permitido por tu perfil." />
            </span>
            <input
              name="path"
              value={draft.path}
              disabled={locked || saving}
              required
              onChange={(event) => update("path", event.target.value)}
              aria-describedby="author-path-help"
              placeholder="20-knowledge/rules/mi-regla.md"
            />
          </label>
        </div>
        <small id="author-path-help" className="muted form-field-example">
          Ejemplo sustancial:{" "}
          <code>20-knowledge/rules/database-schema-conventions.md</code> (path
          relativo Markdown autorizado).
        </small>

        <div className="author-field-block">
          <label>
            <span className="form-label-title">
              Resumen del cambio
              <InfoTooltip text="Descripción estructurada y concisa del cambio propuesto. Explica qué conocimiento se agrega, altera o deroga." />
            </span>
            <textarea
              name="summary"
              value={draft.summary}
              disabled={locked || saving}
              required
              minLength={3}
              maxLength={500}
              rows={3}
              className="form-textarea-summary"
              onChange={(event) => update("summary", event.target.value)}
              placeholder="Describe con precisión qué conocimiento se propone incorporar, actualizar o derogar…"
            />
          </label>
          <small className="muted form-field-example">
            Ejemplo sustancial: &quot;Actualización de política de consistencia
            de esquemas Postgres ante migraciones idempotentes en réplicas de
            lectura.&quot;
          </small>
        </div>

        <div className="author-field-block">
          <label>
            <span className="form-label-title">
              Razón / Justificación arquitectónica
              <InfoTooltip text="Justificación técnica o de negocio. Explica por qué es necesario este cambio y cuál es el impacto de no aplicarlo." />
            </span>
            <textarea
              name="reason"
              value={draft.reason}
              disabled={locked || saving}
              required
              minLength={3}
              rows={2}
              className="form-textarea-reason"
              onChange={(event) => update("reason", event.target.value)}
              placeholder="Explica la causa técnica, incidente o decisión que motiva este cambio gobernado…"
            />
          </label>
          <small className="muted form-field-example">
            Ejemplo sustancial: &quot;Prevenir fallos de replicación asegurando
            que todas las mutaciones apliquen con cláusulas IF NOT EXISTS
            conforme a ADR-042.&quot;
          </small>
        </div>

        <div className="author-field-block">
          <label>
            <span className="form-label-title">
              Documento Markdown canónico
              <InfoTooltip text="Contenido completo del documento en formato Markdown con frontmatter YAML (id, type, title, status, knowledge_layer)." />
            </span>
            <textarea
              name="content"
              value={draft.content}
              disabled={locked || saving}
              required
              rows={20}
              className="markdown-editor-textarea"
              onChange={(event) => update("content", event.target.value)}
              aria-describedby="author-content-help"
            />
          </label>
          <small id="author-content-help" className="muted form-field-hint">
            El servidor valida frontmatter, KnowledgeProfile, trust boundary y
            path antes de crear el draft Git.
          </small>
        </div>

        {!locked ? (
          <div className="author-actions-bar">
            <button
              type="submit"
              disabled={saving}
              className="action-button-primary"
            >
              {saving ? "Guardando…" : "Save: crear draft Git"}
            </button>
          </div>
        ) : null}
      </form>

      {saveState.phase === "ERROR" ? (
        <div className="card" role="alert">
          Save rechazado: {saveState.message}
        </div>
      ) : null}

      {saveState.phase === "SAVED" && saveState.reviewId ? (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>Draft Git guardado</h2>
          <p>{saveState.message}</p>
          <p>
            Review <code>{saveState.reviewId}</code>
          </p>
          <p>
            Commit de draft{" "}
            <code>{saveState.headCommit?.slice(0, 12) ?? "—"}</code>
          </p>
          <form action={submitAction}>
            <input type="hidden" name="reviewId" value={saveState.reviewId} />
            <button type="submit" disabled={submitting}>
              {submitting ? "Enviando…" : "Submit review"}
            </button>
          </form>
        </section>
      ) : null}

      {submitState.phase === "ERROR" ? (
        <div className="card" role="alert">
          Submit rechazado: {submitState.message}
        </div>
      ) : null}

      {submitState.phase === "SUBMITTED" && activeReviewId ? (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>Review enviado</h2>
          <p>{submitState.message}</p>
          <Link
            href={"/reviews/" + activeReviewId}
            className="action-button-outline"
          >
            Abrir Review Workspace
          </Link>
        </section>
      ) : null}
    </div>
  );
}
