"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isNavItemActive, type NavSection } from "./nav-model";

/**
 * The header's location indicator (IA-1).
 *
 * The old shell told you where you were with exactly one signal: a tinted pill in a
 * wrapping row of links. On a detail route — `/postings/<uuid>/applicants` — that pill lit
 * up "Manage postings" and nothing on the page said which posting, or that you were two
 * levels deep. The header now carries the trail.
 *
 * The trail is derived from the SAME nav model the rail renders, so a section can never be
 * named one thing on the left and another thing on top. Anything below a nav destination
 * (a posting id, `/edit`, `/applicants`) is appended from the path itself.
 *
 * `leaf` lets a server page override that last crumb with something meaningful — a role
 * title instead of a uuid. It is plain display text; nothing here reads or exposes a
 * session, and no id in a crumb is anything but the payer's own opaque resource id.
 */

/** Path segments that are a VIEW of the resource above them rather than a resource. */
const SEGMENT_LABELS: Record<string, string> = {
  applicants: "Applicants",
  edit: "Edit",
  new: "New",
  ai: "AI assistant",
  accept: "Accept invite",
};

function isOpaqueId(segment: string): boolean {
  // A uuid, or any long hex-ish handle. Rendering one as a breadcrumb is noise — the caller
  // should pass `leaf` for those, and we fall back to a generic word rather than a raw id.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(segment) || /^[0-9a-f]{16,}$/i.test(segment);
}

export function PortalBreadcrumb({
  sections,
  leaf,
}: {
  sections: NavSection[];
  leaf?: string;
}) {
  const pathname = usePathname();

  // Find the deepest nav destination that owns this path, and the group it sits in.
  let matchedTitle: string | undefined;
  let matched: { href: string; label: string } | undefined;
  for (const section of sections) {
    for (const item of section.items) {
      if (!isNavItemActive(item.match, pathname)) continue;
      // Prefer the most specific match when two items both claim the path.
      if (!matched || item.href.length > matched.href.length) {
        matched = { href: item.href, label: item.label };
        matchedTitle = section.title;
      }
    }
  }

  if (!matched) {
    return (
      <nav className="pcrumb" aria-label="Breadcrumb">
        <span className="pcrumb__here">Portal</span>
      </nav>
    );
  }

  // Everything the matched nav item did not account for becomes the tail of the trail.
  const base = matched.href.split("/").filter(Boolean);
  const here = pathname.split("/").filter(Boolean);
  const tail = here.slice(base.length).filter((s) => !isOpaqueId(s));

  const trailing = leaf ? [...tail.map(labelFor), leaf] : tail.map(labelFor);

  return (
    <nav className="pcrumb" aria-label="Breadcrumb">
      {matchedTitle ? (
        <>
          <span className="pcrumb__group">{matchedTitle}</span>
          <i className="ph ph-caret-right pcrumb__sep" aria-hidden="true" />
        </>
      ) : null}

      {trailing.length === 0 ? (
        <span className="pcrumb__here" aria-current="page">
          {matched.label}
        </span>
      ) : (
        <>
          <Link className="pcrumb__link" href={matched.href}>
            {matched.label}
          </Link>
          {trailing.map((crumb, i) => (
            <span className="pcrumb__step" key={`${crumb}-${i}`}>
              <i className="ph ph-caret-right pcrumb__sep" aria-hidden="true" />
              {i === trailing.length - 1 ? (
                <span className="pcrumb__here" aria-current="page">
                  {crumb}
                </span>
              ) : (
                <span className="pcrumb__group">{crumb}</span>
              )}
            </span>
          ))}
        </>
      )}
    </nav>
  );
}

function labelFor(segment: string): string {
  return (
    SEGMENT_LABELS[segment] ??
    segment.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase())
  );
}
