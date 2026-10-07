import { ACTION_ICON, type IconName } from "@badabhai/icons";
import type { CreditBalance, PostingSummary, UnlockHistoryItem } from "../../../lib/contracts";
import { lowBalanceThreshold } from "../../../lib/pricing-config";

/**
 * "What needs me right now?" — derived from the payer's OWN dashboard read.
 *
 * A command centre earns its name by answering that question before it shows counters. This
 * module is the rule set, kept pure and separate from the page so each item is unit-testable
 * and so it is obvious that NOTHING here is invented: every item is a statement about a
 * field that is actually in the payload.
 *
 * The bar for adding an item: it must be (a) derivable from real data, (b) something the
 * payer can act on, and (c) worth interrupting them for. A dashboard that cries wolf gets
 * ignored, so an empty list is a perfectly good outcome and the section does not render.
 *
 * Each part is read on its own (F29), so a part whose read FAILED arrives as `null` — and says
 * nothing: an unknown balance is not an empty wallet, unread postings are not "all closed".
 */

/** What the dashboard read; `null` = that read failed (never a guess). */
export interface AttentionInput {
  credits: CreditBalance | null;
  unlocks: readonly UnlockHistoryItem[] | null;
  postings: readonly PostingSummary[] | null;
}

export type AttentionTone = "critical" | "warning" | "info";

export interface AttentionItem {
  id: string;
  tone: AttentionTone;
  title: string;
  body: string;
  /** Omitted when the item is information only — there is nothing on a page to go and do. */
  actionHref?: string;
  actionLabel?: string;
  /** The action's glyph (from ACTION_ICON) — a key action is icon + text. */
  actionIcon?: IconName;
}

export function buildAttentionItems(
  data: AttentionInput,
  opts: { isAgency: boolean },
): AttentionItem[] {
  const items: AttentionItem[] = [];

  // Every member can buy (owner ruling 2026-10-07), so the wallet items always carry the door —
  // there is no org-role input here at all. "Buy credits" — never "Top up", which also named
  // adding applicant slots to a posting.
  const walletAction = {
    actionHref: "/credits",
    actionLabel: "Buy credits",
    actionIcon: ACTION_ICON.credits,
  };

  // 1. The wallet — an empty one stops the core loop outright, so it outranks everything.
  //    (An unread balance says nothing: the shell's chip hides on the same failure.)
  //    "Low" is flagged BEFORE it blocks the loop (a payer who finds an empty wallet
  //    mid-shortlist has already lost the thread), from the ONE number /credits warns from: the
  //    pricing config's (N7 — the dashboard used to keep its own 10 against /credits' 5).
  const balance = data.credits?.balance ?? null;
  if (balance !== null && balance <= 0) {
    items.push({
      id: "credits-empty",
      tone: "critical",
      title: "You are out of unlock credits",
      body: "Applicants stay masked until you buy credits. Existing unlocks are unaffected.",
      ...walletAction,
    });
  } else if (balance !== null && balance < lowBalanceThreshold()) {
    items.push({
      id: "credits-low",
      tone: "warning",
      title: `Only ${balance} unlock ${balance === 1 ? "credit" : "credits"} left`,
      body: "Buy credits before you run out so shortlisting is never interrupted.",
      ...walletAction,
    });
  }

  // 2. Access that has lapsed. `granted` is the live state; anything else is spent access the
  //    payer may not realise they no longer have.
  const expired = (data.unlocks ?? []).filter((u) => u.status !== "granted").length;
  if (expired > 0) {
    items.push({
      id: "unlocks-expired",
      tone: "info",
      title: `${expired} unlocked ${expired === 1 ? "contact has" : "contacts have"} expired`,
      body: "Their contact details are no longer visible. Unlocking again costs a credit.",
    });
  }

  // 3. Nothing open. An employer whose postings are all closed is invisible to every matched
  //    worker — the quietest possible failure, and the one most worth surfacing.
  //    Zero postings is NOT an item: the dashboard's "Your postings" panel says "No postings
  //    yet" right there, and one page should say it once.
  //    Agents are excluded: their postings live in a different entity (agency `jobs`) that this
  //    payload does not describe (see the dashboard page's data-coherence note), so a count of 0
  //    here would be a statement about the wrong data set.
  const postings = data.postings;
  if (
    !opts.isAgency &&
    postings !== null &&
    postings.length > 0 &&
    postings.every((p) => p.status !== "open")
  ) {
    items.push({
      id: "no-open-postings",
      tone: "warning",
      title: "No open postings",
      body: "Every posting is closed, so no new applicants can arrive.",
      actionHref: "/postings/new",
      actionLabel: "New posting",
      actionIcon: ACTION_ICON.create,
    });
  }

  return items;
}
