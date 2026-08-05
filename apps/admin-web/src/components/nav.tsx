"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavSection } from "./nav-model";

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
              // highlights "Workers".
              const active =
                item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);

              if (item.upcoming) {
                return (
                  <li key={item.href}>
                    <span className="sidebar__link sidebar__link--upcoming" aria-disabled="true">
                      {item.label}
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
                    aria-current={active ? "page" : undefined}
                  >
                    {item.label}
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
