import { sql, type SQL } from "drizzle-orm";
import { generatedResumes } from "@badabhai/db";

/**
 * THE ONE DEFINITION OF "NEWEST RÉSUMÉ FIRST" (ADR-0043).
 *
 * Every reader that asks "which résumé is this worker's current one" — the Resume tab, the profile
 * bundle, the re-render enqueuers, employer disclosure — and the history list itself order by this
 * and nothing else. Two readers used to answer it differently: `latestResume` sorted by `version`
 * and the disclosure read by `generated_at`. `version` is not a history ordinal — a new profile's
 * first résumé is its own v1 — so the version sort let an older profile's v2 hide a newer
 * profile's résumé, and the worker saw a résumé built from an interview they had since redone.
 *
 * `id` IS THE TIE-BREAK, so two generations stamped in the same instant still have one answer
 * rather than whichever row the planner happened to read first.
 *
 * `desc nulls last`, SPELLED OUT, NOT `desc()`. The backing index
 * (`generated_resumes_worker_generated_idx`, migration 0125) is built DESC NULLS LAST, and
 * Postgres matches an index's pathkeys on nulls ordering STRICTLY — a bare `desc` means NULLS
 * FIRST and makes the planner sort instead of walking the index. Both columns are NOT NULL, so the
 * two spellings are semantically identical; only the plan changes. The measurement behind this
 * rule is in `profiles/ai-jobs.repository.ts`.
 */
export const NEWEST_RESUME_FIRST: readonly SQL[] = [
  sql`${generatedResumes.generatedAt} desc nulls last`,
  sql`${generatedResumes.id} desc nulls last`,
];
