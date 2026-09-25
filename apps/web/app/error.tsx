"use client";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main>
      <h1>No se pudo cargar esta vista</h1>
      <section className="card" role="alert">
        <p>
          La operación falló y la vista no reutilizará datos anteriores como si
          fueran actuales.
        </p>
        <p className="muted">
          {error.digest ? `Referencia: ${error.digest}` : "Error de lectura."}
        </p>
        <button type="button" onClick={reset}>
          Reintentar
        </button>
      </section>
    </main>
  );
}
