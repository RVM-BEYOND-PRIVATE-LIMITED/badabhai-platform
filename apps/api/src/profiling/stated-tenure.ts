/**
 * #2384 — how a worker answers "Is kaam mein aapko kitne saal ho gaye?" without saying "saal".
 *
 * MOVED, UNCHANGED, to `@badabhai/db` (`packages/db/src/stated-tenure.ts`) for #2753 item 2: it is
 * half of the trade form's typed-tenure reader, which both writers of `worker_skill` now call, and
 * `db:backfill:worker-skills` cannot import `apps/api`. Read the moved file for the rules (on-screen
 * only, the closed fresher list). This re-export keeps the chat's imports, and their tests, where
 * they were.
 */
export { bareNumberSpan, isLoneDigit, readStatedTenureYears } from "@badabhai/db";
