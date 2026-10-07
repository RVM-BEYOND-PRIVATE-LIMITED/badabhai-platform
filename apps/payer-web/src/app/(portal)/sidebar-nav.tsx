"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@badabhai/icons";
import { NavPendingCue } from "../../components/nav-pending";
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
              const active = isNavItemActive(item.match, pathname);
              return (
                <li key={item.href}>
                  <Link
                    className={`pnav__link${active ? " pnav__link--active" : ""}`}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    title={item.description ? `${item.label} — ${item.description}` : item.label}
                  >
                    <Icon name={item.icon} className="pnav__icon" />
                    <span className="pnav__label">{item.label}</span>
                    {/* PARKED — reachable, but the page it opens explains rather than does.
                        Badged so the rail sets the right expectation before the click. */}
                    {item.parked ? <span className="pnav__soon">Soon</span> : null}
                    {/* The navigation this row started is under way (components/nav-pending.tsx). */}
                    <NavPendingCue label={item.label} />
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
