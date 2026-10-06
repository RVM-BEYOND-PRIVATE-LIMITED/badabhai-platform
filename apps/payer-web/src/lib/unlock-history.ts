import type { UnlockHistoryItem } from "./contracts";
import type { UnlockView } from "./unlock-view";

/**
 * PURE reads over the payer's OWN unlock history (`GET /payer/unlocks`, via getUnlocks) — no
 * I/O, no React. Its readers: the two applicant feeds — a company posting's and an agency job's —
 * (which rows are already unlocked) and the dashboard's Recent unlocks (dates + live/ended status).
 *
 * WHICH APPLICANT: an unlock is ONE grant per (payer, worker) — ADR-0010 sign-off resolution 1
 * and the `unlocks_payer_worker_uq` index — so a row is matched on `workerId` alone. Nothing here
 * reads the record's job context.
 *
 * LIVE: the projection's `status` is the stored one, and nothing moves a lapsed grant to
 * `expired` (the backend checks the window at use time), so "live" also needs the window's end
 * to be in the future. This is a DISPLAY decision only — the server still decides every reveal
 * and every unlock: a grant shown live that has just lapsed reveals the neutral message, and an
 * Unlock pressed on a still-live grant never debits twice (F-6: once past the entry checks it
 * returns that same grant; a failed entry check is the one neutral answer, as for any unlock).
 */

export type GrantedUnlock = Extract<UnlockView, { kind: "granted" }>;

/** `granted` (incl. revealed) AND its access window still open at `now`. Unparsable = not live. */
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
 * What one Recent-unlocks row says: when, and whether access is still open. Faceless — no worker
 * id is carried. It names no posting: a company unlock is stored with no posting context today,
 * and an agency's job titles are not read by the page that renders the rows (see dashboard).
 */
export interface UnlockRow {
  key: string;
  live: boolean;
  /** The day the current grant was made (a re-grant after a lapse moves it). */
  unlockedOn: string;
  /** The day the access window ends (live) or ended (expired). */
  endsOn: string;
}

export function unlockRow(unlock: UnlockHistoryItem, now: number): UnlockRow {
  return {
    key: unlock.unlockId,
    live: isLiveUnlock(unlock, now),
    unlockedOn: isoDay(unlockedAt(unlock)),
    endsOn: isoDay(unlock.expiresAt),
  };
}

/**
 * The `limit` most recent unlocks, newest first BY THE DAY EACH ROW PRINTS ("Unlocked <day>").
 * The API lists by record creation, which a re-grant does not move, so its order and the printed
 * day could disagree. Ties (and unparsable times, which sink) keep the API's order.
 */
export function recentUnlockRows(
  unlocks: readonly UnlockHistoryItem[],
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
    .map((u) => unlockRow(u, now));
}
