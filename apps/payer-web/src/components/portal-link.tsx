import Link from "next/link";
import type { ComponentProps } from "react";
import { NavPendingCue } from "./nav-pending";

/**
 * THE PORTAL'S ONLY IN-APP LINK: next/link's `Link` with the navigation pending cue inside it.
 *
 * The portal has no loading boundary (app/no-suspense-above-a-page.test.ts), so a navigation keeps
 * the current page on screen until the next one has rendered. A link that does not carry the cue
 * (components/nav-pending.tsx) answers a click on a slow backend with nothing at all — measured
 * before this wrapper existed: ~3s of nothing on a dashboard quick card at 1.5s per read, where
 * the old skeleton had shown at ~0.1–0.25s. So no module but this one may render `Link` itself
 * (app/every-link-shows-the-cue.test.ts): every in-app link is a `PortalLink`, and a `PortalLink`
 * cannot be written without naming its destination for the cue.
 *
 * `pendingLabel` is what the shell's status line says while the navigation is pending ("Opening
 * {pendingLabel}…") — the destination, in the portal's own words (a rail item's label, a posting's
 * title, "Applicants"), not the link's visible text when that is an action ("Buy credits" opens
 * Credits).
 *
 * The cue is the LAST direct child of the `<a>`: its anchor rule and the rail's inside-the-corner
 * rule key on `a > .nav-pending` (globals.css). It is hidden from assistive tech, so the link's
 * accessible name is its children (or its `aria-label`) exactly as before.
 *
 * Not for links that leave the app or the page's own fragments — an external URL, `mailto:` /
 * `tel:`, a hash-only `#id`, a `download` or a new tab: none of those is a pending in-app
 * navigation, and they stay plain `<a>` elements. Conversely a plain `<a>` to an in-app path is a
 * full reload with no cue — the fence rejects that too.
 *
 * No `"use client"`: a server component renders it as it is (the `Link` and the cue are the
 * client parts), and a client component imports it like any other.
 */
export type PortalLinkProps = Omit<ComponentProps<typeof Link>, "href"> & {
  /** An in-app path ("/postings/<id>", "/agency/referrals#batch-invites") or a query ("?cursor=…"). */
  href: string;
  /** The destination the pending cue names ("Opening {pendingLabel}…"). */
  pendingLabel: string;
};

export function PortalLink({ pendingLabel, children, ...link }: PortalLinkProps) {
  return (
    <Link {...link}>
      {children}
      <NavPendingCue label={pendingLabel} />
    </Link>
  );
}
