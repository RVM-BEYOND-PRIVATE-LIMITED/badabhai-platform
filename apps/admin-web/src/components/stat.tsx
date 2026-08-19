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
 */
export function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warn";
}) {
  return (
    <div className={`stat${tone ? ` stat--${tone}` : ""}`}>
      <span className="stat__value">{value}</span>
      <span className="stat__label">{label}</span>
    </div>
  );
}
