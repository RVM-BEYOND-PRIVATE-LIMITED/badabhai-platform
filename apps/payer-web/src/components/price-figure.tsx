import type { ReactElement } from "react";
import { formatInr } from "../lib/format";
import type { ChargedPrice } from "../lib/pricing-config";

/**
 * A tile's price figure (#2085): the price a purchase is charged, and — only when an active
 * offer lowers it — the catalog list price struck through before it, then WHEN that offer ends
 * (#2102). The struck figure is muted and smaller (`.price-was`, tokens only); a screen reader
 * hears "was ₹X, now ₹Y, offer ends <day>" rather than bare numbers and a loose date.
 *
 * A plain function, not a component, so a caller's tree carries the text directly. It sits
 * INSIDE the tile's mono price container, so it adds no `bb-mono` of its own. Triggers and
 * confirms do not use it: they show the one number the purchase sends back.
 */
export function priceFigure({ priceInr, listPriceInr, offerEndsAt }: ChargedPrice): ReactElement {
  if (listPriceInr === undefined || listPriceInr <= priceInr) return <>{formatInr(priceInr)}</>;
  return (
    <>
      <span className="sr-only">Offer: was </span>
      <s className="price-was">{formatInr(listPriceInr)}</s>
      <span className="sr-only">, now</span> {formatInr(priceInr)}
      {/* The deadline only exists when the catalog NAMED the offer (chargedPrice) — an unnamed
          discount strikes the list price and says nothing, never a guessed date. */}
      {offerEndsAt === undefined ? null : (
        <span className="price-offer">
          <span className="sr-only">, </span>offer ends {offerDay(offerEndsAt)}
        </span>
      )}
    </>
  );
}

/**
 * YYYY-MM-DD of the offer's end; unparsable → as sent. The house day formatter — no time of day
 * reaches the DOM, and a tile's mono price container already renders it tabular.
 */
function offerDay(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().slice(0, 10);
}
