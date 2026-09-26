import Link from "next/link";
import { akpOptional } from "../../lib/api";

interface PlatformStatus {
  status: string;
  corpus?: {
    documents?: number;
    sources?: number;
    vaults?: Array<{
      id: string;
      vault_key: string;
      name: string;
      current_revision?: string | null;
      last_imported_at?: string | null;
    }>;
  };
  indexes?: Array<{
    vault_id: string;
    corpus_revision?: string | null;
    lexical_revision?: string | null;
    status?: string;
  }>;
}

function stateLabel(done: boolean): string {
  return done ? "Listo" : "Pendiente";
}

export default async function GettingStartedPage() {
  const status = await akpOptional<PlatformStatus>("/v1/status");
  const vaults = status?.corpus?.vaults ?? [];
  const indexes = status?.indexes ?? [];
  const hasVault = vaults.length > 0;
  const hasImportedCorpus =
    Number(status?.corpus?.documents ?? 0) > 0 ||
    vaults.some((vault) => Boolean(vault.last_imported_at));
  const hasSearchableIndex = indexes.some(
    (index) =>
      Boolean(index.corpus_revision) &&
      Boolean(index.lexical_revision) &&
      ["CONSISTENT", "READY"].includes(String(index.status ?? "")),
  );
  const hasSources = Number(status?.corpus?.sources ?? 0) > 0;

  const steps = [
    {
      done: hasVault,
      title: "1. Tener un vault autorizado",
      body: hasVault
        ? `Ves ${vaults.length} vault(s): ${vaults
            .map((vault) => vault.name)
            .join(", ")}.`
        : "No hay un vault visible para esta sesión. Registrar/importar un vault es una operación local de operador; después se concede acceso al usuario.",
      href: "/admin/spaces",
      action: "Revisar espacios y acceso",
    },
    {
      done: hasImportedCorpus,
      title: "2. Importar o capturar material",
      body: hasImportedCorpus
        ? `El alcance visible contiene ${Number(
            status?.corpus?.documents ?? 0,
          )} documento(s).`
        : "Si ya existe un vault Markdown, el operador puede registrarlo/importarlo en modo de solo lectura. Para una fuente nueva usa Ingesta y sigue su job.",
      href: "/ingest",
      action: "Abrir ingesta",
    },
    {
      done: hasSearchableIndex,
      title: "3. Comprobar que el corpus es consultable",
      body: hasSearchableIndex
        ? "Existe al menos un índice léxico alineado con una revisión de corpus."
        : "Todavía no aparece un índice léxico consistente. Revisa Salud antes de interpretar una búsqueda vacía como ausencia de conocimiento.",
      href: "/admin/health",
      action: "Revisar salud",
    },
    {
      done: hasImportedCorpus && hasSearchableIndex,
      title: "4. Hacer la primera consulta",
      body: "La búsqueda recupera fuentes y evidencia autorizadas. No confunde el ranking con una respuesta final generada.",
      href: "/search",
      action: "Encontrar fuentes",
    },
    {
      done: hasSources,
      title: "5. Abrir la fuente y su procedencia",
      body: hasSources
        ? `Hay ${Number(status?.corpus?.sources ?? 0)} fuente(s) visible(s) para inspeccionar.`
        : "Cuando exista una fuente visible, abre su detalle para diferenciar bytes/origen, extracción, evidencia y conocimiento aprobado.",
      href: "/sources",
      action: "Ver fuentes",
    },
  ];

  return (
    <main>
      <p className="muted">
        Recorrido basado en el estado que el servidor autoriza para esta sesión
      </p>
      <h1>Primeros pasos</h1>

      {!status ? (
        <div className="card" role="status">
          <h2>No hay estado de conocimiento visible</h2>
          <p>
            Esto puede significar que la sesión todavía no tiene un espacio o
            vault con permiso de lectura. La Web no intenta registrar rutas
            locales ni elevar permisos por su cuenta.
          </p>
        </div>
      ) : null}

      <section>
        <h2>Preparar y comprobar el recorrido</h2>
        <div className="grid">
          {steps.map((step) => (
            <article className="card" key={step.title}>
              <p>
                <span className="badge">{stateLabel(step.done)}</span>
              </p>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
              <Link href={step.href}>{step.action}</Link>
            </article>
          ))}
        </div>
      </section>

      <section className="card" style={{ marginTop: 20 }}>
        <h2>Qué autoridad tiene cada cosa</h2>
        <dl>
          <dt><strong>Fuente externa</strong></dt>
          <dd>
            Material capturado/importado. Conserva procedencia; por sí solo no
            es conocimiento aprobado.
          </dd>
          <dt><strong>Extracción o evidencia derivada</strong></dt>
          <dd>
            Texto, estructura, OCR o locator producido desde una fuente. Debe
            seguir enlazado a su origen y revisión.
          </dd>
          <dt><strong>Propuesta en revisión</strong></dt>
          <dd>
            Cambio candidato. Puede ser generado o asistido, pero aún no es
            canónico.
          </dd>
          <dt><strong>Conocimiento aprobado</strong></dt>
          <dd>
            Markdown gobernado y publicado mediante la política de revisión.
          </dd>
          <dt><strong>Índice, grafo o resumen derivado</strong></dt>
          <dd>
            Ayuda a recuperar y navegar. Su score o relación no convierte una
            afirmación en verdadera ni más autorizada.
          </dd>
        </dl>
      </section>

      <section className="card" style={{ marginTop: 20 }}>
        <h2>Operación local frente a cliente</h2>
        <p>
          La Web, MCP y los comandos cliente usan la autorización del API. El
          registro/importación de un vault local y el diagnóstico directo del
          nodo son operaciones de operador y pueden requerir acceso local al
          servidor y a su base de datos.
        </p>
        <p className="muted">
          No pegues una ruta de tu PC en Ingesta si el API/worker corre en otra
          máquina: la ruta debe ser visible desde el servidor.
        </p>
      </section>
    </main>
  );
}
