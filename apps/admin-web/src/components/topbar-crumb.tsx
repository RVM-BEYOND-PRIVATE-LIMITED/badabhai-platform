"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@badabhai/icons";
import { NAV, type NavSection } from "./nav-model";
import { NavPendingCue } from "./nav-pending";

/**
 * The topbar's section context: where this page sits, never what it is called.
 *
 * The trail holds the page's ANCESTORS only. The page names itself in its own h1, so the crumb
 * never repeats it:
 *   - a top-level page (`/workers`) shows its sidebar group: `Operations`;
 *   - a page directly below a section (`/workers/<id>`) adds the section, UNLINKED:
 *     `Operations / Workers` — that page's back link already goes to `/workers` (its real parent
 *     is the section list), and one target is linked once per screen;
 *   - a deeper page adds the section, LINKED, and each NAMED step between the section and itself
 *     (`/workers/<id>/journey/<sid>` reads `Operations / Workers / Journey`); its back link goes
 *     to a record, not the section, so the crumb is the one link to the list.
 * A step is shown only when it is a known view of the record above it (`SEGMENT_LABELS`). Every
 * other segment is a record's id — a uuid, or any other key — and an id in a breadcrumb names
 * nothing a reader can use (on a session route it read like the worker's id). The page's back
 * link is where the parent is named, and linked, exactly.
 *
 * Derived from the SAME nav the sidebar renders, so a section is never called one thing on the
 * left and another on top. It reads the URL and the reader's already-filtered sections only: no
 * session and no entity data is resolved here.
 *
 * Otherwise the section is LINKED only when it is in `sections` — the sidebar the server filtered
 * by this reader's capabilities. A page can sit below a section its reader cannot open (an analyst on an
 * AI call's denied screen sits under AI calls, which is `read_ai_traces`); there the section is
 * named, not linked, rather than linked to a redirect.
 *
 * Markup: an ordered list in a labelled `nav`, one `li` per crumb, the caret separator inside
 * the step it introduces (decorative, hidden from assistive tech).
 */
export function TopbarCrumb({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname();
  const trail = crumbTrail(pathname);
  const sectionHref = trail?.section?.href;
  const linkable =
    sectionHref !== undefined &&
    !trail?.sectionIsParent &&
    sections.some((s) => s.items.some((i) => i.href === sectionHref));

  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <ol className="crumbs__list">
        {/* `crumb--group` lets the phone tier drop the group name once a section follows it:
            the open drawer already shows it, and at 375px keeping it truncates the rest. */}
        <li className="crumb crumb--group">{trail ? trail.group : "Admin"}</li>
        {trail?.section ? (
          <>
            <li className="crumb__step">
              <Separator />
              {linkable ? (
                <Link className="crumb crumb__link" href={trail.section.href}>
                  {trail.section.label}
                  <NavPendingCue label={trail.section.label} />
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
  journey: "Journey",
  timeline: "Event timeline",
};

export interface CrumbTrail {
  group: string;
  /** The nav section, present only when the page sits BELOW it (so it never repeats the h1). */
  section: { href: string; label: string } | null;
  /**
   * The page sits DIRECTLY below the section (`/workers/<id>`), so the section list is its real
   * parent — and its back link (header rule 1, docs/design/NAVIGATION.md) already links it.
   */
  sectionIsParent: boolean;
  /** Named views between the section and this page; this page and every id excluded. */
  steps: string[];
}

/** The ancestors of `pathname` as the crumb shows them, or null off the nav. */
export function crumbTrail(pathname: string): CrumbTrail | null {
  let group: string | undefined;
  let matched: { href: string; label: string } | undefined;
  for (const section of NAV) {
    for (const item of section.items) {
      const hit =
        item.href === "/"
          ? pathname === "/"
          : pathname === item.href || pathname.startsWith(`${item.href}/`);
      // Prefer the most specific match when two entries both claim the path.
      if (hit && (!matched || item.href.length > matched.href.length)) {
        group = section.title;
        matched = { href: item.href, label: item.label };
      }
    }
  }
  if (!group || !matched) return null;

  const below = pathname
    .slice(matched.href === "/" ? 1 : matched.href.length)
    .split("/")
    .filter(Boolean);
  if (below.length === 0) return { group, section: null, sectionIsParent: false, steps: [] };

  // The last segment is this page — its h1 names it. Of the ancestors before it, only a known
  // view is named; anything else is an id.
  const steps = below
    .slice(0, -1)
    .filter((s) => Object.hasOwn(SEGMENT_LABELS, s))
    .map((s) => SEGMENT_LABELS[s]!);
  return { group, section: matched, sectionIsParent: below.length === 1, steps };
}
