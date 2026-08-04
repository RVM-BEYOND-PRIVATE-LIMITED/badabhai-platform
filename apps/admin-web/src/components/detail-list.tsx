import { Fragment, type ReactNode } from "react";

/**
 * A key/value block for detail screens.
 *
 * Renders the EXISTING `.kv` styles the event-detail screen already uses — this is a
 * component wrapper around a shipped pattern, not a second one. A parallel `.dl` would
 * have meant two key/value looks drifting apart across the portal.
 *
 * `value` is a ReactNode rather than a string so a row can carry a pill, a link or a
 * `<time>` without this growing a variant for each. A null value renders an em dash: an
 * absent value is information ("no scheduled deletion"), and dropping the row would leave
 * the reader unsure whether the field exists at all.
 */
export function DetailList({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="kv">
      {items.map(({ label, value }) => (
        // A Fragment, NOT a wrapping div: `.kv` is a two-column grid whose children are the
        // `dt`/`dd` themselves. Wrapping a pair would make it one grid item and collapse
        // the whole layout into a single column.
        <Fragment key={label}>
          <dt className="kv__k">{label}</dt>
          <dd className="kv__v">{value ?? "—"}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
