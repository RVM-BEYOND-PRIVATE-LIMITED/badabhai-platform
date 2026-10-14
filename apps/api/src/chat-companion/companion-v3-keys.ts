/**
 * The Bada Bhai chat's v3 chip keys (ADR-0055, #2275) — the free-chat brain's two new chips.
 * IMPORT-FREE, on purpose, like `companion-keys.ts` and `companion-task-keys.ts`.
 *
 * WHY A FILE OF ITS OWN, AND NOT MORE CONSTANTS IN THE PINNED FILES. The worker app's parity tests
 * read two server files VERBATIM and pin their key sets exactly:
 *   - `chat_companion_keys_test.dart` reads `companion-keys.ts` and expects EXACTLY the four
 *     `COMPANION_*_KEY` constants the shipped app routes on;
 *   - `chat_resume_menu_test.dart` reads `../chat/resume-menu.ts` and expects EXACTLY the four
 *     `RESUME_MENU_*_KEY` constants (and six `key:` literals).
 * A fifth constant in either would redden the worker-app suite before the app build that knows it
 * exists — a backend PR breaking another team's CI, the reason `companion-task-keys.ts` is its own
 * file too. The app follow-up (Rishi) mirrors these two keys and points its parity tests here.
 *
 * WHICH SIDE HANDLES WHICH KEY.
 *   - `companion_resume_download` is APP-ROUTED: the app saves the current résumé PDF (its existing
 *     in-chat download tile). An app that predates the key posts the label as text, which it
 *     already answers on the phone (`isResumeDownloadRequest` matches "download").
 *   - `resume_form_create` is a RÉSUMÉ-MENU option, routed by the app to the trade form once it
 *     knows the key. Until then the app posts the label as text and the server answers
 *     {@link RESUME_MENU_FORM_ACK}, exactly as the menu answers its upload and chat labels.
 *
 * DIGIT-FREE AND COLLISION-FREE. Neither key carries a digit, and neither equals or shares a prefix
 * with a key a shipped client routes on (`section_*`, `update_offer_*`, `llm_*`, `kuch_aur`, the four
 * menu keys, the four companion keys, `companion_job:`, `companion_task:`) — pinned by the test.
 */

/** App-routed: save the worker's current résumé PDF. Offered only when one is rendered. */
export const COMPANION_RESUME_DOWNLOAD_KEY = "companion_resume_download";
export const COMPANION_RESUME_DOWNLOAD_LABEL = "Resume download karein";

/** The redo submenu's form road: make a new résumé by filling the form. */
export const RESUME_MENU_FORM_CREATE_KEY = "resume_form_create";
export const RESUME_MENU_FORM_CREATE_LABEL = "Form se resume banayein";

/** Served when the form option's LABEL is posted back as text (an app that predates the key). */
export const RESUME_MENU_FORM_ACK =
  "Theek hai. Form kholkar apni jaankari bhariye. Form poora hote hi naya resume ban jayega.";

/** Every v3 key, for the collision test. */
export const COMPANION_V3_KEYS = [
  COMPANION_RESUME_DOWNLOAD_KEY,
  RESUME_MENU_FORM_CREATE_KEY,
] as const;
