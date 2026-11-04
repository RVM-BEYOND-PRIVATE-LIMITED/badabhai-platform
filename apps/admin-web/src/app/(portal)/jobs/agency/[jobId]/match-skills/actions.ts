"use server";

import { z } from "zod";

import { adminFetch } from "../../../../lib/admin-http";
import { describeAdminActionError } from "../../../../lib/describe-admin-error";
import {
  matchSkillVocabularySchema,
  setAgencyJobMatchSkillsResultSchema,
  type MatchSkillVocabulary,
} from "../../../../lib/agency-jobs";
import type { AdminActionOutcome } from "../../../../lib/admin-action-result";

/**
 * GET /admin/match/skills — the picker vocabulary (backend #2207).
 *
 * ── WHY A SERVER ACTION AND NOT A lib/ FETCHER ──────────────────────────────
 * The page-gates fence requires every `adminFetch` in lib/ to map to an API
 * GET route that EXISTS, and this endpoint deploys with #2207. Reading it
 * here (mirroring `searchCanonicalSkillsAction`) keeps the fence green while
 * the UI ships complete: the detail page degrades to "vocabulary unavailable"
 * until the endpoint exists, with zero UI changes needed on that day. A
 * `"use client"` picker reaches the API ONLY through Server Actions, so this
 * is also the client's only road to it.
 */
export async function readMatchVocabularyAction(): Promise<
  { ok: true; vocabulary: MatchSkillVocabulary } | { ok: false }
> {
  try {
    const vocabulary = await adminFetch("/admin/match/skills", {
      schema: matchSkillVocabularySchema,
    });
    return { ok: true, vocabulary };
  } catch {
    return { ok: false };
  }
}

/**
 * PUT /admin/agency-jobs/:jobId/match-skills — the ONE write this feature
 * makes. Mirrors `setAgencyJobMatchSkillsResultSchema`: `changed: false` is a
 * successful no-op, never an error.
 *
 * ── WHY THE CLIENT-SIDE PRECHECK IS REPEATED HERE ───────────────────────────
 * Same reason as the skill-decision action: a Server Action is callable past
 * the UI, so the shape floor (`mskill_*` ids, ≤50 entries) is re-checked for
 * a plain-English refusal. The BUSINESS rules (closed vocabulary membership,
 * the runtime cap, closed-posting) stay server-side — never re-implemented.
 *
 * ── WHAT THIS NEVER SENDS ───────────────────────────────────────────────────
 * No admin id (the actor is `@CurrentAdmin()` from the session cookie
 * `adminFetch` carries) and no payer id (the row's owner is resolved
 * server-side from the job). An actor a caller can type is not an actor.
 */
const requestSchema = z.object({
  match_skill_ids: z
    .array(z.string().regex(/^mskill_[a-z0-9_]+$/, "Unknown skill id — pick from the list."))
    .max(50, "A posting may name at most 50 skills."),
});

export async function setAgencyJobMatchSkillsAction(
  jobId: string,
  request: { match_skill_ids: string[] },
): Promise<AdminActionOutcome> {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => i.message).join(" "),
    };
  }
  try {
    const res = await adminFetch(
      `/admin/agency-jobs/${encodeURIComponent(jobId)}/match-skills`,
      { method: "PUT", body: parsed.data, schema: setAgencyJobMatchSkillsResultSchema },
    );
    return {
      ok: true,
      changed: res.changed,
      message: res.changed
        ? "Match skills saved."
        : "No change — the selection already matched.",
    };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}
