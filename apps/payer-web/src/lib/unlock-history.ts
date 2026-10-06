import type { PostingSummary, UnlockHistoryItem } from "./contracts";
import type { UnlockView } from "./unlock-view";

/**
 * PURE reads over the payer's OWN unlock history (`GET /payer/unlocks`, via getUnlocks) — no
 * I/O, no React. Two screens use it: the applicant feed (which rows are already unlocked) and
 * the dashboard's Recent unlocks.
 *
 * WHICH APPLICANT: an unlock is ONE grant per (payer, worker) — ADR-0010 sign-off resolution 1
 * and the `unlocks_payer_worker_uq` index — so a row is matched on `workerId` alone. The job id
 * on the record is optional context and is never used to pick a row.
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

/** YYYY-MM-DD of an ISO timestamp (no time of day reaches the DOM); unparsable → as sent. */
export function isoDay(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().slice(0, 10);
}

/** What one Recent-unlocks row says. Faceless: no worker id is carried. */
export interface UnlockRow {
  key: string;
  live: boolean;
  /** The day the current grant was made. */
  unlockedOn: string;
  /** The day the access window ends (live) or ended (expired). */
  endsOn: string;
  /**
   * The posting the unlock was made from — ONLY when its stored context is one of this payer's
   * own company postings (so it has a title and an applicants page that shows the unlock). Null
   * otherwise, and the row is not a link.
   */
  posting: { id: string; title: string } | null;
}

export function unlockRow(
  unlock: UnlockHistoryItem,
  postings: ReadonlyArray<Pick<PostingSummary, "id" | "roleTitle">>,
  now: number,
): UnlockRow {
  const posting = unlock.jobId ? postings.find((p) => p.id === unlock.jobId) : undefined;
  return {
    key: unlock.unlockId,
    live: isLiveUnlock(unlock, now),
    unlockedOn: isoDay(unlock.grantedAt ?? unlock.createdAt),
    endsOn: isoDay(unlock.expiresAt),
    posting: posting ? { id: posting.id, title: posting.roleTitle } : null,
  };
}
