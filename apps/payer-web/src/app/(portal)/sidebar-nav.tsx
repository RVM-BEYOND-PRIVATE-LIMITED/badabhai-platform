"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Icon } from "@badabhai/icons";
import { PortalLink } from "../../components/portal-link";
import { isNavItemActive, type NavSection } from "./nav-model";
import { railMarkerRef } from "./rail-marker";
import { RailPress, useMarkedPath } from "./rail-press";

/**
 * The portal's primary navigation (IA-1) — a CLIENT wrapper that adds the active-route
 * highlight and `aria-current` on top of the SAME server-decided section list.
 *
 * This is presentation only. Which items exist, and which ones a given role may see, is
 * still decided on the server (`navSections` in the layout); the server route gates
 * (`requirePayer` / `requireAgent` / `requireOwner`) remain the authorization. An active
 * class is never a permission.
 *
 * Every item is a link. The model only contains destinations whose page renders for this
 * session (nav-model.ts: the nav follows the page gate), so there is no disabled state to draw;
 * a PARKED item is a real page that explains what is not built, badged "Soon".
 *
 * THE ACTIVE ROW IS PAINTED IN PLACE. The Safety Yellow plate is the active row's own CSS
 * background (`.pnav__link--active` in globals.css), keyed off the class this component renders
 * on the server — so the selected item is readable before scripts load (or with JS disabled)
 * and never slides in from the top on first paint (W2 #2582).
 *
 * …AND IT MOVES ON THE PRESS (W6 #2586). The active row is the row the rail marks: the destination
 * of a press whose navigation is under way, or else the page that is open (rail-press.tsx, whose
 * scope AppShell puts around the rail). Each row reports its own press; so does the brand lockup.
 * Once scripts run, one marker carries the plate there in a 320ms glide, and each label takes the
 * active ink only once the plate is under it (rail-marker.ts). `aria-current` stays on the page
 * that is actually open, because a pending press is not the current page.
 */
/** Measure before paint on the client; fall back to useEffect during SSR (no warning). */
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

export function SidebarNav({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname();
  const markedPath = useMarkedPath() ?? pathname;

  return (
    <nav className="pnav" aria-label="Primary" ref={(el) => railMarkerRef(el)}>
      {sections.map((section, i) => (
        <div className="pnav__group" key={section.title ?? `lead-${i}`}>
          {section.title ? <h2 className="pnav__grouptitle">{section.title}</h2> : null}
          <ul className="pnav__list">
            {section.items.map((item) => {
              const marked = isNavItemActive(item.match, markedPath);
              const onPage = isNavItemActive(item.match, pathname);
              return (
                <li key={item.href}>
                  {/* The navigation this row starts shows the pending cue (components/portal-link.tsx). */}
                  <PortalLink
                    className={`pnav__link${marked ? " pnav__link--active" : ""}`}
                    href={item.href}
                    pendingLabel={item.label}
                    aria-current={onPage ? "page" : undefined}
                    title={item.description ? `${item.label} — ${item.description}` : item.label}
                  >
                    <Icon name={item.icon} className="pnav__icon" />
                    <span className="pnav__label">{item.label}</span>
                    {/* PARKED — reachable, but the page it opens explains rather than does.
                        Badged so the rail sets the right expectation before the click. */}
                    {item.parked ? <span className="pnav__soon">Soon</span> : null}
                    <RailPress href={item.href} />
                  </PortalLink>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {/* The gliding plate, not drawn until rail-marker.ts has placed it (globals.css, W6 block).
          It comes AFTER the groups so that their entrance stagger (`.pnav__group:nth-child`)
          still counts groups from the first one. It is drawn behind every row by z-index, not by
          source order. */}
      <span className="pnav__marker" aria-hidden="true" />
    </nav>
  );
}
