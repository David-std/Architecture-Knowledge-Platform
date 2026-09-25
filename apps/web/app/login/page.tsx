type LoginPageProps = {
  searchParams: Promise<{ error?: string }>;
};

const LOUVER_STRIPS = [
  { id: 1, pos: "12% 40%", delay: "0s", height: "86%" },
  { id: 2, pos: "32% 42%", delay: "1.2s", height: "94%" },
  { id: 3, pos: "52% 45%", delay: "0.6s", height: "100%" },
  { id: 4, pos: "72% 42%", delay: "1.8s", height: "92%" },
  { id: 5, pos: "92% 38%", delay: "1.0s", height: "84%" },
];

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error } = await searchParams;

  return (
    <main className="login-stage">
      <div className="login-architectural-structure">
        {/* Louver facade visualization */}
        <section
          className="louvers-wing"
          aria-label="Composición arquitectónica del pabellón"
        >
          <div className="louvers-frame">
            <div className="louvers-assembly">
              {LOUVER_STRIPS.map((strip) => (
                <div
                  key={strip.id}
                  className="louver-strip"
                  style={{
                    animationDelay: strip.delay,
                    height: strip.height,
                  }}
                >
                  <div
                    className="louver-slice"
                    style={{
                      backgroundImage: "url('/api/artwork')",
                      backgroundPosition: strip.pos,
                    }}
                  />
                  <div className="louver-reflection" aria-hidden="true" />
                </div>
              ))}
            </div>
            <div className="louvers-meta">
              <span className="louvers-caption">
                Pabellón de Conocimiento · AKP
              </span>
              <span className="louvers-tag">Estructura local</span>
            </div>
          </div>
        </section>

        {/* Operator access panel */}
        <section className="access-wing" aria-labelledby="login-heading">
          <div className="access-wing-inner">
            <div className="access-header">
              <div className="login-brand-row">
                <div className="brand-mark-cube" aria-hidden="true">
                  <svg
                    width="28"
                    height="28"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path d="M12 2L21 7.2L12 12.4L3 7.2L12 2Z" fill="#b43e18" />
                    <path d="M3 7.2L12 12.4V22L3 16.8V7.2Z" fill="#181615" />
                    <path d="M12 12.4L21 7.2V16.8L12 22V12.4Z" fill="#d97706" />
                  </svg>
                </div>
                <div className="brand-logotype">
                  {/* Modular geometric AKP logotype with square architectural glyphs */}
                  <svg
                    className="brand-letters-svg"
                    width="62"
                    height="22"
                    viewBox="0 0 58 20"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    aria-hidden="true"
                  >
                    {/* Modular A */}
                    <rect
                      x="0"
                      y="4"
                      width="4.5"
                      height="16"
                      rx="1"
                      fill="#181615"
                    />
                    <rect
                      x="11.5"
                      y="4"
                      width="4.5"
                      height="16"
                      rx="1"
                      fill="#b43e18"
                    />
                    <rect
                      x="0"
                      y="0"
                      width="16"
                      height="4.5"
                      rx="1"
                      fill="#181615"
                    />
                    <rect
                      x="4"
                      y="10"
                      width="8"
                      height="3"
                      rx="0.5"
                      fill="#d97706"
                    />

                    {/* Modular K */}
                    <rect
                      x="21"
                      y="0"
                      width="4.5"
                      height="20"
                      rx="1"
                      fill="#181615"
                    />
                    <polygon
                      points="25.5,11 31.5,1.5 37,1.5 28.5,12"
                      fill="#d97706"
                    />
                    <polygon
                      points="27,10 37,20 31.5,20 23.5,12"
                      fill="#b43e18"
                    />
                    <rect
                      x="24"
                      y="9.5"
                      width="3"
                      height="3"
                      rx="0.5"
                      fill="#44403c"
                    />

                    {/* Modular P */}
                    <rect
                      x="42"
                      y="0"
                      width="4.5"
                      height="20"
                      rx="1"
                      fill="#181615"
                    />
                    <rect
                      x="45"
                      y="0"
                      width="13"
                      height="4.5"
                      rx="1"
                      fill="#b43e18"
                    />
                    <rect
                      x="53.5"
                      y="3"
                      width="4.5"
                      height="8.5"
                      rx="1"
                      fill="#181615"
                    />
                    <rect
                      x="45"
                      y="8.5"
                      width="10"
                      height="3.5"
                      rx="0.5"
                      fill="#d97706"
                    />
                  </svg>
                  <span className="brand-node-tag">CORE</span>
                </div>
              </div>
              <h1 id="login-heading">Acceso al operador</h1>
              <p className="access-subtitle">
                Consola local para revisión, grafo y auditoría de conocimiento
              </p>
            </div>

            <form
              className="access-form"
              action="/api/auth/session"
              method="post"
            >
              <div className="field-group">
                <div className="field-label-row">
                  <label htmlFor="token" className="field-label">
                    Token de acceso
                  </label>
                  <span className="field-hint">Clave de autorización</span>
                </div>
                <input
                  id="token"
                  name="token"
                  type="password"
                  required
                  autoComplete="off"
                  placeholder="Introduce el token del operador"
                  className="token-input"
                  autoFocus
                />
              </div>

              <button type="submit" className="access-submit-btn">
                Entrar a la consola
              </button>

              {error === "invalid" && (
                <div className="login-alert error" role="alert">
                  <strong>Token no válido</strong>
                  <p>
                    El token ingresado no coincide con el autorizado en el
                    entorno local.
                  </p>
                </div>
              )}

              {error === "unavailable" && (
                <div className="login-alert error" role="alert">
                  <strong>Servicio no disponible</strong>
                  <p>
                    No se pudo verificar el token. Asegúrate de que el API de
                    AKP esté iniciado.
                  </p>
                </div>
              )}
            </form>

            <footer className="access-footer">
              <div className="access-terms-links">
                <span className="access-terms-item">Términos de servicio</span>
                <span className="access-terms-sep" aria-hidden="true">
                  ·
                </span>
                <span className="access-terms-item">
                  Política de inmutabilidad
                </span>
                <span className="access-terms-sep" aria-hidden="true">
                  ·
                </span>
                <span className="access-terms-item">SHA-256</span>
              </div>
              <p className="access-legal-notice">
                El acceso a esta consola constituye aceptación de los términos y
                condiciones de gobernanza de la plataforma. Todas las
                transacciones y mutaciones de conocimiento se auditan de forma
                local, inmutable y criptográficamente verificable en el
                repositorio canónico.
              </p>
            </footer>
          </div>
        </section>
      </div>
    </main>
  );
}
