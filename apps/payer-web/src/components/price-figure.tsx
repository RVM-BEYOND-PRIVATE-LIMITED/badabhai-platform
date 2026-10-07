import type { ReactElement } from "react";
import { formatInr } from "../lib/format";
import type { ChargedPrice } from "../lib/pricing-config";

/**
 * A tile's price figure (#2085): the price a purchase is charged, and — only when an active
 * offer lowers it — the catalog list price struck through before it. The struck figure is
 * muted and smaller (`.price-was`, tokens only); a screen reader hears "was ₹X, now ₹Y" rather
 * than two bare numbers.
 *
 * A plain function, not a component, so a caller's tree carries the text directly. It sits
 * INSIDE the tile's mono price container, so it adds no `bb-mono` of its own. Triggers and
 * confirms do not use it: they show the one number the purchase sends back.
 */
export function priceFigure({ priceInr, listPriceInr }: ChargedPrice): ReactElement {
  if (listPriceInr === undefined || listPriceInr <= priceInr) return <>{formatInr(priceInr)}</>;
  return (
    <>
      <span className="sr-only">Offer: was </span>
      <s className="price-was">{formatInr(listPriceInr)}</s>
      <span className="sr-only">, now</span> {formatInr(priceInr)}
    </>
  );
}
