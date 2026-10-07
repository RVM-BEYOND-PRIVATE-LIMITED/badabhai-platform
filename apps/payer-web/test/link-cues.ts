import type { ReactElement, ReactNode } from "react";

/**
 * Which links in an UNRENDERED element tree carry the navigation pending cue, for the suites that
 * walk a component's returned tree instead of rendering it.
 *
 * Every element with a string `href` prop is a link: a `PortalLink` (components/portal-link.tsx),
 * a DS Card / StatTile with `href` (its overlay is a `PortalLink`), or a raw `<a>`. A link carries
 * the cue exactly when it names one — its `pendingLabel` prop; the map gives each href the labels
 * of its links, so a link with none maps to `[]`. Function components are not expanded: what a
 * `PortalLink` renders from that prop is pinned by components/portal-link.test.tsx, and that every
 * in-app link IS one by app/every-link-shows-the-cue.test.ts.
 *
 * A link's children are walked too — a card's whole-card link wraps its "Applicants" link, which
 * is recorded under its own href.
 */
export function linkCues(tree: ReactNode): Map<string, string[]> {
  const out = new Map<string, string[]>();

  const walk = (node: ReactNode): void => {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const c of node) walk(c);
      return;
    }
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    if (!el.props) return;
    const { href, pendingLabel } = el.props;
    if (typeof href === "string") {
      const labels = typeof pendingLabel === "string" ? [pendingLabel] : [];
      out.set(href, [...(out.get(href) ?? []), ...labels]);
    }
    walk(el.props.children);
  };

  walk(tree);
  return out;
}
