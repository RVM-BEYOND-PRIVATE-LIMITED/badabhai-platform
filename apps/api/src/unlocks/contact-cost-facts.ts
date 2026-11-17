import type { ContactCostFacts } from "@badabhai/pricing";
import {
  normalizeTradeLevelKey,
  priceTierForTradeSkill,
  type TradeLevel,
} from "@badabhai/taxonomy";
import type { ContactCostFactsRow } from "./unlocks.repository";
import { isOpenGrant } from "./open-grant";

/**
 * #2750 item 2 — the trades the brief prices by the TRADE, not by the rung: a 3D CAD designer or a
 * CAM programmer above trainee is a higher-priced worker once he has the experience (brief 4C.5;
 * #2750 "Defaults behind the questions for Akshit"), even on the rungs his trade sheet prices Lower
 * (the CAD sheet's `designer`, the CAM sheet's `junior_programmer`). A fresher in either trade is
 * still the standard cost: his rung is a trainee one, or his months are under the line.
 */
export const HIGHER_PRICED_TRADES: ReadonlySet<string> = new Set([
  "mskill_cad_designer_3d",
  "mskill_cam_programmer",
]);

/** The trainee rungs, which never price a trade up. */
const TRAINEE_RUNGS: ReadonlySet<TradeLevel> = new Set<TradeLevel>([
  "helper",
  "trainee",
  "trainee_modeller",
]);

/** Does this stated rung price Higher (the sheet's tier, or a higher-priced trade above trainee)? */
export function isHigherPricedRung(skillId: string, rawLevel: string): boolean {
  const level = normalizeTradeLevelKey(rawLevel);
  if (level === null) return false;
  if (HIGHER_PRICED_TRADES.has(skillId)) return !TRAINEE_RUNGS.has(level);
  return priceTierForTradeSkill(skillId, level) === "higher";
}

/**
 * The most months he has in a trade where his rung prices Higher, or null.
 *
 * Experience in that trade: `worker_skill.months_bucketed` for that trade when he has the row,
 * else his total years. Neither: null. NEVER PRICE UP ON MISSING DATA: null is the standard cost.
 */
export function higherRungMonthsOf(row: ContactCostFactsRow): number | null {
  let best: number | null = null;
  for (const rung of row.rungs) {
    if (!isHigherPricedRung(rung.skillId, rung.tradeLevel)) continue;
    const months =
      rung.months !== null
        ? rung.months
        : row.totalYears !== null
          ? Math.floor(row.totalYears * 12)
          : null;
    if (months !== null && (best === null || months > best)) best = months;
  }
  return best;
}

/**
 * The cost rule's input for one worker. `alreadyOpened` is read from the STORED grant only (open
 * now, or stored open for good), never from consent: the quote must not depend on anything the
 * card does not show. `waived` is the caller's read of the placement team's waivers (#2750 item 5:
 * he applied to a job of this company under an active job or company waiver); the cost rule frees
 * him only if he is also an RVM student. Managed Hiring (#2751) is not built yet: false.
 */
export function contactCostFactsOf(
  row: ContactCostFactsRow,
  opts: { readonly forOpen: boolean; readonly now?: Date; readonly waived?: boolean },
): ContactCostFacts {
  return {
    // The open itself prices a NEW grant; a held contact is answered inside its transaction before
    // any debit, so only the quote asks whether he is already opened.
    alreadyOpened:
      !opts.forOpen &&
      row.grant !== null &&
      isOpenGrant(row.grant, { openForGood: false, ...(opts.now ? { now: opts.now } : {}) }),
    managedHiringOrder: false,
    waived: opts.waived === true,
    rvmStudent: row.rvmStudent,
    higherRungMonths: higherRungMonthsOf(row),
  };
}
