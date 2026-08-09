import "./globals.css";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body>
        <div className="shell">
          <nav aria-label="Navegación principal">
            <h1>Architecture Knowledge Platform</h1>
            <Link href="/">Estado</Link>
            <Link href="/search">Búsqueda</Link>
            <Link href="/sources">Fuentes</Link>
            <Link href="/ingest">Nueva ingesta</Link>
            <Link href="/jobs">Jobs</Link>
            <Link href="/reviews">Revisiones</Link>
            <Link href="/graph">Grafo</Link>
            <Link href="/evals">Evaluaciones</Link>
            <Link href="/admin/health">Salud</Link>
            <Link href="/admin/spaces">Espacios</Link>
            <Link href="/admin/audit">Auditoría</Link>
            <Link href="/login">Sesión</Link>
          </nav>
          {children}
        </div>
      </body>
    </html>
  );
}
