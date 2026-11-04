import type { ReactNode } from "react";

/**
 * One SUB-SECTION of a `.panel` (A1, #2571).
 *
 * A panel that holds several blocks renders each as a `PanelSection`: consecutive sections sit
 * 24px apart and every one after the first opens with a hairline divider (`.panel__section` in
 * globals.css), so the parts of one card read as parts rather than as loose blocks sharing a
 * border. The optional `title` is the sub-section's own heading, one step below the panel's h2;
 * `titleId` is that heading's id, for the list or table that names itself with
 * `aria-labelledby`. Sections side by side in a `.cols` grid are columns, and the grid's gap
 * spaces them instead of a divider.
 */
export function PanelSection({
  title,
  titleId,
  children,
}: {
  title?: string;
  titleId?: string;
  children: ReactNode;
}) {
  return (
    <section className="panel__section">
      {title ? (
        <h3 className="panel__section-title" id={titleId}>
          {title}
        </h3>
      ) : null}
      {children}
    </section>
  );
}
