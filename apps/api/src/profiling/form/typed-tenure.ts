/**
 * Token-audit fix Q10 (decision D9) — years read out of a TYPED answer to the form's tenure
 * question. MOVED, UNCHANGED, to `@badabhai/db` (`packages/db/src/typed-tenure.ts`) for #2753 item 2:
 * with `FORM_TENURE_MONTHS_ENABLED` on, the same reading feeds `worker_skill.months_bucketed`, and
 * `db:backfill:worker-skills` (which cannot import `apps/api`) must read a typed answer exactly as the
 * live rebuild does. This re-export keeps the form's import, and its tests, where they were.
 */
export { typedTenureYears } from "@badabhai/db";
