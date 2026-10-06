"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@badabhai/icons";
import { navTrail, type NavSection } from "./nav-model";

/**
 * The header's SECTION CONTEXT (IA-1; header model 2026-10-01).
 *
 * The page names itself in its own H1 (`PageHeader`), so the trail never repeats it. What the
 * header adds is WHERE the page sits: the rail group, and — on a page below a nav destination —
 * that destination:
 *
 *   /postings                 → Hiring                          (H1 "Postings")
 *   /postings/<id>            → Hiring                          (back link "Postings")
 *   /postings/<id>/applicants → Hiring › Postings   as a LINK   (back link "<the posting>")
 *   /postings/ai/new          → Hiring                          (a mode of New posting)
 *   /team/accept (owner)      → Organisation › Team as a LINK   (no back link)
 *   /dashboard, /account      → nothing
 *
 * ONE DOOR PER DESTINATION, ONE NAME PER HEAD: a page one level below a destination is reached
 * back through the page itself (`NavItem.childrenLinkBack`: its back link, which NAMES the
 * destination), so there the trail is the group alone — printing the destination too put the
 * same word twice in the head (F16). Deeper pages keep the destination as a link (their back link
 * goes to a nearer parent). A trail with no link is not a navigation landmark, so it renders as
 * plain text, not a `<nav>`.
 *
 * The trail is derived from the SAME nav model the rail renders, so a section can never be named
 * one thing on the left and another thing on top. Ids and view segments are never rendered. A
 * page that no nav item owns renders no trail at all, rather than a label no nav uses. The
 * current page is the rail's `aria-current` item; nothing here claims it.
 */

export function PortalBreadcrumb({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname();
  // The destination that owns this path, its group and the depth below it (nav-model.ts).
  const owner = navTrail(sections, pathname);
  if (!owner) return null;

  const { depth } = owner;
  // ON the destination itself the H1 is its name; one level below a destination whose children
  // link back to it, the back link names it. Either way only the group is context.
  const namedByPage = depth === 0 || (owner.item.childrenLinkBack === true && depth === 1);
  if (namedByPage && !owner.group) return null;
  // Below that, the destination is a step of the trail — and a LINK (the back link goes nearer),
  // so only such a trail is a navigation landmark.
  const showSection = !namedByPage;

  const steps = (
    <>
      {owner.group ? <span className="pcrumb__group">{owner.group}</span> : null}
      {showSection ? (
        <span className="pcrumb__step">
          {owner.group ? <Icon name="caret-right" className="pcrumb__sep" /> : null}
          {/* The label is its own box so IT ellipsizes: an `overflow: hidden` link would clip
              the link's own phone hit strip (globals.css). */}
          <Link className="pcrumb__link" href={owner.item.href}>
            <span className="pcrumb__label">{owner.item.label}</span>
          </Link>
        </span>
      ) : null}
    </>
  );

  return showSection ? (
    <nav className="pcrumb" aria-label="Breadcrumb">
      {steps}
    </nav>
  ) : (
    <div className="pcrumb">{steps}</div>
  );
}
