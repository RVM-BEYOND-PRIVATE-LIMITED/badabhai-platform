import type { TradeLevelBadgeWire } from "./contracts";

/**
 * The ONE rung a faceless card prints (Middle Way P5) — display only, never a rank input. Shared
 * by the applicant card (postings/[id]/applicants/applicant-actions.tsx) and the all-candidates
 * card (candidates/candidate-search-list.tsx), so both pick it the same way.
 *
 * `levels` carries every trade the worker stated a rung for. The card shows the rung for the
 * trade IT is showing, not all of them: `shown` names that trade — by skill id when the card has
 * one (a search row's `role`), else by label (the applicant card: the skill the posting matched him
 * on, or the legacy card's trade). One rung is that rung. With several and none on the shown
 * trade, print none — a rung for a different trade would misstate him. An absent or empty list
 * is no badge, never a placeholder.
 */
export function shownTradeLevel(
  levels: readonly TradeLevelBadgeWire[] | undefined,
  shown: { skillId?: string; skillLabel?: string },
): TradeLevelBadgeWire | null {
  if (levels === undefined || levels.length === 0) return null;
  if (levels.length === 1) return levels[0]!;
  if (shown.skillId !== undefined) {
    const byId = levels.find((level) => level.skillId === shown.skillId);
    if (byId) return byId;
  }
  if (shown.skillLabel === undefined) return null;
  return levels.find((level) => level.skillLabel === shown.skillLabel) ?? null;
}
