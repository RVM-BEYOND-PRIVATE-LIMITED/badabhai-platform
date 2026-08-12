"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavSection } from "./nav-model";

/**
 * The portal's primary navigation (IA-1) — a CLIENT wrapper that adds the active-route
 * highlight and `aria-current` on top of the SAME server-decided section list.
 *
 * This is presentation only. Which items exist, and which ones a given role may see, is
 * still decided on the server (`navSections` in the layout); the server route gates
 * (`requirePayer` / `requireAgent` / `requireOwner`) remain the authorization. An active
 * class is never a permission.
 *
 * COMING SOON items render as a <span>, not a <Link>. That is deliberate: a disabled
 * anchor is still focusable and still navigable by keyboard in most browsers, so a
 * greyed-out link that "does nothing" is a lie to anyone not using a mouse. Rendering a
 * non-anchor removes it from the tab order honestly, and `aria-disabled` plus the visible
 * COMING SOON badge tell assistive tech the same thing the greying tells everyone else.
 */
export function SidebarNav({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname();

  return (
    <nav className="pnav" aria-label="Primary">
      {sections.map((section, i) => (
        <div className="pnav__group" key={section.title ?? `lead-${i}`}>
          {section.title ? <h2 className="pnav__grouptitle">{section.title}</h2> : null}
          <ul className="pnav__list">
            {section.items.map((item) => {
              if (item.comingSoon) {
                return (
                  <li key={item.href}>
                    <span
                      className="pnav__link pnav__link--soon"
                      aria-disabled="true"
                      /* The tooltip carries the same sentence the expanded rail shows, so a
                         collapsed rail loses no meaning. */
                      title={item.description ? `${item.label} — ${item.description}` : item.label}
                    >
                      <i className={`ph ph-${item.icon} pnav__icon`} aria-hidden="true" />
                      <span className="pnav__label">{item.label}</span>
                      <span className="pnav__soon">Soon</span>
                    </span>
                  </li>
                );
              }

              const active = item.match(pathname);
              return (
                <li key={item.href}>
                  <Link
                    className={`pnav__link${active ? " pnav__link--active" : ""}`}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    title={item.description ? `${item.label} — ${item.description}` : item.label}
                  >
                    <i className={`ph ph-${item.icon} pnav__icon`} aria-hidden="true" />
                    <span className="pnav__label">{item.label}</span>
                    {/* PARKED — reachable, but the page it opens explains rather than does.
                        Badged so the rail sets the right expectation before the click. */}
                    {item.parked ? <span className="pnav__soon">Soon</span> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
