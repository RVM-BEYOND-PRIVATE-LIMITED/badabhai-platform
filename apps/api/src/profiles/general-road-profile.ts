import {
  DraftProfileSchema,
  ProfileExtractionOutputSchema,
  WorkerProfileDraftSchema,
  type ProfileExtractionOutput,
} from "@badabhai/ai-contracts";
import type { GeneralRoadStamp } from "../profiling/conversation-state";
import { MAX_SKILLS } from "../profiling/skill-certifier";
import { totalEmployedYears, type WorkerEmploymentRecord } from "../resume/resume-employment-rows";
import { cleanList, cleanScalar } from "../resume/resume-render-input";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════
 * THE PROFILE ON THE GENERAL ROAD (ADR-0045 §3.4) — built with ZERO model calls.
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * A worker outside the 21 declared roles is profiled in three steps: the model captures the role,
 * then the skills (certified twice, confirmed by the worker at the gate, and persisted durably as
 * `conversation_state.general_road`), and everything else is asked OFFLINE by the general form. By
 * the time this runs, nothing is left for a model to do: the answer map's deterministic projection
 * holds what the chat captured, the stamp holds the role and the skills, and `worker_employment`
 * holds the Work History the form stored. This file is the pure merge of those three.
 *
 * PURE, AND DELIBERATELY SO: no I/O, no logger, no clock except the `asOf` the caller passes. The
 * processor reads the session and the employment rows and calls this; every rule below is then
 * testable without a queue, a database or a model.
 *
 * WHAT EACH SOURCE MAY WRITE — and, just as much, what it may not:
 *
 *   `skill_labels` (the legacy draft, `raw_profile`) — the stamp's skills, and nothing else. The
 *        list the worker confirmed at the gate is the list; the answer map never ran them past the
 *        certifier or the gate. R7: the skills are for the RÉSUMÉ, which reads `raw_profile`.
 *   `skills` (the canonical column) — UNTOUCHED, i.e. whatever the deterministic projection wrote,
 *        which is `[]` by construction. That column is what matching reads (`WorkerSkillsService`,
 *        `job_reach`), and R7 keeps these skills off every matching input until the owner revisits.
 *   `role_label` / `domain_label` — the stamp's certified labels, when they survive the screen.
 *   `experience.total_years` — `totalEmployedYears` over the stored employment, and ONLY that (R5):
 *        null when there is no row or any row is undated, and a value the projection produced from
 *        the chat's experience answer never survives. The chat forgets that answer on entering the
 *        skills lane anyway; this is the second wall, not the first.
 *   `resume_profile` — null. It is the Phase C container, and no Phase C call happened.
 *
 * THE RICH DRAFT (`worker_profile_draft`) carries the same role, skills and years, because
 * `hasExtractedContent` reads it: a worker whose only content is the gate's skills must land as
 * `extracted`, not `draft`. It is on no match path — `reach.repository` bans the column from its
 * projection and `WorkerSkillsService` reads the canonical columns only.
 */

/** The inputs, all already read by the processor. */
export interface GeneralRoadExtractionInput {
  /**
   * `toExtractionOutput(projection, null)` — the answer map's deterministic profile, exactly what the
   * ordinary OIE path would persist had its parse and its Phase C call both come back with nothing.
   */
  readonly deterministic: ProfileExtractionOutput;
  /** The session's durable stamp, read with `readGeneralRoadStamp` and already `handed_over`. */
  readonly stamp: GeneralRoadStamp;
  /** `WorkerEmploymentRepository.loadForResume(workerId)` — the Work History the form stored. */
  readonly employments: readonly WorkerEmploymentRecord[];
  /** The job's processing time — what closes a current job's span. */
  readonly asOf: Date;
}

/** The profile to persist for a handed-over general-road session. See the file header. */
export function buildGeneralRoadExtraction(
  input: GeneralRoadExtractionInput,
): ProfileExtractionOutput {
  const { deterministic, stamp, employments, asOf } = input;
  const roleLabel = screenLabel(stamp.role_label, "role_label");
  const domainLabel = screenLabel(stamp.domain_label, "domain_label");
  const skillLabels = screenSkills(stamp.skills);
  // THE ONE SUMMING RULE, reused rather than restated: the same all-or-nothing total the sheet's
  // headline prints, so the profile and the résumé cannot disagree about a worker's years.
  const totalYears = totalEmployedYears(employments, asOf);

  const profile = DraftProfileSchema.parse({
    ...deterministic.profile,
    skill_labels: skillLabels,
    // "WHEN NON-NULL AFTER SCREENING": a label the screen refused leaves the deterministic value,
    // which on this path is null — the projection has no role or domain question of its own.
    role_label: roleLabel ?? deterministic.profile.role_label,
    domain_label: domainLabel ?? deterministic.profile.domain_label,
    // SET, NOT MERGED: null when the employment cannot be summed, so a projected
    // `experience_years` (the chat's own answer) is overwritten rather than left standing.
    experience: { ...deterministic.profile.experience, total_years: totalYears },
    resume_profile: null,
  });

  const base = deterministic.worker_profile_draft;
  const draft = WorkerProfileDraftSchema.parse({
    ...(base ?? {}),
    // The stamp's role when it survived the screen; otherwise the answer map's own deterministic
    // value stands, exactly as it would on any other deterministic profile. Never erased.
    primary_role: roleLabel ?? base?.primary_role ?? null,
    skills: skillLabels,
    experience_years: totalYears,
  });

  // BUILT WHOLE, NOT SPREAD from `deterministic`: every model-shaped field is pinned to the value
  // that says "no model was asked" — no metadata (so no `ai.cost_recorded`), not a mock, and no
  // classifier match (the pinned occupation, when there is one, travels separately).
  return ProfileExtractionOutputSchema.parse({
    profile,
    blocked: false,
    is_mock: false,
    extraction_status: "completed",
    worker_profile_draft: draft,
    ai_metadata: null,
    job_domain_match: null,
  });
}

/**
 * A stamp label, re-screened: trimmed, blank and PII-shaped values dropped (`cleanScalar`, the
 * résumé's own rule), and one that would not fit the column's contract dropped too.
 *
 * DEFENSIVE, NOT REDUNDANT. The chat certified these labels before stamping them, but the stamp is
 * persisted JSON read back minutes or days later, possibly by a newer build — so it is untrusted
 * input on the way in, like every other read of `conversation_state`. The length check uses the
 * contract's own bound rather than a copy of it: a label past it would make `DraftProfileSchema`
 * throw inside the job, and a label is never worth the worker's profile.
 */
function screenLabel(value: string | null, field: "role_label" | "domain_label"): string | null {
  const cleaned = cleanScalar(value);
  if (cleaned === null) return null;
  return DraftProfileSchema.shape[field].safeParse(cleaned).success ? cleaned : null;
}

/**
 * The stamp's skills, re-screened with the résumé's `cleanList` rule, de-duplicated
 * case-insensitively (first spelling wins, the gate's order kept) and capped at `MAX_SKILLS` — the
 * same cap the stamp's own schema and the chat's skills stage apply.
 */
function screenSkills(skills: readonly string[]): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const label of cleanList(skills)) {
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(label);
    if (kept.length === MAX_SKILLS) break;
  }
  return kept;
}
