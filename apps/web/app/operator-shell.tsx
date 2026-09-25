"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { areaForPath, navigation, parentForPath } from "../lib/navigation";

export function OperatorShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isLoginPage = pathname === "/login";
  const currentArea = areaForPath(pathname);

  // Tree view expanded state per area
  const [expandedAreas, setExpandedAreas] = useState<Record<string, boolean>>({
    work: true,
    knowledge: true,
    processes: false,
    admin: false,
  });

  const [menuOpen, setMenuOpen] = useState(false);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDialogElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const sessionMenuRef = useRef<HTMLDivElement>(null);
  const parent = parentForPath(pathname);

  // Auto-expand area when navigating
  useEffect(() => {
    if (currentArea) {
      setExpandedAreas((prev) => ({ ...prev, [currentArea]: true }));
    }
    menuRef.current?.close();
    setSessionMenuOpen(false);
  }, [pathname, currentArea]);

  // Global shortcut: Cmd+K / Ctrl+K navigates to /search
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        router.push("/search");
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [router]);

  // Close session popover on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        sessionMenuRef.current &&
        !sessionMenuRef.current.contains(event.target as Node)
      ) {
        setSessionMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("menu-open", menuOpen);
    return () => document.body.classList.remove("menu-open");
  }, [menuOpen]);

  function toggleArea(areaId: string) {
    setExpandedAreas((prev) => ({
      ...prev,
      [areaId]: !prev[areaId],
    }));
  }

  function openMenu() {
    menuRef.current?.showModal();
    setMenuOpen(true);
  }

  function closeMenu() {
    menuRef.current?.close();
  }

  return (
    <div className={`app-shell ${isLoginPage ? "app-shell-auth" : ""}`}>
      <a className="skip-link" href="#main-content">
        Saltar al contenido principal
      </a>

      {/* Top Navigation Bar */}
      <header className="app-header">
        <div className="brand-group">
          <Link className="brand" href="/" aria-label="AKP, ir al inicio">
            <div className="brand-mark-cube" aria-hidden="true">
              <svg
                width="24"
                height="24"
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
              {/* Modular geometric AKP logotype */}
              <svg
                className="brand-letters-svg"
                width="56"
                height="20"
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
                <polygon points="27,10 37,20 31.5,20 23.5,12" fill="#b43e18" />
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
          </Link>
        </div>

        {/* Top Bar Quick Access Items */}
        {!isLoginPage && (
          <nav className="header-quick-nav" aria-label="Accesos frecuentes">
            <Link
              href="/"
              className={`quick-nav-link ${pathname === "/" ? "active" : ""}`}
            >
              Inicio
            </Link>
            <Link
              href="/reviews"
              className={`quick-nav-link ${
                pathname.startsWith("/reviews") ? "active" : ""
              }`}
            >
              Revisiones
            </Link>
            <Link
              href="/admin/health"
              className={`quick-nav-link ${
                pathname.startsWith("/admin/health") ? "active" : ""
              }`}
            >
              Salud
            </Link>
          </nav>
        )}

        <div className="header-actions">
          {!isLoginPage && (
            <Link
              className="header-search-btn"
              href="/search"
              title="Buscar en la base de conocimiento (⌘K)"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <span>Buscar</span>
              <kbd className="search-kbd">⌘K</kbd>
            </Link>
          )}

          {/* Session Dropdown Trigger and Popover */}
          <div className="session-menu-wrapper" ref={sessionMenuRef}>
            {isLoginPage ? (
              <Link className="header-link active" href="/login">
                Acceso
              </Link>
            ) : (
              <>
                <button
                  type="button"
                  className={`header-link session-trigger ${
                    sessionMenuOpen ? "active" : ""
                  }`}
                  onClick={() => setSessionMenuOpen((prev) => !prev)}
                  aria-expanded={sessionMenuOpen}
                  aria-haspopup="true"
                >
                  <span className="session-avatar-dot" aria-hidden="true" />
                  <span>Sesión</span>
                  <svg
                    className={`session-chevron ${sessionMenuOpen ? "open" : ""}`}
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>

                {sessionMenuOpen && (
                  <div className="session-dropdown" role="menu">
                    <div className="session-dropdown-header">
                      <span className="session-user-role">
                        Operador de plataforma
                      </span>
                      <span className="session-status-tag">
                        <span className="live-dot" aria-hidden="true" /> Activo
                      </span>
                    </div>

                    <div className="session-dropdown-body">
                      <Link
                        href="/login"
                        className="session-dropdown-item"
                        role="menuitem"
                        onClick={() => setSessionMenuOpen(false)}
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                          <circle cx="12" cy="7" r="4" />
                        </svg>
                        <span>Cambiar token de acceso</span>
                      </Link>

                      <form action="/api/auth/session" method="post">
                        <input type="hidden" name="action" value="logout" />
                        <button
                          type="submit"
                          className="session-dropdown-item logout"
                          role="menuitem"
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                            <polyline points="16 17 21 12 16 7" />
                            <line x1="21" y1="12" x2="9" y2="12" />
                          </svg>
                          <span>Cerrar sesión</span>
                        </button>
                      </form>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {!isLoginPage && (
            <button
              ref={menuButtonRef}
              className="menu-trigger"
              type="button"
              aria-label="Abrir navegación"
              aria-controls="mobile-navigation"
              aria-expanded={menuOpen}
              onClick={openMenu}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
              <span>Menú</span>
            </button>
          )}
        </div>
      </header>

      {isLoginPage ? (
        <div className="auth-shell">
          <div id="main-content" tabIndex={-1}>
            {children}
          </div>
        </div>
      ) : (
        <div className="app-body">
          {/* Collapsible Tree Navigation Sidebar */}
          <aside
            className="app-sidebar"
            aria-label="Estructura de la plataforma"
          >
            <div className="sidebar-header">
              <span className="sidebar-title">Árbol de navegación</span>
            </div>

            <nav className="tree-nav" aria-label="Navegación jerárquica">
              {navigation.map((area) => {
                const isExpanded = Boolean(expandedAreas[area.id]);
                const isAreaActive = currentArea === area.id;

                return (
                  <div
                    key={area.id}
                    className={`tree-group ${isAreaActive ? "area-active" : ""}`}
                  >
                    <button
                      type="button"
                      className="tree-root-btn"
                      aria-expanded={isExpanded}
                      onClick={() => toggleArea(area.id)}
                    >
                      <svg
                        className={`tree-chevron ${isExpanded ? "expanded" : ""}`}
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                      <span className="tree-root-label">{area.label}</span>
                      <span className="tree-root-count">
                        {area.links.length}
                      </span>
                    </button>

                    {isExpanded && (
                      <div className="tree-branch" role="group">
                        {area.links.map((link) => {
                          const isCurrent = pathname === link.href;
                          return (
                            <Link
                              key={link.href}
                              href={link.href}
                              aria-current={isCurrent ? "page" : undefined}
                              className={`tree-item ${
                                isCurrent ? "active-item" : ""
                              }`}
                            >
                              <span
                                className="tree-branch-line"
                                aria-hidden="true"
                              />
                              <span className="tree-item-label">
                                {link.label}
                              </span>
                            </Link>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </nav>
          </aside>

          <div className="content-shell">
            {parent ? (
              <nav className="breadcrumbs" aria-label="Ruta de navegación">
                <Link href={parent.href}>{parent.label}</Link>
                <span className="crumb-sep" aria-hidden="true">
                  /
                </span>
                <span aria-current="page">Detalle</span>
              </nav>
            ) : null}
            <div id="main-content" tabIndex={-1}>
              {children}
            </div>
          </div>
        </div>
      )}

      {/* Mobile Drawer */}
      <dialog
        ref={menuRef}
        id="mobile-navigation"
        className="mobile-navigation"
        aria-label="Navegación"
        onClose={() => {
          setMenuOpen(false);
          menuButtonRef.current?.focus();
        }}
      >
        <div className="mobile-menu-header">
          <strong>Navegación</strong>
          <button type="button" className="menu-close" onClick={closeMenu}>
            Cerrar
          </button>
        </div>
        <nav aria-label="Navegación móvil">
          {navigation.map((area) => (
            <details
              key={`${area.id}-${pathname}`}
              open={area.id === currentArea || Boolean(expandedAreas[area.id])}
              className="mobile-details"
            >
              <summary>{area.label}</summary>
              <div className="mobile-link-list">
                {area.links.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    aria-current={pathname === link.href ? "page" : undefined}
                    onClick={closeMenu}
                  >
                    {link.label}
                  </Link>
                ))}
              </div>
            </details>
          ))}
          <div className="mobile-session-section">
            <Link
              className="mobile-session-link"
              href="/login"
              onClick={closeMenu}
            >
              Acceso / Sesión
            </Link>
          </div>
        </nav>
      </dialog>
    </div>
  );
}
