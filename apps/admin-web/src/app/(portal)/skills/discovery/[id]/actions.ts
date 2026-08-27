"use server";

import { z } from "zod";
import { adminFetch, isAdminRequestError } from "../../../../../lib/admin-http";
import { describeAdminActionError } from "../../../../../lib/describe-admin-error";
import {
  SKILL_CANDIDATE_STATUSES,
  parseSkillDecisionConflict,
  skillDecisionClientErrors,
  type SkillDecisionOutcome,
  type SkillDecisionRequest,
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
