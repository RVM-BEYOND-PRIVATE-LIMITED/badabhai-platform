"use client";

import { usePathname } from "next/navigation";
import { PageHeader } from "./page-header";
import { crumbTrail } from "./topbar-crumb";

/**
 * The header of the portal's two fallback screens — the error boundary and not-found — which
 * replace whatever page was going to render at this address, and so cannot be told its parent.
 *
 * They read it off the address the same way the topbar crumb does: a page DIRECTLY below a section
 * (`/workers/<id>`) has the section list as its real parent, so the screen keeps that page's back
 * link to it — and the crumb, which leaves that section unlinked because the back link is the one
 * link to it, is not left as the only way to the list. Anywhere else (a top-level page, a deeper
 * child whose parent is a record) there is no parent this screen could name honestly, so it
 * renders none.
 */
export function FallbackHeader({ title, description }: { title: string; description: string }) {
  const trail = crumbTrail(usePathname());
  const back =
    trail?.section && trail.sectionIsParent
      ? { href: trail.section.href, label: trail.section.label }
      : undefined;
  return <PageHeader back={back} title={title} description={description} />;
}
