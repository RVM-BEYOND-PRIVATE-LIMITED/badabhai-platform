"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@badabhai/icons";
import { isNavItemActive, type NavItem, type NavSection } from "./nav-model";

/**
 * The header's SECTION CONTEXT (IA-1; header model 2026-10-01).
 *
 * The page names itself in its own H1 (`PageHeader`), so the trail never repeats it. What the
 * header adds is WHERE the page sits: the rail group, and — on a page below a nav destination —
 * that destination as a link back to it:
 *
 *   /postings                 → Hiring                    (H1 "Postings")
 *   /postings/<id>            → Hiring › Postings          (H1 the role title)
 *   /postings/<id>/applicants → Hiring › Postings          (H1 "Applicants")
 *   /postings/ai/new          → Hiring › New posting       (H1 "Post with AI")
 *   /dashboard, /account      → nothing                    (no group; the H1 says it all)
 *
 * The trail is derived from the SAME nav model the rail renders, so a section can never be
 * named one thing on the left and another thing on top. Path segments below the destination
 * (ids, `/edit`, `/applicants`) are never rendered: an id is noise, and the view's own name is
 * the page's H1. A page that no nav item owns renders no trail at all, rather than a label no
 * nav uses.
 *
 * The current page is the rail's `aria-current` item; nothing here claims it.
 */

/** The deepest nav destination that owns `pathname`, with the group it sits in. */
function owningItem(
  sections: NavSection[],
  pathname: string,
): { item: NavItem; group: string | undefined } | null {
  let found: { item: NavItem; group: string | undefined } | null = null;
  for (const section of sections) {
    for (const item of section.items) {
      if (!isNavItemActive(item.match, pathname)) continue;
      // Prefer the most specific match when two items both claim the path.
      if (!found || item.href.length > found.item.href.length) {
        found = { item, group: section.title };
      }
    }
  }
  return found;
}

export function PortalBreadcrumb({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname();
  const owner = owningItem(sections, pathname);
  if (!owner) return null;

  // ON the destination itself, the H1 is its name: only the group is context. BELOW it, the
  // destination is the way back up, so it is a link.
  const below = pathname !== owner.item.href;
  if (!below && !owner.group) return null;

  return (
    <nav className="pcrumb" aria-label="Breadcrumb">
      {owner.group ? <span className="pcrumb__group">{owner.group}</span> : null}
      {below ? (
        <span className="pcrumb__step">
          {owner.group ? <Icon name="caret-right" className="pcrumb__sep" /> : null}
          {/* The label is its own box so IT ellipsizes: an `overflow: hidden` link would clip
              the link's own phone hit strip (globals.css). */}
          <Link className="pcrumb__link" href={owner.item.href}>
            <span className="pcrumb__label">{owner.item.label}</span>
          </Link>
        </span>
      ) : null}
    </nav>
  );
}
