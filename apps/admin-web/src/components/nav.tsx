"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@badabhai/icons";
import type { NavSection } from "./nav-model";
import { NavPendingCue } from "./nav-pending";

/**
 * Sidebar navigation. Client-side ONLY because it needs `usePathname()` to mark the
 * active route — the list itself is computed and filtered on the server (`nav-model.ts`)
 * and passed in already stripped of anything this operator may not see.
 */
export function SidebarNav({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname();

  return (
    <nav className="sidebar__nav" aria-label="Portal sections">
      {sections.map((section) => (
        <div className="sidebar__group" key={section.title}>
          <h2 className="sidebar__grouptitle">{section.title}</h2>
          <ul className="sidebar__list">
            {section.items.map((item) => {
              // Exact match for the dashboard, prefix elsewhere, so /workers/123 still
              // highlights "Workers". Only the EXACT page is `aria-current="page"`; on a page
              // below it the item is the current SECTION, which is `"true"` — a screen reader
              // must not hear "current page" on the Workers link while reading one worker.
              const here = pathname === item.href;
              const active =
                item.href === "/"
                  ? here
                  : here || pathname.startsWith(`${item.href}/`);

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
                    className={`sidebar__link${active ? " is-active" : ""}`}
                    aria-current={here ? "page" : active ? "true" : undefined}
                  >
                    {/* Decorative: the label names the destination. The glyph inherits the
                        link colour, so the active row's is Safety Yellow on the navy band. */}
                    <Icon name={item.icon} className="sidebar__icon" />
                    <span className="sidebar__label">{item.label}</span>
                    {/* Pending while this link's navigation is under way (no loading boundary
                        shows it any more — components/nav-pending.tsx). */}
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
