"use server";

import { z } from "zod";
import { adminFetch, isAdminRequestError } from "../../../../../lib/admin-http";
import { describeAdminActionError } from "../../../../../lib/describe-admin-error";
import { searchCanonicalSkills } from "../../../../../lib/skill-discovery";
import {
  ADMIN_SKILLS_QUERY_MIN,
  SKILL_CANDIDATE_STATUSES,
  parseSkillDecisionConflict,
  skillDecisionClientErrors,
  type SkillDecisionOutcome,
  type SkillDecisionRequest,
  type SkillSearchOutcome,
} from "../../../../../lib/skill-discovery-vocabulary";

/**
 * POST /admin/skill-discovery/:id/decision — the ONE write this feature makes (#1260).
 *
 * Mirrors `AdminSkillDecisionResult`. The two literal fields (`corpus_effect`, `next_step`)
 * are asserted with `z.literal` rather than read — a response claiming anything else about
 * what happened is a contract break this page must refuse to render, not silently accept.
 */
const decisionResultSchema = z.object({
  target_id: z.string(),
  changed: z.boolean(),
  status: z.enum(SKILL_CANDIDATE_STATUSES),
  already_decided: z.boolean(),
  corpus_effect: z.literal("decision_recorded_no_corpus_write"),
  next_step: z.literal("awaiting_offline_corpus_chain"),
});

/**
 * Records one reviewer decision on one candidate.
 *
 * ── WHY THE CLIENT-SIDE GATE IS CHECKED HERE TOO ────────────────────────────────────────
 * `SkillDecisionPanel` already disables its submit button on a client error, but a Server
 * Action is a real network endpoint any authenticated admin's browser can call directly —
 * the disabled button is UX, not enforcement. Re-checking here costs nothing and means a
 * request that skipped the UI still gets a plain-English refusal instead of reaching the API
 * only to be told the same thing as a 400 the caller has to decode.
 *
 * ── THE THREE THINGS THIS FUNCTION NEVER SENDS ──────────────────────────────────────────
 * No reviewer id, no timestamp, no candidate id in the body — the reviewer is
 * `@CurrentAdmin()` from the session cookie `adminFetch` already carries, the moment is the
 * server clock, and the candidate is the validated PATH param. An actor a caller can type is
 * not an actor.
 */
export async function submitSkillDecisionAction(
  candidateId: string,
  request: SkillDecisionRequest,
): Promise<SkillDecisionOutcome> {
  const clientErrors = skillDecisionClientErrors(request);
  if (clientErrors.length > 0) {
    return { kind: "error", message: clientErrors.join(" ") };
  }

  try {
    const res = await adminFetch(
      `/admin/skill-discovery/${encodeURIComponent(candidateId)}/decision`,
      { method: "POST", body: request, schema: decisionResultSchema },
    );
    return {
      kind: "success",
      changed: res.changed,
      status: res.status,
      already_decided: res.already_decided,
    };
  } catch (err) {
    /**
     * A 409 is the ONE refusal this surface renders differently from every other governed
     * mutation on this console — never a silent retry, and never the generic error banner,
     * because the body carries a closed conflict code the reviewer needs to act on
     * (`stale_expected_status` / `already_decided` / `illegal_transition`). Falls through to
     * the generic error path if the body did not parse as a real conflict, so a malformed or
     * unexpected 409 still fails honestly rather than claiming a conflict that was never
     * confirmed.
     */
    if (isAdminRequestError(err) && err.status === 409) {
      const info = parseSkillDecisionConflict(err.body);
      if (info) return { kind: "conflict", info };
    }
    return { kind: "error", message: describeAdminActionError(err) };
  }
}

/**
 * GET /admin/skills?q= — the MAP/MERGE picker's search (#1280).
 *
 * ── WHY A SERVER ACTION AND NOT A CLIENT FETCH ──────────────────────────────────────────
 * `adminFetch` is `import "server-only"` — it reads the admin JWT from an httpOnly cookie and
 * that transport must never exist in a client bundle (CLAUDE.md: no server secret in a client
 * bundle). `SkillDecisionPanel`'s picker is a client component, so this is its only path to the
 * route, exactly the shape `submitSkillDecisionAction` above already establishes.
 *
 * ── WHAT THIS FUNCTION DOES NOT DO ───────────────────────────────────────────────────────
 * It does not filter `skills` — deprecated and `match_skill` results are returned with their
 * `mappable`/`not_mappable_reason` intact, exactly as the API served them. Filtering here would
 * be the exact "second copy of a server judgement" CLAUDE.md invariant #9 refuses, and it would
 * also defeat the reason the API returns them flagged rather than absent: a reviewer searching
 * for a skill they remember must be able to tell "no such skill" from "deprecated" from "that's
 * match vocabulary" apart.
 *
 * The `q.length < ADMIN_SKILLS_QUERY_MIN` short-circuit is a UX nicety (no network round trip
 * for the still-typing case), never a substitute for the server's own `.min(2)` — a query that
 * slips through short still earns the server's own 400, surfaced as `kind: "error"` below.
 */
export async function searchCanonicalSkillsAction(q: string): Promise<SkillSearchOutcome> {
  const trimmed = q.trim();
  if (trimmed.length < ADMIN_SKILLS_QUERY_MIN) {
    return { kind: "success", skills: [], q: trimmed, truncated: false };
  }
  try {
    const res = await searchCanonicalSkills(trimmed);
    return { kind: "success", skills: res.skills, q: res.q, truncated: res.truncated };
  } catch (err) {
    return { kind: "error", message: describeAdminActionError(err) };
  }
}
