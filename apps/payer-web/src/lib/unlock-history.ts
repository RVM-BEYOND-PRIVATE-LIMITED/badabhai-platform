import type { PostingSummary, UnlockHistoryItem } from "./contracts";
import type { UnlockView } from "./unlock-view";

/**
 * PURE reads over the payer's OWN unlock history (`GET /payer/unlocks`, via getUnlocks) — no
 * I/O, no React. Its readers: the two applicant feeds — a company posting's and an agency job's —
 * (which rows are already unlocked) and the dashboard's Recent unlocks (dates, live/ended status,
 * and the company posting the unlock was made from).
 *
 * WHICH APPLICANT: an unlock is ONE grant per (payer, worker) — ADR-0010 sign-off resolution 1
 * and the `unlocks_payer_worker_uq` index — so a row is matched on `workerId` alone. The posting
 * context never picks an applicant row; only a Recent-unlocks row reads it, to name its posting.
 *
 * LIVE: the server derives `expired` (#2033) for a grant whose window had passed when IT read the
 * row, and that never reads live here. A row it still sent as granted can lapse before the page
 * renders, or under clock skew, so "live" also needs the window's end to be in the future at
 * `now`. This is a DISPLAY decision only — the server still decides every reveal and every
 * unlock: a grant shown live that has just lapsed reveals the neutral message, and an Unlock
 * pressed on a still-live grant never debits twice (F-6: once past the entry checks it returns
 * that same grant; a failed entry check is the one neutral answer, as for any unlock).
 */

export type GrantedUnlock = Extract<UnlockView, { kind: "granted" }>;

/**
 * `granted` (incl. revealed) AND its access window still open at `now`. Unparsable = not live.
 * `expired` (server-derived or stored) and revoked access are never live, whatever the window says.
 */
export function isLiveUnlock(
  unlock: Pick<UnlockHistoryItem, "status" | "expiresAt">,
  now: number,
): boolean {
  if (unlock.status !== "granted") return false;
  const end = Date.parse(unlock.expiresAt);
  return Number.isFinite(end) && end > now;
}

/**
 * The payer's LIVE grants for the applicants on ONE feed, keyed by worker id, as the feed's own
 * granted view. Only the feed's workers are returned, so the client gets no unlock id it can't
 * already see a row for.
 */
export function liveUnlocksFor(
  unlocks: readonly UnlockHistoryItem[],
  workerIds: readonly string[],
  now: number,
): Record<string, GrantedUnlock> {
  const onFeed = new Set(workerIds);
  const out: Record<string, GrantedUnlock> = {};
  for (const u of unlocks) {
    if (!onFeed.has(u.workerId) || !isLiveUnlock(u, now)) continue;
    // The unique index allows one row per worker; if two ever arrive, keep the later window.
    const held = out[u.workerId];
    if (held && Date.parse(held.expiresAt) >= Date.parse(u.expiresAt)) continue;
    out[u.workerId] = { kind: "granted", unlockId: u.unlockId, expiresAt: u.expiresAt };
  }
  return out;
}

/**
 * YYYY-MM-DD of an ISO timestamp (no time of day reaches the DOM); unparsable → as sent. The one
 * day formatter for unlock dates — the applicant feed's "Unlocked until" uses it too.
 */
export function isoDay(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().slice(0, 10);
}

/** The instant a row is "unlocked on": the current grant, else (no grant time) the record's. */
function unlockedAt(unlock: UnlockHistoryItem): string {
  return unlock.grantedAt ?? unlock.createdAt;
}

/**
 * The company postings a row may name: THIS payer's own list, exactly as the page read it. An
 * agency session reads none, and a failed read is none — the rows then name no posting.
 */
export type OwnPostings = ReadonlyArray<Pick<PostingSummary, "id" | "roleTitle">>;

/**
 * What one Recent-unlocks row says: when, whether access is still open, and — when the record's
 * posting is one of the payer's own — which posting. Faceless — no worker id is carried.
 */
export interface UnlockRow {
  key: string;
  live: boolean;
  /** The day the current grant was made (a re-grant after a lapse moves it). */
  unlockedOn: string;
  /** The day the access window ends (live) or ended (expired). */
  endsOn: string;
  /**
   * The company posting the unlock was made from — ONLY when its `jobPostingId` is in
   * `ownPostings`, so the title is the payer's own and its applicants page shows the unlock.
   * Null otherwise (no context, an agency unlock, or an id not in the list read), and the row is
   * not a link: an id the payer's own list does not hold is never resolved to a title.
   */
  posting: { id: string; title: string } | null;
}

export function unlockRow(
  unlock: UnlockHistoryItem,
  ownPostings: OwnPostings,
  now: number,
): UnlockRow {
  const id = unlock.jobPostingId;
  const own = id ? ownPostings.find((p) => p.id === id) : undefined;
  return {
    key: unlock.unlockId,
    live: isLiveUnlock(unlock, now),
    unlockedOn: isoDay(unlockedAt(unlock)),
    endsOn: isoDay(unlock.expiresAt),
    posting: own ? { id: own.id, title: own.roleTitle } : null,
  };
}

/**
 * The `limit` most recent unlocks, newest first BY THE DAY EACH ROW PRINTS ("Unlocked <day>").
 * The API lists by record creation, which a re-grant does not move, so its order and the printed
 * day could disagree. Ties (and unparsable times, which sink) keep the API's order.
 */
export function recentUnlockRows(
  unlocks: readonly UnlockHistoryItem[],
  ownPostings: OwnPostings,
  now: number,
  limit = 5,
): UnlockRow[] {
  const at = (u: UnlockHistoryItem) => {
    const t = Date.parse(unlockedAt(u));
    return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
  };
  return [...unlocks]
    .sort((a, b) => at(b) - at(a))
    .slice(0, limit)
    .map((u) => unlockRow(u, ownPostings, now));
}
