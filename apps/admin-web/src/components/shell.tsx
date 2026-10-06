"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { BrandLockup } from "./brand-lockup";
import { holdFocusInDrawer } from "./drawer-focus";
import { IconButton } from "./icon-button";
import { SidebarNav } from "./nav";
import { TopbarCrumb } from "./topbar-crumb";
import type { NavSection } from "./nav-model";

/**
 * The menu toggle's id: where focus goes back to when the drawer closes, and how the shell tells
 * drawer mode from desktop — the toggle is drawn only below the breakpoint (globals.css), so the
 * breakpoint lives in one place, the stylesheet.
 */
export const MENU_TOGGLE_ID = "portal-menu-toggle";

/**
 * The portal chrome: sidebar + top bar + content region.
 *
 * Responsive model is deliberately simple, because the operator's job is reading dense
 * tables and an elaborate layout gets in the way:
 *   ≥1024px — sidebar is permanent, content flows beside it.
 *   <1024px — sidebar becomes an overlay drawer, closed by default.
 *
 * The drawer is a client component only for the open/closed state and its keyboard handling.
 * Everything it renders is passed in from the server, so no session or capability data is
 * computed here.
 *
 * THE OPEN DRAWER IS MODAL (final sweep AW-04). Measured before: the closed drawer's 15
 * controls were the first 15 Tab stops of every page below 1024px (off-screen), and once it was
 * open the next Tabs went to the page behind the scrim. Now: closed, it is out of the tab order
 * (CSS, `visibility: hidden`); open, focus moves into it, Tab cycles inside it, the page behind
 * the scrim is `inert`, and Escape, the scrim or following a link closes it and puts focus back
 * on the menu toggle.
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
  const sidebarRef = useRef<HTMLElement>(null);
  const pathname = usePathname();

  // While open: focus moves into the drawer, Tab stays in it, and Escape closes it (without
  // Escape the only way out on a phone is the scrim, which a keyboard user cannot reach).
  // Closing hands focus back to the toggle; at 1024px and up the toggle is not drawn, focus()
  // is a no-op there, and focus stays in the now-permanent sidebar.
  useEffect(() => {
    if (!drawerOpen) return;
    const drawer = sidebarRef.current;
    if (!drawer) return;
    const release = holdFocusInDrawer({
      drawer,
      keyTarget: window,
      activeElement: () => document.activeElement,
      onClose: () => setDrawerOpen(false),
    });
    return () => {
      release();
      document.getElementById(MENU_TOGGLE_ID)?.focus();
    };
  }, [drawerOpen]);

  // Following a link in the drawer navigates without unmounting the shell, so the drawer used to
  // stay open over the page just opened. A new route closes it.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Widening past the drawer breakpoint while it is open would leave the page `inert` behind a
  // sidebar that is permanent again. Leaving drawer mode — the toggle is no longer drawn — closes
  // it. Listened for only while it is open.
  useEffect(() => {
    if (!drawerOpen) return;
    const onResize = () => {
      const toggle = document.getElementById(MENU_TOGGLE_ID);
      if (!toggle || toggle.getClientRects().length === 0) setDrawerOpen(false);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [drawerOpen]);

  return (
    <div className={`shell${drawerOpen ? " shell--drawer-open" : ""}`}>
      <aside className="sidebar" id="portal-sidebar" ref={sidebarRef}>
        <div className="sidebar__brand">
          <BrandLockup surface="ink" />
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

      {/* Scrim: only drawn while the drawer is open, and hidden from screen readers otherwise so
          it never appears as a stray button in the reading order. Never a Tab stop: it covers
          the viewport, so its focus ring would be drawn off-screen, and the open drawer keeps
          Tab inside itself (Escape closes it from the keyboard). A pointer or a screen reader
          still activates it. */}
      <button
        className="shell__scrim"
        type="button"
        tabIndex={-1}
        aria-hidden={!drawerOpen}
        aria-label="Close navigation"
        onClick={() => setDrawerOpen(false)}
      />

      {/* Behind an open drawer the page is `inert`: no Tab stop, no pointer target, nothing a
          screen reader can wander into — the modal half of the drawer's focus handling. */}
      <div className="shell__main" inert={drawerOpen}>
        <header className="topbar">
          {/* The drawer toggle: the solid Phosphor `list` glyph (the ☰ character fell back to a
              thin stroke in the UI face), named "Navigation" — its accessible name AND its visible
              tooltip. The tooltip opens BELOW, aligned to the toggle's start edge
              (`bottom-start`): centred it would run off the bar's left edge, and beside the
              toggle it would cover the breadcrumb. */}
          <IconButton
            id={MENU_TOGGLE_ID}
            icon="list"
            label="Navigation"
            variant="outline"
            tooltipPlacement="bottom-start"
            className="topbar__menu"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-expanded={drawerOpen}
            aria-controls="portal-sidebar"
          />
          {/* The topbar used to be a hamburger and a spacer. It now says where you are —
              the only such signal on a detail route, where the sidebar can name the section
              but not the row. */}
          <TopbarCrumb sections={sections} />
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
