/**
 * The companion's chip keys and labels (ADR-0044). IMPORT-FREE, on purpose.
 *
 * WHY A FILE OF ITS OWN. The worker app routes a tapped chip on its `option_key`, never on the
 * copy, and a Dart parity test reads THIS file with a regex to prove the two halves agree —
 * exactly as `chat_resume_menu_test.dart` reads `../chat/resume-menu.ts`. That older test also
 * pins resume-menu.ts to EXACTLY four `RESUME_MENU_*_KEY` constants and six `key:` literals, so
 * none of these could have been added there without breaking it.
 *
 * WHICH SIDE HANDLES WHICH KEY.
 *   - `companion_job:<uuid>`, `companion_jobs_tab`, `companion_applied` are routed by the APP
 *     (job detail / the Jobs tab / the applied list) and are never posted.
 *   - `companion_new_jobs` and `companion_resume` are answered by the SERVER: the app posts the
 *     chip's LABEL as ordinary text, the chat's shipped convention, so every label below must be
 *     recognisable by `resolveCompanionText` on its own.
 *
 * NO COLLISIONS. The `companion_` prefix is new. It cannot collide with the résumé menu's
 * `resume_*` / `section_*` keys, the ADR-0043 offer's `update_offer_*`, the model chips' `llm_*`
 * or the escape's `kuch_aur` — each of which triggers something different on a shipped client.
 */

/** Server-answered: "which new jobs match me" — the jobs reply with up to three job chips. */
export const COMPANION_NEW_JOBS_KEY = "companion_new_jobs";
export const COMPANION_NEW_JOBS_LABEL = "Naye jobs dekhein";

/** App-routed: switch to the Jobs tab. */
export const COMPANION_JOBS_TAB_KEY = "companion_jobs_tab";
export const COMPANION_JOBS_TAB_LABEL = "Sabhi jobs dekhein";

/** App-routed: open the worker's applied-jobs list. */
export const COMPANION_APPLIED_KEY = "companion_applied";
export const COMPANION_APPLIED_LABEL = "Apni applications dekhein";

/**
 * Server-answered: the EXISTING post-completion résumé menu (edit / redo), served verbatim, so
 * upload, edit, redo and "chat se resume banayein" stay one tap away and behave exactly as today.
 */
export const COMPANION_RESUME_KEY = "companion_resume";
export const COMPANION_RESUME_LABEL = "Resume badlein";

/**
 * App-routed: open ONE job's detail screen. The key is this prefix plus the posting id; the label
 * is the title, then {@link COMPANION_JOB_LABEL_SEPARATOR}, then the city when there is one — the
 * app splits it back to pre-fill the detail header.
 *
 * Named `…_KEY_PREFIX`, not `…_KEY`, so the Dart parity regex over `*_KEY = "…"` does not mistake
 * it for a fixed key; the parity test asserts it with a regex of its own.
 */
export const COMPANION_JOB_KEY_PREFIX = "companion_job:";
export const COMPANION_JOB_LABEL_SEPARATOR = " — ";

/** The longest job title a chip carries before it is cut, so a vertical option row stays one line. */
export const COMPANION_JOB_TITLE_MAX = 40;

export function companionJobKey(jobPostingId: string): string {
  return `${COMPANION_JOB_KEY_PREFIX}${jobPostingId}`;
}

/** Every fixed key, for the collision test. */
export const COMPANION_FIXED_KEYS = [
  COMPANION_NEW_JOBS_KEY,
  COMPANION_JOBS_TAB_KEY,
  COMPANION_APPLIED_KEY,
  COMPANION_RESUME_KEY,
] as const;
