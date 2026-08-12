"use client";

import { useEffect, useState } from "react";
import { SidebarNav } from "./nav";
import { TopbarCrumb } from "./topbar-crumb";
import type { NavSection } from "./nav-model";

/**
 * The portal chrome: sidebar + top bar + content region.
 *
 * Responsive model is deliberately simple, because the operator's job is reading dense
 * tables and an elaborate layout gets in the way:
 *   ≥1024px — sidebar is permanent, content flows beside it.
 *   <1024px — sidebar becomes an overlay drawer, closed by default.
 *
 * The drawer is a client component only for the open/closed state and the Escape handler.
 * Everything it renders is passed in from the server, so no session or capability data is
 * computed here.
 */
export function Shell({
  sections,
  roleLabel,
  adminId,
  children,
  onSignOut,
}: {
  sections: NavSection[];
  roleLabel: string;
  adminId: string;
  children: React.ReactNode;
  onSignOut: React.ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Escape closes the drawer. Without this the only way out on a phone is the scrim,
  // which a keyboard user cannot reach.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  return (
    <div className={`shell${drawerOpen ? " shell--drawer-open" : ""}`}>
      <aside className="sidebar" id="portal-sidebar">
        <div className="sidebar__brand">
          <span className="sidebar__mark" aria-hidden="true">
            BB
          </span>
          <span className="sidebar__brandtext">
            <span className="sidebar__name">BadaBhai</span>
            <span className="sidebar__env">Admin</span>
          </span>
        </div>

        <SidebarNav sections={sections} />

        <div className="sidebar__foot">
          <div className="whoami">
            <span className="whoami__role">{roleLabel}</span>
            {/* The opaque admin id, never a name or email — /admin/me returns neither. */}
            <span className="whoami__id" title={adminId}>
              {adminId.slice(0, 8)}…
            </span>
          </div>
          {onSignOut}
        </div>
      </aside>

      {/* Scrim: only interactive while the drawer is open, and inert to screen readers so
          it never appears as a stray button in the reading order. */}
      <button
        className="shell__scrim"
        type="button"
        tabIndex={drawerOpen ? 0 : -1}
        aria-hidden={!drawerOpen}
        aria-label="Close navigation"
        onClick={() => setDrawerOpen(false)}
      />

      <div className="shell__main">
        <header className="topbar">
          <button
            className="topbar__menu"
            type="button"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-expanded={drawerOpen}
            aria-controls="portal-sidebar"
          >
            <span aria-hidden="true">☰</span>
            <span className="sr-only">Navigation</span>
          </button>
          {/* The topbar used to be a hamburger and a spacer. It now says where you are —
              the only such signal on a detail route, where the sidebar can name the section
              but not the row. */}
          <TopbarCrumb />
          <div className="topbar__spacer" />
          <span className="topbar__env">{roleLabel}</span>
        </header>

        <main className="content" id="main">
          {children}
        </main>
      </div>
    </div>
  );
}
