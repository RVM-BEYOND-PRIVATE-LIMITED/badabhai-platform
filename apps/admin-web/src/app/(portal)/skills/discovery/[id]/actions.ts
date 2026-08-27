"use server";

import { z } from "zod";
import { adminFetch, isAdminRequestError } from "../../../../../lib/admin-http";
import { describeAdminActionError } from "../../../../../lib/describe-admin-error";
import { searchCanonicalSkills } from "../../../../../lib/skill-discovery";
import {
  ADMIN_SKILLS_QUERY_MIN,
  SKILL_CANDIDATE_STATUSES,
  type SkillSearchOutcome,
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

/**
 * The MAP/MERGE picker's lookup — `GET /admin/skills?q=`.
 *
 * ══ WHY THIS IS A SERVER ACTION AND NOT A BROWSER FETCH ═════════════════════════════════
 * `adminFetch` reads the admin session from an httpOnly cookie and is `import "server-only"`.
 * There is no browser-side admin fetch anywhere in this console and this search does not become
 * the first one: the panel calls this action, the action calls the API, and the token never goes
 * near the bundle.
 *
 * ══ AND IT IS THE ADMIN ROUTE, NOT THE INTERNAL SKILLS SEAM ════════════════════════════
 * The service-to-service skills controller sits behind its own credential. A console reaching for
 * it would be authenticating as a service: wrong guard, no admin identity, and nothing tying the
 * lookup to the operator's session. It is never called from this app.
 *
 * ══ IT SEARCHES; IT DECIDES NOTHING ════════════════════════════════════════════════════
 * The route reports `mappable` per result rather than filtering the ineligible ones out, and this
 * action passes that through untouched. A reviewer searching for a skill they remember and
 * getting an empty list cannot tell "no such skill" from "deprecated" from "that is match
 * vocabulary" — three states needing three different actions. The decision route re-validates
 * whatever id it is handed regardless, so this makes the picker usable without making it the
 * authority on what is mappable.
 *
 * Failures come back as an EMPTY result plus a message, never as a throw: a lookup that fell over
 * must not take down the decision form around it, and the reviewer can still type an id.
 */
export async function searchCanonicalSkillsAction(q: string): Promise<SkillSearchOutcome> {
  const term = q.trim();
  /*
   * The route's own floor is two characters, and it refuses a shorter term with a 400. Answering
   * that here rather than spending a round trip on a refusal the client can predict — and the
   * message says the rule rather than reporting a failure the reviewer did not cause.
   */
  if (term.length < ADMIN_SKILLS_QUERY_MIN) {
    return {
      skills: [],
      q: term,
      truncated: false,
      error: `Type at least ${ADMIN_SKILLS_QUERY_MIN} characters to search.`,
    };
  }

  try {
    const res = await searchCanonicalSkills(term);
    return { skills: res.skills, q: res.q, truncated: res.truncated };
  } catch (err) {
    return { skills: [], q: term, truncated: false, error: describeAdminActionError(err) };
  }
}
