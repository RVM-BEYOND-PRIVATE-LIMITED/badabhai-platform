/**
 * ONE neutral message for every way an accept link can fail to work.
 *
 * The API deliberately FUSES invalid, expired and already-used into a single 401 — a page
 * that distinguished them would hand back the probe oracle the backend just removed: an
 * attacker could walk a list of links and learn which ones exist, which are spent, and
 * therefore which admins were recently invited.
 *
 * So a typo'd token, a 49-hour-old link, a link someone already redeemed, and a link for
 * an admin who has since been suspended all read the same here. Constants rather than
 * strings built at the call site, for the reason `login/messages.ts` gives: a future catch
 * block cannot accidentally invent a more "helpful" one.
 */

/** 401 — invalid OR expired OR already used. Never says which. */
export const NEUTRAL_ACCEPT_ERROR =
  "This invite link isn't valid any more. Ask whoever invited you to send a fresh one.";

/** 400 — the token is the wrong shape, so the link was mangled in transit. */
export const MALFORMED_LINK_ERROR =
  "This link looks incomplete. Copy the whole link from your invite and open it again.";

/** No `?token=` at all — usually someone opening the bare path. */
export const MISSING_TOKEN_ERROR =
  "This page needs the invite link you were sent. Open that link directly.";

/** The API itself is unreachable — honest, because it reveals nothing. */
export const SERVICE_UNAVAILABLE_ERROR =
  "The admin service is unreachable. Try again shortly, or contact platform support.";
