type LoginPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error } = await searchParams;

  return (
    <main>
      <p className="muted">Sesión humana local</p>
      <h1>Acceder</h1>
      <form className="card" action="/api/auth/session" method="post">
        <label htmlFor="token">Token de acceso con alcance</label>
        <input
          id="token"
          name="token"
          type="password"
          required
          autoComplete="off"
        />
        <button type="submit">Crear sesión segura</button>
        {error === "invalid" && (
          <p role="alert">
            Token rechazado. Comprueba el valor e inténtalo de nuevo.
          </p>
        )}
        {error === "unavailable" && (
          <p role="alert">
            No se pudo conectar con la API. Inténtalo de nuevo.
          </p>
        )}
      </form>
      <p className="muted">
        El token se intercambia por una cookie HttpOnly; las escrituras
        posteriores requieren CSRF.
      </p>
    </main>
  );
}
