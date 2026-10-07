import type { ReactElement, ReactNode } from "react";

/**
 * Which links in an UNRENDERED element tree carry the navigation pending cue
 * (`NavPendingCue`, components/nav-pending.tsx), for the suites that walk a component's returned
 * tree instead of rendering it.
 *
 * Every element with a string `href` prop is a link (a `<Link>`, or a DS card with `href`). The
 * map gives each href the labels of the cues inside it — not counting a cue that sits inside a
 * NESTED link (a card's whole-card link wraps its "Applicants" link; that cue is the inner
 * link's). Function components are not expanded: the cue is matched by its type.
 */
export function linkCues(tree: ReactNode, cue: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();

  const cuesIn = (node: ReactNode, into: string[]): void => {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const c of node) cuesIn(c, into);
      return;
    }
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    if (!el.props) return;
    if (el.type === cue) {
      into.push(String(el.props.label));
      return;
    }
    if (typeof el.props.href === "string") {
      visitLink(el);
      return;
    }
    cuesIn(el.props.children, into);
  };

  const visitLink = (el: ReactElement<Record<string, unknown> & { children?: ReactNode }>) => {
    const labels: string[] = [];
    cuesIn(el.props.children, labels);
    const href = el.props.href as string;
    out.set(href, [...(out.get(href) ?? []), ...labels]);
  };

  cuesIn(tree, []);
  return out;
}
