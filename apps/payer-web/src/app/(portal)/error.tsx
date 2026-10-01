"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { navTrail } from "./nav-model";
import { useNavSections } from "./nav-context";

/**
 * Client error boundary for the authed portal (ADR-0019 Phase 1).
 *
 * NO-LEAK: it renders a NEUTRAL, generic message ONLY. It never surfaces the error
 * `cause`, `message`, `digest`, or stack — a backend/deny detail could carry a hint
 * (no-oracle) or PII, so none of it reaches the screen. The `reset()` retry re-renders
 * the segment. Nothing is logged client-side.
 *
 * UI-1: composed from the shared `.state state--error` block — the SAME error language the
 * dashboard's read-failure fallback uses — instead of a private chrome-title/chrome-sub/
 * chrome-actions copy of the pattern. Only the markup changed; the copy and the `reset()`
 * wiring are byte-for-byte what they were.
 *
 * A WAY OUT (2026-10-01). The error replaces the page — and with it the page's back link — while
 * the header trail still names the parent as TEXT on a page one level below a destination (the
 * back link was the way up). So besides Try again the boundary offers the way back up: the
 * section the path sits under (the trail's destination, from the SAME nav model the rail renders
 * — `navTrail`), and the Dashboard. Neither link is offered on the page it would reopen.
 */
export default function PortalError({ reset }: { error: Error; reset: () => void }) {
  const pathname = usePathname();
  const trail = navTrail(useNavSections(), pathname);
  // Below a destination (a posting's details, its applicants…): the destination is the way up.
  const section = trail && trail.depth > 0 ? trail.item : null;
  const toDashboard = pathname !== "/dashboard";
  return (
    <div className="state state--error" role="alert">
      <span className="state__icon">
        <i className="ph-fill ph-warning-circle" aria-hidden="true" />
      </span>
      <h1 className="state__title">Something went wrong</h1>
      <p className="state__body">
        We couldn&rsquo;t load this page right now. This is on our side — please try again.
      </p>
      <div className="state__actions">
        <button className="bb-btn bb-btn--primary" type="button" onClick={() => reset()}>
          <span>Try again</span>
        </button>
        {section ? (
          <Link className="bb-btn bb-btn--secondary" href={section.href}>
            <Icon name={ACTION_ICON.back} />
            <span>{section.label}</span>
          </Link>
        ) : null}
        {toDashboard ? (
          <Link className="bb-btn bb-btn--secondary" href="/dashboard">
            <Icon name="squares-four" />
            <span>Dashboard</span>
          </Link>
        ) : null}
      </div>
    </div>
  );
}
