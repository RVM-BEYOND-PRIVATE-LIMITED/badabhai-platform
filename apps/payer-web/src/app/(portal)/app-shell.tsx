"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Icon } from "@badabhai/icons";
import { IconButtonBase } from "@badabhai/icons/button";
import { NavPendingStatus } from "../../components/nav-pending";
import { SidebarNav } from "./sidebar-nav";
import { NavSectionsProvider } from "./nav-context";
import { openDrawer } from "./drawer-focus";
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
 * THE TWO RAIL TOGGLES are disclosures of the same rail (`aria-controls` → the rail's id): the
 * header's menu button opens the drawer below 1024px, the rail's collapse button shows or hides the
 * labels from 1280px. Each is a Tab stop exactly where it is drawn — the CSS `display: none` that
 * hides it elsewhere already takes it out of the tab order, so neither carries a tabindex.
 *
 * THE DRAWER is MODAL while open (./drawer-focus.ts): closed, it is out of the Tab order
 * (globals.css hides it, not just slides it off-screen); open, it is a labelled `role="dialog"`
 * with `aria-modal`, the page behind it is `inert`, focus moves in and Tab stays inside it. Escape,
 * the scrim, a link in it, a route change or widening past the drawer breakpoint close it, and
 * focus returns to the menu button. (The menu button itself sits in the inert page while the drawer
 * is open, so it cannot close it.)
 *
 * This component is a client boundary ONLY for the collapse/drawer state and the drawer's
 * keyboard model. Everything it renders — the nav sections, the identity block, the header slots —
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
  const menuId = useId();
  const railRef = useRef<HTMLElement>(null);
  const scrimRef = useRef<HTMLButtonElement>(null);
  // The collapse toggle's name says what activating it does, so it changes with the state — and
  // the state is therefore `aria-expanded` (are the rail's labels shown?), never `aria-pressed`:
  // a pressed toggle keeps ONE name ("Expand navigation, pressed" contradicts itself).
  const collapseLabel = collapsed ? "Expand navigation" : "Collapse navigation";

  // The open drawer's keyboard model: focus in, Tab contained, Escape / a link / leaving drawer
  // mode close it, focus back to the menu button on close. Whether the rail is a drawer right now
  // is read from the scrim (drawn only for the open drawer below 1024px), so the breakpoint stays
  // in the stylesheet.
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const rail = railRef.current;
    if (!rail) return undefined;
    return openDrawer({
      doc: document,
      view: window,
      rail,
      scrim: scrimRef.current,
      menu: () => document.getElementById(menuId),
      isModal: () =>
        scrimRef.current !== null && getComputedStyle(scrimRef.current).display !== "none",
      close: () => setDrawerOpen(false),
    });
  }, [drawerOpen, menuId]);

  // A route change should not leave the drawer hanging open over the page the user just
  // navigated to. Keyed on the PATH: this shell lives in a persistent layout, whose `children`
  // keeps its identity across navigations — keyed on that, the drawer stayed open over the new
  // page (measured: /dashboard → a drawer link → /postings/new, still open), and with the drawer's
  // Tab containment the keyboard would have stayed trapped in it there.
  const pathname = usePathname();
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  const shellClass = [
    "pshell",
    collapsed ? "pshell--collapsed" : "",
    drawerOpen ? "pshell--drawer-open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={shellClass}>
      {/* The navigation under way: the page-wide bar and the one status line. Here, OUTSIDE
          `.pshell__main` — which goes inert behind the open drawer — and out of the grid flow
          (fixed bar, sr-only line). components/nav-pending.tsx. */}
      <NavPendingStatus />

      {/* Open, the rail is a drawer — the only way it opens is the menu button, drawn below 1024px,
          and leaving drawer mode closes it — so it is a labelled modal dialog then; otherwise it
          is the plain rail landmark. */}
      <aside
        className="pshell__rail"
        id={railId}
        ref={railRef}
        role={drawerOpen ? "dialog" : undefined}
        aria-modal={drawerOpen ? true : undefined}
        aria-label={drawerOpen ? "Navigation" : undefined}
      >
        <div className="pshell__brand">{brand}</div>

        <SidebarNav sections={sections} />

        <div className="pshell__railfoot">
          {footer}
          <button
            className="pshell__collapse"
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!collapsed}
            aria-controls={railId}
            aria-label={collapseLabel}
            /* Collapsed, the button is icon-only. Its tooltip is the rail's own — the title bubble
               every rail link shows for its hidden label — because the rail scrolls
               (overflow-y), which would clip the shared `.bb-icon-tip` on the narrow icon rail. */
            title={collapseLabel}
          >
            <Icon name={collapsed ? "caret-right" : "caret-left"} />
            <span className="pnav__label">Collapse</span>
          </button>
        </div>
      </aside>

      {/* Scrim: a POINTER target while the drawer is open, hidden from assistive tech the rest of
          the time so it never shows up as a stray button in the reading order. Never a Tab stop:
          it covers the viewport, so its focus ring would be drawn off-screen; the open drawer
          keeps Tab inside itself, and Escape closes it from the keyboard. */}
      <button
        ref={scrimRef}
        className="pshell__scrim"
        type="button"
        tabIndex={-1}
        aria-hidden={!drawerOpen}
        aria-label="Close navigation"
        onClick={() => setDrawerOpen(false)}
      />

      {/* Behind the open drawer the page is `inert`: no Tab stop, no pointer target, nothing a
          screen reader can wander into — the modal half of the drawer. */}
      <div className="pshell__main" inert={drawerOpen}>
        <header className="pshell__header">
          {/* The shared icon-only control: "Navigation" is its name AND its visible tooltip (on
              hover and keyboard focus, Escape-dismissable), opening inward from the top-left. */}
          <IconButtonBase
            id={menuId}
            classBase="pshell__menu"
            icon="list"
            label="Navigation"
            tooltipPlacement="bottom-start"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-expanded={drawerOpen}
            aria-controls={railId}
          />
          {header}
        </header>

        <main className="pshell__content" id="main">
          {/* The same sections, for the content column's client pieces (the error boundary's
              way back up — nav-context.tsx). */}
          <NavSectionsProvider value={sections}>{children}</NavSectionsProvider>
        </main>
      </div>
    </div>
  );
}
