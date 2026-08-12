"use client";

import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { SidebarNav } from "./sidebar-nav";
import type { NavSection } from "./nav-model";

/**
 * The authenticated portal chrome (IA-1): a persistent left rail + a sticky header + the
 * content column.
 *
 * WHY A RAIL INSTEAD OF THE OLD TOP ROW. The nav was a horizontal strip that wrapped: with
 * an agency session it carried eight links and, below ~1100px, spilled onto a second full
 * -width line that pushed the page content down. A vertical rail holds a grouped, levelled
 * IA at any width, keeps every destination visible without wrapping, and gives the content
 * column the entire viewport height — which is what a table-heavy console wants.
 *
 * RESPONSIVE MODEL — deliberately three states, not a continuum:
 *   ≥1280px  rail is permanent and labelled; the user may collapse it to an icon rail.
 *   1024–1280px  rail is permanent but collapsed to icons by default (labels on hover via
 *                the title tooltip) — at this width labels + content cannot both breathe.
 *   <1024px  rail becomes an overlay drawer, closed by default.
 *
 * This component is a client boundary ONLY for the collapse/drawer state and the Escape
 * handler. Everything it renders — the nav sections, the identity block, the header slots —
 * is computed on the server and passed in, so no session or role data is resolved here.
 */
export function AppShell({
  sections,
  brand,
  header,
  footer,
  children,
}: {
  sections: NavSection[];
  brand: ReactNode;
  header: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const railId = useId();

  // Escape closes the drawer. Without it the scrim is the only way out, which a keyboard
  // user cannot reach.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  // A route change should not leave the drawer hanging open over the page the user just
  // navigated to. `children` changes identity on navigation, which is the signal we have
  // without wiring a router listener into this presentational shell.
  useEffect(() => {
    setDrawerOpen(false);
  }, [children]);

  const shellClass = [
    "pshell",
    collapsed ? "pshell--collapsed" : "",
    drawerOpen ? "pshell--drawer-open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={shellClass}>
      <aside className="pshell__rail" id={railId}>
        <div className="pshell__brand">{brand}</div>

        <SidebarNav sections={sections} />

        <div className="pshell__railfoot">
          {footer}
          <button
            className="pshell__collapse"
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-pressed={collapsed}
            /* The control is only meaningful where the rail is permanent; below 1024px it
               is hidden by CSS, and a hidden control must not stay in the tab order. */
            tabIndex={-1}
          >
            <i
              className={`ph ph-caret-${collapsed ? "right" : "left"}`}
              aria-hidden="true"
            />
            <span className="pnav__label">Collapse</span>
          </button>
        </div>
      </aside>

      {/* Scrim: interactive only while the drawer is open, and inert to assistive tech the
          rest of the time so it never shows up as a stray button in the reading order. */}
      <button
        className="pshell__scrim"
        type="button"
        tabIndex={drawerOpen ? 0 : -1}
        aria-hidden={!drawerOpen}
        aria-label="Close navigation"
        onClick={() => setDrawerOpen(false)}
      />

      <div className="pshell__main">
        <header className="pshell__header">
          <button
            className="pshell__menu"
            type="button"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-expanded={drawerOpen}
            aria-controls={railId}
          >
            <i className="ph ph-list" aria-hidden="true" />
            <span className="sr-only">Navigation</span>
          </button>
          {header}
        </header>

        <main className="pshell__content" id="main">
          {children}
        </main>
      </div>
    </div>
  );
}
