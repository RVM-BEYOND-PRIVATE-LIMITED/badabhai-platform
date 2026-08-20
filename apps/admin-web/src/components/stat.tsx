/**
 * One headline figure in a `.stats` grid.
 *
 * Extracted from the dashboard page when the AI-spend and volume sections needed the same
 * tile: three copies of a five-line component is how two of them quietly stop matching. The
 * markup and class names are unchanged from the shipped original.
 *
 * `value` is a STRING, always pre-formatted by the caller. That is deliberate — money on this
 * console arrives as an exact decimal string and must not be coerced to a number on its way to
 * a tile, and a component that accepted `number` would invite exactly that.
 *
 * `absent` marks a tile whose value is a STATEMENT rather than a measurement — "No profile
 * finished yet" where a ₹ figure would otherwise sit. It exists because the two must not look
 * alike: a sentence set in the KPI face reads as a number that happens to be words, and the
 * whole reason such a tile is rendered at all is that printing a confident 0 in its place would
 * be a claim nobody measured. Same signal `.funnel__distinct.is-suppressed` already carries on
 * the funnel rows, moved onto a tile.
 */
export function Stat({
  label,
  value,
  tone,
  absent,
}: {
  label: string;
  value: string;
  tone?: "warn";
  absent?: boolean;
}) {
  return (
    <div className={`stat${tone ? ` stat--${tone}` : ""}`}>
      <span className={`stat__value${absent ? " stat__value--absent" : ""}`}>{value}</span>
      <span className="stat__label">{label}</span>
    </div>
  );
}
