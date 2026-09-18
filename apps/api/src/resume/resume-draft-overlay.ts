import { DraftProfileSchema, type DraftProfile } from "@badabhai/ai-contracts";
import type { WorkerPackAnswer } from "@badabhai/db";

import { buildTradeCapabilityRows, type WorkerAttributeValues } from "./trade-resume-map";

/**
 * Fresh pack answers over a frozen extraction, at résumé-generate time.
 *
 * THE STALENESS THIS CLOSES. The résumé text (`Machines:` / `Skills:`) renders
 * deterministically from the profile's stored `rawProfile`, which freezes at
 * extraction time. Trade-form answers written AFTER that — a section-walk edit
 * from the Bada Bhai menu, or any later form visit — land in
 * `worker_pack_answer` + `worker_attributes` and never reach the draft, so a
 * regenerate prints the OLD skills and the Resume tab reuses them forever.
 *
 * THE OVERLAY, AND WHY IT READS THE SHEET'S ROWS. Trade-pack answers are keyed
 * by pack question (`turning_machine`, …), which the RFS crosswalk deliberately
 * does not map — those answers belong to `worker_attributes` and the trade
 * sheet, not to the draft (`answer-map-projector.ts` skips them by design).
 * So the crosswalk projection cannot see them; but `buildTradeCapabilityRows`
 * already turns the live attribute bag into LABELLED capability rows for the
 * sheet. This overlay reuses those exact rows for the text lines — one source
 * (the trade map), two readers (sheet + text) — instead of inventing a second
 * pack→label mapping that could disagree with the sheet.
 *
 * THE SPLIT. Capability rows labelled `Machines` / `Controllers` feed the
 * `Machines:` line (the text has no Controllers line; dropping Fanuc silently
 * would lose a worker-confirmed claim, so it rides with the machines).
 * Every other chip/tick row feeds `Skills:`. Fact rows (single measurements
 * like "Tolerance held") are NOT skills and are excluded.
 *
 * GATED ON FRESHNESS, so every other generate is byte-identical to today. A
 * field overlays only when a pack answer postdates the profile row
 * (`answeredAt` refreshes on every re-answer, including conflict-updates).
 * First-time flows (answers older than the profile) and untouched workers take
 * the legacy path untouched.
 *
 * DETERMINISTIC SKILLS RETIRE THE STALE MODEL LIST. `build_resume` prefers
 * `resume_profile.skills` (the model's list) over the deterministic entries,
 * so leaving a stale model list in place would keep printing it ABOVE the new
 * answers. When the skills line overlays, the container's list is cleared —
 * the container stays the model's record for its other eight keys; only the
 * list the worker just re-answered is retired, because the pipeline's own
 * precedence (deterministic answer map > LLM parse) says the worker wins.
 *
 * PURE + FAIL-CLOSED. No I/O, no logging, no PII in or out (counts and labels
 * the worker tapped — the same strings the sheet already prints). A caller
 * that cannot parse the result keeps the original draft.
 */

export interface DraftOverlayResult {
  readonly draft: DraftProfile;
  readonly overlaidMachines: boolean;
  readonly overlaidSkills: boolean;
}

/** Capability-row labels that feed the `Machines:` text line. */
const MACHINE_ROW_LABELS: ReadonlySet<string> = new Set(["Machines", "Controllers"]);

export function overlayFreshCapabilityLines(input: {
  readonly draft: DraftProfile;
  readonly packAnswers: readonly WorkerPackAnswer[];
  readonly profileCreatedAt: Date;
  readonly packId: string | null;
  readonly attributes: WorkerAttributeValues;
}): DraftOverlayResult {
  const unchanged: DraftOverlayResult = {
    draft: input.draft,
    overlaidMachines: false,
    overlaidSkills: false,
  };

  if (input.packId === null) return unchanged;
  const profileTime = input.profileCreatedAt.getTime();
  let fresh = false;
  for (const row of input.packAnswers) {
    // Settled writes only: an `unanswered` row carries no worker input, and a
    // re-answer bumps `answeredAt` (conflict-update refreshes it), so any
    // settled row newer than the profile is the worker changing their answers
    // after profiling — exactly the edit case.
    if (row.status !== "unanswered" && row.answeredAt.getTime() > profileTime) {
      fresh = true;
      break;
    }
  }
  if (!fresh) return unchanged;

  const capability = buildTradeCapabilityRows(input.packId, input.attributes);
  const machines: string[] = [];
  const skills: string[] = [];
  for (const row of [...capability.chipRows, ...capability.tickRows]) {
    const target = MACHINE_ROW_LABELS.has(row.label.trim()) ? machines : skills;
    for (const value of row.values) {
      const trimmed = value.trim();
      if (trimmed.length > 0 && !target.includes(trimmed)) target.push(trimmed);
    }
  }
  if (machines.length === 0 && skills.length === 0) return unchanged;

  const next: DraftProfile = {
    ...input.draft,
    machines: machines.length > 0 ? machines : input.draft.machines,
    skill_labels: skills.length > 0 ? skills : input.draft.skill_labels,
    resume_profile:
      skills.length > 0 && input.draft.resume_profile
        ? { ...input.draft.resume_profile, skills: [] }
        : input.draft.resume_profile,
  };
  try {
    return {
      draft: DraftProfileSchema.parse(next),
      overlaidMachines: machines.length > 0,
      overlaidSkills: skills.length > 0,
    };
  } catch {
    return unchanged;
  }
}
