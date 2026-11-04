"use client";

import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { activeNavItem, type NavSection } from "./nav-model";
import { NavPendingCue } from "./nav-pending";

/** Where the active-row marker sits: its top edge and height, in px from the nav's own top. */
export interface NavMarker {
  top: number;
  height: number;
}

/** The marker as placed: over which item, and whether it glided there (the active row changed). */
interface PlacedMarker extends NavMarker {
  href: string;
  glide: boolean;
}

/**
 * The marker's place over the active row, or null when there is no row to mark: no active item
 * (a page off the nav), or its group is collapsed (the row is not rendered). Measured from the
 * DOM, so it is right whatever the row heights are (a coarse pointer's 44px rows, a wrapped
 * label) and wherever the sidebar has scrolled to.
 *
 * It reads the LAYOUT boxes (`offsetTop`, `offsetHeight`), never where the row is drawn: a group
 * that has just opened is still sliding down into place (`nav-group-in`), so a client rect taken
 * then is up to --motion-rise short — and nothing measures again once it settles, since a
 * transform resizes nothing. The offsets are summed up the whole offset-parent chain to the nav
 * (its positioning box): a row's `li` is positioned, and while that slide runs the browser makes
 * the transformed list the `li`'s offset parent too, so one step up would land on the list, not
 * the nav. A chain that never reaches the nav (no stylesheet) has nothing to mark.
 *
 * A row in a CLOSING group is gone too: its list is `hidden` at once but stays laid out while its
 * exit plays, and the row's own wash fades out with it (the nav loses `data-marker`) rather than
 * the marker lingering where the row was.
 */
export function measureMarker(nav: HTMLElement): NavMarker | null {
  const row = nav.querySelector<HTMLElement>(".sidebar__link.is-active");
  if (!row || row.closest("[hidden]") || row.getClientRects().length === 0) return null;
  let top = 0;
  let box: HTMLElement | null = row;
  while (box && box !== nav) {
    top += box.offsetTop;
    const parent = box.offsetParent as HTMLElement | null;
    // An offset is measured to its parent's padding edge: a parent's own border is a step too.
    if (parent && parent !== nav) top += parent.clientTop;
    box = parent;
  }
  return box === nav ? { top, height: row.offsetHeight } : null;
}

/**
 * Sidebar navigation. Client-side ONLY because it needs `usePathname()` to mark the
 * active route — the list itself is computed and filtered on the server (`nav-model.ts`)
 * and passed in already stripped of anything this operator may not see.
 *
 * A6 (#2576):
 *  - GROUPS COLLAPSE. Each group's title is a disclosure button (`aria-expanded` /
 *    `aria-controls`); every group starts open, and the whole nav fits 1080p that way. A
 *    navigation into a collapsed group opens it, so the current page is never hidden. A group
 *    the operator has opened or closed is `data-moved`: only those animate (180ms), so nothing
 *    moves on a page load.
 *  - THE ACTIVE MARKER GLIDES. The active row's wash and spine are ONE element under the rows,
 *    moved by `transform` (220ms, --ease-glide), so changing page slides it from the old row to
 *    the new one; when the rows move under the same row (a group above it opening or closing) it
 *    moves in step with them (`data-snap`). Until it has been measured (and with no JS) each
 *    active row draws its own wash, as before; `data-marker` on the nav hands that job to the
 *    marker.
 */
export function SidebarNav({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname();
  const active = activeNavItem(sections, pathname);
  const activeGroup = active?.section.title ?? null;
  const baseId = useId();

  const [collapsed, setCollapsed] = useState<readonly string[]>([]);
  /** The groups the operator has toggled — the only ones whose opening and closing animate. */
  const [moved, setMoved] = useState<readonly string[]>([]);
  // A navigation INTO a collapsed group opens it — adjusted during render (React's pattern for
  // state that follows a prop), so the frame that shows the new page already shows its row.
  // Collapsing the current page's own group stays the operator's choice until they navigate.
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    if (activeGroup && collapsed.includes(activeGroup)) {
      setCollapsed(collapsed.filter((title) => title !== activeGroup));
    }
  }

  const navRef = useRef<HTMLElement>(null);
  const [marker, setMarker] = useState<PlacedMarker | null>(null);
  const activeHref = active?.item.href;
  // A LAYOUT effect, and a resize applied with flushSync: the marker is placed before the browser
  // paints, so no frame ever shows the rows moved and the marker not yet.
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    // An unchanged place keeps the same state object, so a resize that moved nothing re-renders
    // nothing. Only a NEW active row is glided to; the same row moved by the rows around it is
    // followed in step (`data-snap`), or the wash would trail across other rows for 220ms.
    const place = () => {
      const next = measureMarker(nav);
      setMarker((current) => {
        if (!next || !activeHref) return null;
        if (
          current?.href === activeHref &&
          current.top === next.top &&
          current.height === next.height
        ) {
          return current;
        }
        return {
          ...next,
          href: activeHref,
          glide: current !== null && current.href !== activeHref,
        };
      });
    };
    place();
    // The rows move without the route changing: a group opening or closing above the active row,
    // the rail widening, fonts arriving. The nav alone does not say so: on a tall screen it is
    // stretched to fill the sidebar and never resizes. Each GROUP does — a closing one only once
    // its exit has played (it stays laid out until then), which is when the rows below it move.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => flushSync(place));
    observer.observe(nav);
    nav.querySelectorAll(".sidebar__group").forEach((group) => observer.observe(group));
    return () => observer.disconnect();
  }, [activeHref, collapsed]);

  const toggle = (title: string) => {
    setMoved((current) => (current.includes(title) ? current : [...current, title]));
    setCollapsed((current) =>
      current.includes(title) ? current.filter((t) => t !== title) : [...current, title],
    );
  };

  return (
    <nav
      className="sidebar__nav"
      aria-label="Portal sections"
      ref={navRef}
      data-marker={marker ? "" : undefined}
    >
      {marker ? (
        <span
          className="sidebar__marker"
          aria-hidden="true"
          data-snap={marker.glide ? undefined : ""}
          style={
            {
              "--nav-marker-y": `${marker.top}px`,
              "--nav-marker-h": `${marker.height}px`,
            } as CSSProperties
          }
        />
      ) : null}
      {sections.map((section, index) => {
        const listId = `${baseId}-group-${index}`;
        const open = !collapsed.includes(section.title);
        return (
          <div
            className="sidebar__group"
            key={section.title}
            data-moved={moved.includes(section.title) ? "" : undefined}
          >
            <h2 className="sidebar__grouptitle">
              <button
                type="button"
                className="sidebar__grouptoggle"
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => toggle(section.title)}
              >
                <span className="sidebar__grouplabel">{section.title}</span>
                {/* The brand caret every disclosure draws: down while open, along the line while
                    closed. Decorative — the button's expanded state says it. */}
                <Icon name={ACTION_ICON.disclosure} className="sidebar__groupcaret" />
              </button>
            </h2>
            <ul className="sidebar__list" id={listId} hidden={!open}>
              {section.items.map((item) => {
                // Only the EXACT page is `aria-current="page"`; on a page below it the item is
                // the current SECTION, which is `"true"` — a screen reader must not hear
                // "current page" on the Candidates link while reading one candidate.
                const here = pathname === item.href;
                const isActive = active?.item.href === item.href;

                if (item.upcoming) {
                  return (
                    <li key={item.href}>
                      <span className="sidebar__link sidebar__link--upcoming" aria-disabled="true">
                        <Icon name={item.icon} className="sidebar__icon" />
                        <span className="sidebar__label">{item.label}</span>
                        <span className="sidebar__soon">Soon</span>
                      </span>
                    </li>
                  );
                }

                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`sidebar__link${isActive ? " is-active" : ""}`}
                      aria-current={here ? "page" : isActive ? "true" : undefined}
                    >
                      {/* Decorative: the label names the destination. The glyph inherits the
                          link colour, so the active row's is Safety Yellow on the navy band. */}
                      <Icon name={item.icon} className="sidebar__icon" />
                      <span className="sidebar__label">{item.label}</span>
                      {/* Pending while this link's navigation is under way (no loading boundary
                          shows it any more — components/nav-pending.tsx). */}
                      <NavPendingCue message={`Opening ${item.label}…`} />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
