async function health() {
  const base = process.env.AKP_API_URL ?? "http://127.0.0.1:8080";
  try {
    const response = await fetch(`${base}/health/readiness`, { cache: "no-store" });
    return await response.json();
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export default async function Home() {
  const status = await health();
  return (
    <main style={{ maxWidth: 960, margin: "40px auto", fontFamily: "system-ui" }}>
      <h1>Architecture Knowledge Platform</h1>
      <p>Corpus status: <strong>{String(status.status)}</strong></p>
      <section>
        <h2>Initial product surfaces</h2>
        <ul>
          <li>Search and Context Packets</li>
          <li>Ingest jobs</li>
          <li>Review inbox</li>
          <li>Source/evidence preview</li>
          <li>Evaluation scorecards</li>
        </ul>
      </section>
    </main>
  );
}
