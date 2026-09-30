/**
 * The companion v2 TASK CHIPS (ADR-0046 §5.3) — the keys and labels the router offers when it
 * cannot act, so a worker is never left without a next step.
 *
 * WHY THIS IS A FILE OF ITS OWN, AND NOT MORE CONSTANTS IN `companion-keys.ts`. That file is
 * read VERBATIM by the worker app's parity test (`chat_companion_keys_test.dart`), which pins the
 * server's key set to exactly the four keys the shipped app routes on. Adding task chips there
 * would redden the worker-app suite before the app build that knows them exists — a backend PR
 * breaking another team's CI. The app's parity test gains these keys when F5 mirrors them
 * (tracked by the Frontend issue raised with this phase); until then this file is the server's
 * half of the contract and nothing on a shipped client reads it.
 *
 * WHICH SIDE HANDLES WHICH KEY. Task chips are POSTED: the app sends the chip's LABEL as ordinary
 * text (the chat's shipped convention), and the classifier routes it like any other message. So
 * every label must be recognisable to the classifier — which the A4 eval set covers.
 *
 * THE JOBS CHIP IS NOT HERE. v1 already ships `companion_new_jobs` / "Naye jobs dekhein"
 * (`companion-keys.ts`), and the router offers that same chip for jobs questions (contracts §5.3
 * marks the jobs row "v1's existing jobs chip"). A second jobs key would be two chips for one
 * destination.
 *
 * NO COLLISIONS. `companion_task:` is a new prefix, disjoint from the v1 keys' `companion_` +
 * suffix namespace and from every résumé-menu / offer / model chip a shipped client routes on.
 */

/** Server-answered: "change something on my résumé/profile" — the P1 edit path. */
export const COMPANION_TASK_EDIT_RESUME_KEY = "companion_task:edit_resume";
export const COMPANION_TASK_EDIT_RESUME_LABEL = "Resume badlo";

/** Server-answered: "build me a new résumé" — P2 (phase off in P1: the chip is not shown). */
export const COMPANION_TASK_NEW_RESUME_KEY = "companion_task:new_resume";
export const COMPANION_TASK_NEW_RESUME_LABEL = "Naya resume";

/** Server-answered: career advice — P3 (phase off in P1: the chip is not shown). */
export const COMPANION_TASK_CAREER_KEY = "companion_task:career_talk";
export const COMPANION_TASK_CAREER_LABEL = "Career ki baat";

/** Every task key, for the collision test. */
export const COMPANION_TASK_KEYS = [
  COMPANION_TASK_EDIT_RESUME_KEY,
  COMPANION_TASK_NEW_RESUME_KEY,
  COMPANION_TASK_CAREER_KEY,
] as const;
