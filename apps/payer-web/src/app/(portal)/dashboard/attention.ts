import { ACTION_ICON, type IconName } from "@badabhai/icons";
import type { Dashboard } from "../../../lib/contracts";

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
 */

export type AttentionTone = "critical" | "warning" | "info";

export interface AttentionItem {
  id: string;
  tone: AttentionTone;
  title: string;
  body: string;
  /** Omitted when the payer has no route to act — e.g. a Recruiter cannot reach /credits. */
  actionHref?: string;
  actionLabel?: string;
  /** The action's glyph (from ACTION_ICON) — a key action is icon + text. */
  actionIcon?: IconName;
}

/**
 * Below this many unlock credits the wallet is worth flagging BEFORE it blocks the loop.
 * A payer who discovers an empty wallet mid-shortlist has already lost the thread.
 */
export const LOW_BALANCE_THRESHOLD = 10;

export function buildAttentionItems(
  data: Dashboard,
  opts: { isAgency: boolean; isOwner: boolean },
): AttentionItem[] {
  const items: AttentionItem[] = [];

  // Billing is Owner-only, so a Recruiter is pointed at the fact, not at a door that 404s.
  // "Buy credits" — never "Top up", which also named adding applicant slots to a posting.
  const walletAction = opts.isOwner
    ? { actionHref: "/credits", actionLabel: "Buy credits", actionIcon: ACTION_ICON.credits }
    : {};

  // 1. The wallet — an empty one stops the core loop outright, so it outranks everything.
  if (data.credits.balance <= 0) {
    items.push({
      id: "credits-empty",
      tone: "critical",
      title: "You are out of unlock credits",
      body: opts.isOwner
        ? "Applicants stay masked until you buy credits. Existing unlocks are unaffected."
        : "Ask your account owner to buy credits — applicants stay masked until then.",
      ...walletAction,
    });
  } else if (data.credits.balance < LOW_BALANCE_THRESHOLD) {
    items.push({
      id: "credits-low",
      tone: "warning",
      title: `Only ${data.credits.balance} unlock ${data.credits.balance === 1 ? "credit" : "credits"} left`,
      body: opts.isOwner
        ? "Buy credits before you run out so shortlisting is never interrupted."
        : "Ask your account owner to buy credits before you run out.",
      ...walletAction,
    });
  }

  // 2. Access that has lapsed. `granted` is the live state; anything else is spent access the
  //    payer may not realise they no longer have.
  const expired = data.unlocks.filter((u) => u.status !== "granted").length;
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
  if (
    !opts.isAgency &&
    data.postings.length > 0 &&
    data.postings.every((p) => p.status !== "open")
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
