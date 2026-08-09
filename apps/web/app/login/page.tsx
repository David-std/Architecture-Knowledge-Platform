"use client";

import { FormEvent, useState } from "react";

const api = process.env.NEXT_PUBLIC_AKP_API_URL ?? "http://127.0.0.1:8080";

export default function LoginPage() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    const token = String(data.get("token") ?? "");
    const response = await fetch(`${api}/v1/auth/session`, {
      method: "POST",
      credentials: "include",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ durationMinutes: 480 }),
    }).catch((caught) => {
      setError(String(caught));
      return null;
    });
    if (!response) {
      setBusy(false);
      return;
    }
    if (!response.ok) {
      setError(`Inicio de sesión rechazado (${response.status}).`);
      setBusy(false);
      return;
    }
    window.location.assign("/");
  }

  return (
    <main>
      <p className="muted">Sesión humana local</p>
      <h1>Acceder</h1>
      <form className="card" onSubmit={submit}>
        <label htmlFor="token">Token de acceso con alcance</label>
        <input
          id="token"
          name="token"
          type="password"
          required
          autoComplete="off"
        />
        <button type="submit" disabled={busy}>
          {busy ? "Creando sesión…" : "Crear sesión segura"}
        </button>
        {error ? <p role="alert">{error}</p> : null}
      </form>
      <p className="muted">
        El token se intercambia por una cookie HttpOnly; las escrituras
        posteriores requieren CSRF.
      </p>
    </main>
  );
}
