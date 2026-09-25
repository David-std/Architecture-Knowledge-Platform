export const navigation = [
  {
    id: "work",
    label: "Trabajo",
    links: [
      { href: "/", label: "Inicio" },
      { href: "/reviews", label: "Revisiones" },
      { href: "/decisions", label: "Decisiones" },
    ],
  },
  {
    id: "knowledge",
    label: "Conocimiento",
    links: [
      { href: "/search", label: "Buscar" },
      { href: "/sources", label: "Fuentes" },
      { href: "/graph", label: "Grafo" },
      { href: "/author", label: "Proponer conocimiento" },
    ],
  },
  {
    id: "processes",
    label: "Procesos",
    links: [
      { href: "/jobs", label: "Ingestas y trabajos" },
      { href: "/ingest", label: "Nueva ingesta" },
      { href: "/evals", label: "Evaluaciones" },
    ],
  },
  {
    id: "admin",
    label: "Administración",
    links: [
      { href: "/admin/team", label: "Equipo" },
      { href: "/admin/spaces", label: "Espacios" },
      { href: "/admin/profiles", label: "Perfiles" },
      { href: "/admin/connectors", label: "Conectores" },
      { href: "/admin/assurance", label: "Assurance" },
      { href: "/admin/health", label: "Salud" },
      { href: "/admin/audit", label: "Auditoría" },
    ],
  },
] as const;

export type NavigationArea = (typeof navigation)[number]["id"];
type NavigationLink = { href: string; label: string };

const allLinks: NavigationLink[] = navigation.flatMap((area) =>
  area.links.map((link) => ({ href: link.href, label: link.label })),
);

export function areaForPath(pathname: string): NavigationArea | null {
  if (pathname === "/login") return null;
  if (pathname === "/") return "work";
  if (/^\/(reviews|decisions|work|services|sessions)(\/|$)/.test(pathname))
    return "work";
  if (
    /^\/(search|sources|graph|author|documents|knowledge)(\/|$)/.test(pathname)
  )
    return "knowledge";
  if (/^\/(jobs|ingest|evals)(\/|$)/.test(pathname)) return "processes";
  if (pathname.startsWith("/admin/")) return "admin";
  return null;
}

export function parentForPath(pathname: string): NavigationLink | null {
  if (pathname === "/" || pathname === "/login") return null;
  const direct = allLinks.find((link) => pathname === link.href);
  if (direct) return null;
  const parent = allLinks.find(
    (link) => pathname.startsWith(`${link.href}/`) && link.href !== "/",
  );
  if (parent) return parent;
  if (/^\/(work|services|sessions)(\/|$)/.test(pathname))
    return { href: "/", label: "Inicio" };
  if (/^\/(documents|knowledge)(\/|$)/.test(pathname))
    return { href: "/search", label: "Buscar" };
  return null;
}
