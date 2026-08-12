"use client";

import { usePathname } from "next/navigation";
import { NAV } from "./nav-model";

/**
 * The topbar's location indicator.
 *
 * The topbar previously held a hamburger and a flex spacer — nothing else. On a console
 * whose routes are `/workers/<uuid>` and `/companies/<uuid>`, that left the sidebar's
 * active pill as the only "where am I", and on a detail page even that only named the
 * section. The trail now names the section and the row.
 *
 * It is derived from the SAME NAV the sidebar renders, so a section can never be called one
 * thing on the left and another on top. This reads the URL only — no session, no capability
 * and no entity data is resolved here, and an opaque id is shown truncated rather than as a
 * 36-character uuid that pushes everything else off the line.
 */
export function TopbarCrumb() {
  const pathname = usePathname();

  let group: string | undefined;
  let label: string | undefined;
  let matchedHref = "";
  for (const section of NAV) {
    for (const item of section.items) {
      const hit = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
      // Prefer the most specific match when two entries both claim the path.
      if (hit && item.href.length >= matchedHref.length) {
        group = section.title;
        label = item.label;
        matchedHref = item.href;
      }
    }
  }

  if (!label) return <span className="crumb crumb--here">Admin</span>;

  // Anything past the matched nav destination is the tail — typically one opaque entity id.
  const rest = pathname
    .slice(matchedHref === "/" ? 1 : matchedHref.length)
    .split("/")
    .filter(Boolean);

  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {group ? (
        <>
          <span className="crumb">{group}</span>
          <span className="crumb__sep" aria-hidden="true">
            /
          </span>
        </>
      ) : null}
      <span className={rest.length === 0 ? "crumb crumb--here" : "crumb"}>{label}</span>
      {rest.length > 0 ? (
        <>
          <span className="crumb__sep" aria-hidden="true">
            /
          </span>
          <span className="crumb crumb--here mono" title={rest.join("/")}>
            {shorten(rest[rest.length - 1]!)}
          </span>
        </>
      ) : null}
    </nav>
  );
}

/** A uuid is unreadable in a breadcrumb; the leading block is enough to recognise a row. */
function shorten(segment: string): string {
  return segment.length > 12 ? `${segment.slice(0, 8)}…` : segment;
}
