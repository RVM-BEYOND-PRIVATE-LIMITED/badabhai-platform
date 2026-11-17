import { revenuePackMetricId } from "../definitions";
import { sumByCell, valueCells, type NumbersMetricCells } from "./cells";
import {
  byWeekEnd,
  inWeek,
  type NumbersDimsLookup,
  type NumbersPaidOrderRow,
  type NumbersWeekWindow,
} from "./types";

/** Paise in a rupee: `payment_orders.amount_inr` is whole rupees, the screen's money is paise. */
export const PAISE_PER_RUPEE = 100;

/**
 * #2755 metric group 9 — REVENUE BY PACK, as charged, in paise (`revenue_by_pack`), the rule of
 * `definitions.ts`: the sum of `amount_inr × 100` over the paid orders of countable companies
 * settled in the week, stored as the all-packs total under `revenue_by_pack` and once per pack
 * under `revenue_by_pack:<pack_code>`.
 *
 * WHICH PACKS GET A ROW: every pack paid for by the week's end, so a pack that sold before shows a
 * real zero in a week it did not sell, and a pack that has never sold has no row (the screen
 * cannot tell a pack that does not exist yet from one nobody bought, so it is not drawn).
 *
 * NOT THE GST SPLIT: `payment_orders` carries no taxable / GST columns until #2749 part 3 (#2872),
 * so `revenue_gst_split` stays `not_available` and this is the amount as charged.
 */
export function revenueByPack(
  window: NumbersWeekWindow,
  orders: readonly NumbersPaidOrderRow[],
  companyDims: NumbersDimsLookup,
): NumbersMetricCells[] {
  const dims = (o: NumbersPaidOrderRow) => companyDims(o.payerId);
  const paise = (o: NumbersPaidOrderRow) => o.amountInr * PAISE_PER_RUPEE;
  const inThisWeek = orders.filter((o) => inWeek(o.settledAt, window));
  const packs = [
    ...new Set(
      orders
        .filter((o) => byWeekEnd(o.settledAt, window))
        .map((o) => revenuePackMetricId(o.packCode)),
    ),
  ].sort();
  return [
    valueCells("revenue_by_pack", sumByCell(inThisWeek, dims, paise)),
    ...packs.map((metric) =>
      valueCells(
        metric,
        sumByCell(
          inThisWeek.filter((o) => revenuePackMetricId(o.packCode) === metric),
          dims,
          paise,
        ),
      ),
    ),
  ];
}
