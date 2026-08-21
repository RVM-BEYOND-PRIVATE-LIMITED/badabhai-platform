import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";
import { qs } from "./entities";

/**
 * The worker-feedback data layer (#997) — the portal's read seam onto `GET /admin/feedback`.
 *
 * ── THE ONE FIELD ON THIS SURFACE THAT IS NOT FACELESS ──────────────────────────────────
 * `lib/entities.ts` states the rule every other read in this folder keeps: no name, no email,
 * no phone, because the server sends none. This module is the sanctioned exception, and only
 * this far. `message` is the worker's OWN words, typed deliberately into the app's Feedback
 * button and addressed to us, so it may contain personal details they chose to include. The
 * portal does not redact it — the server ruled that admins may read it, and masking a payload
 * that is already on the wire would be theatre — and equally does not widen it:
 *
 *   * a worker stays the opaque id every other screen shows. Nothing here resolves a name or
 *     a phone number, and the single sanctioned identity egress remains the reason-gated,
 *     audited reveal on the worker detail screen.
 *   * there is deliberately NO search-by-content filter. The route does not offer one and
 *     this module must never grow a client-side equivalent: a substring search over worker
 *     free text is a PII discovery tool wearing a convenience feature's costume. The
 *     `workerId` filter is not a softening of that — see {@link FeedbackFilters}, which
 *     records why a lookup on an id the operator already holds is the opposite shape.
 */

/**
 * The worker's optional tag on their own message.
 *
 * Mirrors `WORKER_FEEDBACK_CATEGORIES` in `@badabhai/types` — restated rather than imported,
 * exactly as `ADMIN_TIMELINE_SUBJECT_TYPES` mirrors its server counterpart above: the portal
 * takes no workspace dependency on the API's packages, so every server vocabulary it pins is
 * pinned by hand and says so.
 *
 * A closed enum, not a free string. An unknown tag must surface as an honest error state
 * rather than render as an unstyled word in a pill — the same ruling `payerListItemSchema`
 * makes about an unknown role. Three tokens are frozen in a SHIPPED app; a fourth arriving
 * is a server change nobody told the portal about, which is worth failing over.
 */
export const FEEDBACK_CATEGORIES = ["suggestion", "problem", "other"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const feedbackItemSchema = z.object({
  id: z.string(),
  worker_id: z.string(),
  /**
   * Null means the worker did not tag their message. It is NOT "other": the app omits the
   * field entirely when they skip the tag, and folding the two together would put a lie in
   * any count made off this screen.
   */
  category: z.enum(FEEDBACK_CATEGORIES).nullable(),
  /** The worker's own words — the sanctioned exception described in the header. */
  message: z.string(),
  /** The `x-app-build` stamp, or null when it was absent or malformed at submit time. */
  app_build: z.string().nullable(),
  /**
   * WHICH SCREEN of the worker app the report is about — `/jobs/detail/:id`, never a concrete
   * path. The server matches the client's value against the app's finite route table and
   * stores one of its OWN constants, so this field can say "the job detail screen" and
   * cannot say WHICH job the worker was looking at. That is why it is allowed on a surface
   * where a name is not, and the portal must never treat it as a link or a lookup key.
   *
   * Null is a real answer with three causes that are indistinguishable from here — an app
   * build older than the field, a client that sent nothing, and a value that matched no
   * screen. All three mean "we do not know which screen", and the page renders them
   * identically as such rather than guessing between them.
   *
   * DELIBERATELY A BARE `string`, NOT THE SERVER'S UNION. The portal's job is to render what
   * arrived, not to re-adjudicate a closed set the writer already enforced — and pinning the
   * enum here would mean an app that gained a screen throws `AdminRequestError` and blanks
   * the WHOLE page until admin-web is redeployed. A value the server vouched for is safe to
   * display; refusing to display it is the only way this schema could make things worse.
   */
  screen_context: z.string().nullable(),
  created_at: z.string(),
});
export type FeedbackItem = z.infer<typeof feedbackItemSchema>;

/**
 * The list envelope. `{ items, nextCursor }` — the entity convention, NOT the `{ events, … }`
 * one `lib/events.ts` uses; `nextCursor: null` means this was the last page.
 *
 * Declared here rather than imported because `pageOf` is private to `lib/entities.ts`, and
 * exporting a one-line combinator across two modules to save one line is not worth widening
 * that module's surface for.
 */
export const feedbackPageSchema = z.object({
  items: z.array(feedbackItemSchema),
  nextCursor: z.string().nullable(),
});
export type FeedbackPage = z.infer<typeof feedbackPageSchema>;

/** Filters the list route accepts. Mirrors `AdminFeedbackQuerySchema` on the server. */
export interface FeedbackFilters {
  /**
   * A raw query-string value, deliberately NOT narrowed to {@link FeedbackCategory} here.
   *
   * A hand-edited `?category=spam` is forwarded and 400s, and the page renders that refusal.
   * Silently dropping it instead would show the WHOLE list under a URL that claims a filter
   * — a wrong answer wearing a right one's clothes, which is the exact failure the server's
   * `.strict()` schema exists to prevent.
   */
  category?: string;
  /**
   * ONE worker's reports. A raw string for the same reason `category` is one: the server's
   * schema is `.uuid()`, so a hand-edited `?workerId=nope` must travel and earn a 400 that
   * this page renders as a refusal. Narrowing it here would drop it instead, and show the
   * WHOLE list under a URL claiming to show one worker's — the same wrong answer wearing a
   * right one's clothes.
   *
   * ── AND IT IS NOT THE SEARCH THIS MODULE REFUSES ──────────────────────────────────────
   * A substring search over `message` is a DISCOVERY tool: content in, a set of people out.
   * This is a LOOKUP: an id the operator already holds, from a surface they were already
   * allowed to read, narrowing a page they could reach by scrolling. It selects rows, it
   * discovers nobody, and it is why the refusal above stays exactly as absolute as it was.
   */
  workerId?: string;
  cursor?: string;
  limit?: number;
}

export function listFeedback(f: FeedbackFilters = {}): Promise<FeedbackPage> {
  return adminFetch(`/admin/feedback${qs(f)}`, { schema: feedbackPageSchema });
}
