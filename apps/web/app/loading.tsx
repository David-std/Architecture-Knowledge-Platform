export default function Loading() {
  return (
    <main aria-busy="true">
      <h1>Cargando vista</h1>
      <section className="card" role="status">
        Recuperando el estado autorizado y sus revisiones…
      </section>
    </main>
  );
}
