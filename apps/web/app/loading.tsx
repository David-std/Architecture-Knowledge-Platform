export default function Loading() {
  return (
    <main aria-busy="true" aria-live="polite">
      <p className="muted">Workspace</p>
      <h1>Cargando</h1>
      <section className="card" role="status">
        Recuperando el estado autorizado y sus revisiones…
      </section>
    </main>
  );
}
