import "./globals.css";
import { OperatorShell } from "./operator-shell";

export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body>
        <OperatorShell>{children}</OperatorShell>
      </body>
    </html>
  );
}
