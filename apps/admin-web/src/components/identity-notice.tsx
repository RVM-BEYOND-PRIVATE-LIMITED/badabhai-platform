import type { ReactNode } from "react";

/**
 * "Names are withheld on this page" — the CAPPED posture, and only that one.
 *
 * It exists because the alternative is silence. This operator's role DOES see names, they saw
 * them on the previous screen, and this response carried none; without a banner the console
 * looks like it regressed, or — worse — like these particular accounts have no names. Neither
 * is true, and both would be acted on.
 *
 * It is deliberately NOT rendered for the FACELESS posture. An `analyst` is not having anything
 * withheld from this response in particular; their console simply does not carry names, and a
 * warning banner on every page load would be noise that teaches operators to ignore the banner
 * on the day it means something.
 *
 * The CAUSE is a `children` sentence rather than fixed copy, because it differs by surface: the
 * paged lists are clamped to the server's 50-name bound so a cap there is always the hourly
 * budget, while the unpaginated admin directory can also trip the per-response bound outright.
 */
export function IdentityCapNotice({ children }: { children: ReactNode }) {
  return (
    <section className="notice notice--warn" role="status">
      <strong>Names are withheld on this page.</strong> {children} Every other field below is
      unaffected, and the ids still link to the same records.
    </section>
  );
}
