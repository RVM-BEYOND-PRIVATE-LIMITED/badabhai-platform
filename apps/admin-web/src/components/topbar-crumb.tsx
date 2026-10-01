"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@badabhai/icons";
import { NAV, type NavSection } from "./nav-model";

/**
 * The topbar's section context: where this page sits, never what it is called.
 *
 * The trail holds the page's ANCESTORS only. The page names itself in its own h1, so the crumb
 * never repeats it:
 *   - a top-level page (`/workers`) shows its sidebar group: `Operations`;
 *   - a page below a section (`/workers/<id>`) adds the section, LINKED: `Operations / Workers`;
 *   - a deeper page adds each readable step between the section and itself
 *     (`/workers/<id>/journey/<sid>` reads `Operations / Workers / Journey`).
 * Opaque ids are left out at every level. A truncated uuid in a breadcrumb names nothing a
 * reader can use, and on a session route it read like the worker's id. The page's back link is
 * where the parent is named, and linked, exactly.
 *
 * Derived from the SAME nav the sidebar renders, so a section is never called one thing on the
 * left and another on top. It reads the URL and the reader's already-filtered sections only: no
 * session and no entity data is resolved here.
 *
 * The section is LINKED only when it is in `sections` — the sidebar the server filtered by this
 * reader's capabilities. A page can sit below a section its reader cannot open (an analyst on an
 * AI call's denied screen sits under AI calls, which is `read_ai_traces`); there the section is
 * named, not linked, rather than linked to a redirect.
 */
export function TopbarCrumb({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname();
  const trail = crumbTrail(pathname);
  const sectionHref = trail?.section?.href;
  const linkable =
    sectionHref !== undefined && sections.some((s) => s.items.some((i) => i.href === sectionHref));

  if (!trail) {
    return (
      <nav className="crumbs" aria-label="Breadcrumb">
        <span className="crumb crumb--group">Admin</span>
      </nav>
    );
  }

  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {/* `crumb--group` lets the phone tier drop the group name once a section follows it: the
          open drawer already shows it, and at 375px keeping it truncates the rest. */}
      <span className="crumb crumb--group">{trail.group}</span>
      {trail.section ? (
        <>
          <Separator />
          {linkable ? (
            <Link className="crumb crumb__link" href={trail.section.href}>
              {trail.section.label}
            </Link>
          ) : (
            <span className="crumb">{trail.section.label}</span>
          )}
          {trail.steps.map((step, i) => (
            <span className="crumb__step" key={`${step}-${i}`}>
              <Separator />
              <span className="crumb">{step}</span>
            </span>
          ))}
        </>
      ) : null}
    </nav>
  );
}

function Separator() {
  return <Icon name="caret-right" className="crumb__sep" />;
}

/** Path segments that are a view of the record above them, by the name the screen uses. */
const SEGMENT_LABELS: Record<string, string> = {
  journey: "Journey",
  timeline: "Event timeline",
};

/** A uuid or a long hex handle. Never shown as a crumb. */
export function isOpaqueId(segment: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(segment) || /^[0-9a-f]{16,}$/i.test(segment);
}

function segmentLabel(segment: string): string {
  return SEGMENT_LABELS[segment] ?? segment.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export interface CrumbTrail {
  group: string;
  /** The nav section, present only when the page sits BELOW it (so it never repeats the h1). */
  section: { href: string; label: string } | null;
  /** Readable steps between the section and this page; this page and every opaque id excluded. */
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
  if (below.length === 0) return { group, section: null, steps: [] };

  // The last segment is this page — its h1 names it. Everything before it is an ancestor.
  const steps = below
    .slice(0, -1)
    .filter((s) => !isOpaqueId(s))
    .map(segmentLabel);
  return { group, section: matched, steps };
}
