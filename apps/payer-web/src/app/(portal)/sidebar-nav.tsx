"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Icon } from "@badabhai/icons";
import { PortalLink } from "../../components/portal-link";
import { isNavItemActive, type NavSection } from "./nav-model";

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
 * THE SELECTED PLATE SLIDES. One absolutely-positioned Safety Yellow plate is measured to the
 * active row and animates to the next one on a route change, so switching destinations reads as
 * one continuous move instead of a colour blink on two rows. The plate is the fill; the active
 * row only owns the navy text/icon (9.39:1 on the yellow).
 */
/** Measure before paint on the client; fall back to useEffect during SSR (no warning). */
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

export function SidebarNav({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);
  const [plate, setPlate] = useState<{ top: number; height: number } | null>(null);

  useIsomorphicLayoutEffect(() => {
    const nav = navRef.current;
    if (nav === null) return undefined;

    const measure = () => {
      const active = nav.querySelector<HTMLElement>(".pnav__link--active");
      if (active === null) {
        setPlate(null);
        return;
      }
      const navBox = nav.getBoundingClientRect();
      const rowBox = active.getBoundingClientRect();
      setPlate({ top: rowBox.top - navBox.top, height: rowBox.height });
    };

    measure();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(nav);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [pathname, sections]);

  return (
    <nav className="pnav" aria-label="Primary" ref={navRef}>
      <span
        className="pnav__plate"
        aria-hidden="true"
        style={{
          transform: plate === null ? undefined : `translateY(${plate.top}px)`,
          height: plate === null ? undefined : `${plate.height}px`,
          opacity: plate === null ? 0 : 1,
        }}
      />
      {sections.map((section, i) => (
        <div className="pnav__group" key={section.title ?? `lead-${i}`}>
          {section.title ? <h2 className="pnav__grouptitle">{section.title}</h2> : null}
          <ul className="pnav__list">
            {section.items.map((item) => {
              const active = isNavItemActive(item.match, pathname);
              return (
                <li key={item.href}>
                  {/* The navigation this row starts shows the pending cue (components/portal-link.tsx). */}
                  <PortalLink
                    className={`pnav__link${active ? " pnav__link--active" : ""}`}
                    href={item.href}
                    pendingLabel={item.label}
                    aria-current={active ? "page" : undefined}
                    title={item.description ? `${item.label} — ${item.description}` : item.label}
                  >
                    <Icon name={item.icon} className="pnav__icon" />
                    <span className="pnav__label">{item.label}</span>
                    {/* PARKED — reachable, but the page it opens explains rather than does.
                        Badged so the rail sets the right expectation before the click. */}
                    {item.parked ? <span className="pnav__soon">Soon</span> : null}
                  </PortalLink>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
