"use server";

import type { PostingTradeDetailWire } from "../../../lib/contracts";
import { getPostingTradeForm } from "../../../lib/payer-api";
import type { PostingTradesProblem } from "../../../lib/posting-trades";
import { postingTradesProblemOf } from "../../../lib/posting-trades.server";

export type LoadPostingTradeFormResult =
  | { ok: true; trade: PostingTradeDetailWire }
  | { ok: false; problem: PostingTradesProblem };

/** #3020 — load ONE trade's form through the server seam, so the Bearer never reaches the browser. */
export async function loadPostingTradeFormAction(
  roleKind: string,
): Promise<LoadPostingTradeFormResult> {
  try {
    const trade = await getPostingTradeForm(roleKind);
    return { ok: true, trade };
  } catch (e) {
    return { ok: false, problem: postingTradesProblemOf(e) };
  }
}
