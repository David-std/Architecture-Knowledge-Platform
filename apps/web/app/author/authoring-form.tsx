"use client";

import Link from "next/link";
import { useActionState, useEffect, useMemo, useState } from "react";
import { saveAuthorDraft, submitAuthorReview } from "./actions";
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

      <div className="card" role="status" aria-live="polite">
        {recoveryNotice}
        {recoveredAt ? (
          <>
            {" "}
            Último recovery: <time dateTime={recoveredAt}>{recoveredAt}</time>.
          </>
        ) : null}
        {!locked ? (
          <button
            type="button"
            onClick={discardRecovery}
            style={{ marginLeft: 12 }}
          >
            Descartar recovery local
          </button>
        ) : null}
      </div>

      <form action={saveAction} className="card" style={{ marginTop: 16 }}>
        <input type="hidden" name="spaceId" value={draft.spaceId} />
        <label>
          Vault
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
          Resumen
          <input
            name="summary"
            value={draft.summary}
            disabled={locked || saving}
            required
            minLength={3}
            maxLength={500}
            onChange={(event) => update("summary", event.target.value)}
            placeholder="Qué conocimiento se propone cambiar"
          />
        </label>

        <label>
          Path gobernado
          <input
            name="path"
            value={draft.path}
            disabled={locked || saving}
            required
            onChange={(event) => update("path", event.target.value)}
            aria-describedby="author-path-help"
          />
        </label>
        <small id="author-path-help" className="muted">
          Debe ser un path relativo Markdown autorizado por tu vault y perfil.
        </small>

        <label>
          Razón
          <input
            name="reason"
            value={draft.reason}
            disabled={locked || saving}
            required
            minLength={3}
            onChange={(event) => update("reason", event.target.value)}
            placeholder="Por qué debe cambiar este conocimiento"
          />
        </label>

        <label>
          Documento Markdown
          <textarea
            name="content"
            value={draft.content}
            disabled={locked || saving}
            required
            rows={24}
            onChange={(event) => update("content", event.target.value)}
            aria-describedby="author-content-help"
          />
        </label>
        <small id="author-content-help" className="muted">
          El servidor valida frontmatter, KnowledgeProfile, trust boundary y
          path antes de crear el draft Git.
        </small>

        {!locked ? (
          <p>
            <button type="submit" disabled={saving}>
              {saving ? "Guardando…" : "Save: crear draft Git"}
            </button>
          </p>
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
          <Link href={"/reviews/" + activeReviewId}>
            Abrir Review Workspace →
          </Link>
        </section>
      ) : null}
    </div>
  );
}
