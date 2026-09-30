import type { ReactNode } from "react";

/**
 * One headline figure in a `.stats` grid.
 *
 * Extracted from the dashboard page when the AI-spend and volume sections needed the same
 * tile: three copies of a five-line component is how two of them quietly stop matching. The
 * markup and class names are unchanged from the shipped original. The console's stat tiles
 * render through here rather than hand-rolling the same three spans — except the three in
 * `stuck-panel.tsx`, whose values are set in the mono face, which this component does not offer.
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
 *
 * `adornment` is a marker that must travel WITH the figure — today only `MockMoneyTag`, the
 * "simulated" pill on a mock-rupee tile. It is set inside the value span, after a space, so a
 * screenshot of the tile alone still carries the caveat (the reason the tag exists at all). It
 * is a slot beside the figure, not a second value: the figure itself stays a string.
 *
 * `wide` is for a figure that must never break mid-number — a ₹ amount. At every width its
 * value stays on one line at the 22px KPI step (the 30px step is too long for a desktop tile);
 * on a phone, where the grid is 2-up and a half-width tile is narrower than "₹2,145.382716" or
 * "₹1,23,45,678", the tile also takes the whole row. Split between digits, a figure reads as
 * two numbers.
 */
export function Stat({
  label,
  value,
  tone,
  absent,
  adornment,
  wide,
}: {
  label: string;
  value: string;
  tone?: "warn";
  absent?: boolean;
  adornment?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`stat${tone ? ` stat--${tone}` : ""}${wide ? " stat--wide" : ""}`}>
      <span className={`stat__value${absent ? " stat__value--absent" : ""}`}>
        {value}
        {adornment === undefined ? null : <> {adornment}</>}
      </span>
      <span className="stat__label">{label}</span>
    </div>
  );
}
