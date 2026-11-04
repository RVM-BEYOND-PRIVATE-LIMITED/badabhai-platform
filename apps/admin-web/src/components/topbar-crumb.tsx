"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@badabhai/icons";
import { NAV, activeNavItem, type NavSection } from "./nav-model";
import { NavPendingCue } from "./nav-pending";

/**
 * The topbar's breadcrumb: "Group › Page" (A6, #2576) — where this page sits in the sidebar.
 *
 *   - a sidebar destination (`/candidates`) reads `Directory › Candidates`, the page itself the
 *     last step, marked `aria-current="page"` and not linked;
 *   - a page directly below a section (`/candidates/<id>`) reads the same, the section UNLINKED:
 *     that page's back link already goes to `/candidates` (its real parent is the section list),
 *     and one target is linked once per screen;
 *   - a deeper page adds the section, LINKED, and each NAMED step between the section and itself
 *     (`/candidates/<id>/journey/<sid>` reads `Directory › Candidates › Journey`); its back link
 *     goes to a record, not the section, so the crumb is the one link to the list.
 * A step is shown only when it is a known view of the record above it (`SEGMENT_LABELS`). Every
 * other segment is a record's id — a uuid, or any other key — and an id in a breadcrumb names
 * nothing a reader can use. The page's back link is where the parent is named, and linked, exactly.
 *
 * Derived from the SAME nav the sidebar renders (`activeNavItem`), so a section is never called
 * one thing on the left and another on top. It reads the URL and the reader's already-filtered
 * sections only: no session and no entity data is resolved here.
 *
 * The section is LINKED only when it is in `sections` — the sidebar the server filtered by this
 * reader's capabilities. A page can sit below a section its reader cannot open (an analyst on an
 * AI call's denied screen sits under AI calls, which is `read_ai_traces`); there the section is
 * named, not linked, rather than linked to a redirect.
 *
 * Markup: an ordered list in a labelled `nav`, one `li` per crumb, the caret separator inside
 * the step it introduces (decorative, hidden from assistive tech).
 */
export function TopbarCrumb({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname();
  const trail = crumbTrail(pathname);
  const linkable =
    trail !== null &&
    !trail.sectionIsPage &&
    !trail.sectionIsParent &&
    sections.some((s) => s.items.some((i) => i.href === trail.section.href));

  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <ol className="crumbs__list">
        {/* `crumb--group` lets the phone tier drop the group name once a step follows it: the
            open drawer already shows it, and at 375px keeping it truncates the rest. */}
        <li className="crumb crumb--group">{trail ? trail.group : "Admin"}</li>
        {trail ? (
          <>
            <li className="crumb__step">
              <Separator />
              {trail.sectionIsPage ? (
                <span className="crumb" aria-current="page">
                  {trail.section.label}
                </span>
              ) : linkable ? (
                <Link className="crumb crumb__link" href={trail.section.href}>
                  {trail.section.label}
                  <NavPendingCue message={`Opening ${trail.section.label}…`} />
                </Link>
              ) : (
                <span className="crumb">{trail.section.label}</span>
              )}
            </li>
            {trail.steps.map((step, i) => (
              <li className="crumb__step" key={`${step}-${i}`}>
                <Separator />
                <span className="crumb">{step}</span>
              </li>
            ))}
          </>
        ) : null}
      </ol>
    </nav>
  );
}

function Separator() {
  return <Icon name="caret-right" className="crumb__sep" />;
}

/**
 * The path segments that are a VIEW of the record above them, by the name the screen uses. The
 * ONLY segments a crumb shows below the section; add a route's view here to name it.
 */
export const SEGMENT_LABELS: Readonly<Record<string, string>> = {
  // `/jobs/agency/…` — the agency postings, a view of Postings (A6).
  agency: "Agency postings",
  journey: "Journey",
  timeline: "Event timeline",
};

export interface CrumbTrail {
  group: string;
  /** The nav section the page sits in — on a sidebar destination, the page itself. */
  section: { href: string; label: string };
  /** The page IS the section (a sidebar destination): the crumb's last step, the current page. */
  sectionIsPage: boolean;
  /**
   * The page sits DIRECTLY below the section (`/candidates/<id>`), so the section list is its
   * real parent — and its back link (header rule 1, docs/design/NAVIGATION.md) already links it.
   */
  sectionIsParent: boolean;
  /** Named views between the section and this page; this page and every id excluded. */
  steps: string[];
}

/** The crumb `pathname` shows — group, section, named views — or null off the nav. */
export function crumbTrail(pathname: string): CrumbTrail | null {
  const match = activeNavItem(NAV, pathname);
  if (!match) return null;
  const group = match.section.title;
  const section = { href: match.item.href, label: match.item.label };

  const below = pathname
    .slice(section.href === "/" ? 1 : section.href.length)
    .split("/")
    .filter(Boolean);
  if (below.length === 0) {
    return { group, section, sectionIsPage: true, sectionIsParent: false, steps: [] };
  }

  // The last segment is this page — its h1 names it. Of the ancestors before it, only a known
  // view is named; anything else is an id.
  const steps = below
    .slice(0, -1)
    .filter((s) => Object.hasOwn(SEGMENT_LABELS, s))
    .map((s) => SEGMENT_LABELS[s]!);
  return { group, section, sectionIsPage: false, sectionIsParent: below.length === 1, steps };
}
