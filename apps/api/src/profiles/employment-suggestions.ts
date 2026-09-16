import type { ExperienceEntry, ResumeEmployment } from "@badabhai/ai-contracts";

/**
 * A job a worker never confirmed, offered beside his Work History page — from a résumé he
 * uploaded, or from the LLM-led chat interview's Phase A (owner ruling: "résumé-parsed jobs AND
 * chat-described jobs prefill Work History rows; saved only when the worker saves").
 *
 * STAGED, NEVER WRITTEN. Nothing in this file touches `worker_employment` — it only shapes data
 * that already exists (a parsed résumé row, a settled interview draft) into what the edit page
 * renders as an unconfirmed row. The same discipline `resume-suggestions.ts` states for the pack
 * form (ruling D2): a suggestion becomes an answer only when the worker submits
 * `PUT /workers/me/employment` with it in the body.
 *
 * NOT `ResumeSuggestion` FROM `resume-suggestions.ts`, DELIBERATELY. That type is keyed by
 * `question_key` and carries option/text/number/bool — the shape one pack-question answer takes.
 * An employment is a STRUCTURED RECORD (`EmploymentEntrySchema` in `worker-employment.dto.ts`),
 * not an answer to one question, so it needs its own values shape. What IS reused, on purpose, is
 * the `source` tag — `"resume" | "chat"` mirrors that file's `source: "resume"` convention rather
 * than inventing a second name for the same idea.
 */
export type EmploymentSuggestionSource = "resume" | "chat";

/**
 * A candidate row for `EmploymentEntrySchema`, before the worker has seen or edited it.
 *
 * EVERY FIELD IS NULLABLE, including `role_label`, because a suggestion is allowed to be
 * partial — the worker fills the rest on the page. What `EmploymentEntrySchema` requires
 * (`employer_name` non-empty, `role_label` when there is no `roles[]`) is a constraint on what
 * gets SAVED, not on what may be OFFERED.
 */
export interface EmploymentSuggestionValues {
  readonly employer_name: string | null;
  readonly employer_city: string | null;
  readonly role_label: string | null;
  /** 'YYYY-MM', matching `worker-employment.dto.ts`'s `yearMonth` — never a bare year. */
  readonly start_ym: string | null;
  readonly end_ym: string | null;
  readonly work_done: string | null;
}

export interface EmploymentSuggestion {
  readonly source: EmploymentSuggestionSource;
  readonly values: EmploymentSuggestionValues;
}

/** `""` and whitespace-only are "not stated", the same reading `worker-employment.dto.ts` gives them. */
function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * A résumé's parsed employments → Work History suggestions (closes the RI-4 gap: nothing
 * downstream of `ResumeParseService.parse` used to read `draft.employments` at all — see
 * `ResumeRouteService.decide`, which now calls this before sealing the suggestion payload).
 *
 * NO MONTH, EVER. `ResumeEmploymentSchema` (packages/ai-contracts/src/resume-import.ts) carries
 * only a calendar YEAR (`start_year`/`end_year`), and `EmploymentEntrySchema`'s `yearMonth`
 * demands `YYYY-MM`. Inventing a month from a bare year would be exactly the fabrication
 * `worker-employment.dto.ts` refuses in its own docblock ("a month, never a date" — §11 #3's
 * "duration not stated" literal exists for precisely this gap). The worker supplies the month
 * himself if he accepts the suggestion; the form already renders that state correctly for a row
 * with no `start_ym`.
 *
 * AN EMPTY ROW IS NOT OFFERED. A `ResumeEmployment` with neither a name nor a title is a spent
 * ask that asks nothing — the same posture `resume-suggestions.ts` states for a suggestion with
 * nothing in it.
 */
export function buildResumeEmploymentSuggestions(
  employments: readonly ResumeEmployment[],
): EmploymentSuggestion[] {
  const out: EmploymentSuggestion[] = [];
  for (const employment of employments) {
    const employerName = nonEmpty(employment.employer_name);
    const roleLabel = nonEmpty(employment.role_title);
    if (employerName === null && roleLabel === null) continue;
    out.push({
      source: "resume",
      values: {
        employer_name: employerName,
        employer_city: null,
        role_label: roleLabel,
        start_ym: null,
        end_ym: null,
        work_done: null,
      },
    });
  }
  return out;
}

/**
 * The LLM-led chat interview's Phase A `experiences[]` → Work History suggestions.
 *
 * `employer_name` IS ALWAYS `null`, AND THAT IS ARCHITECTURAL, NOT A MASKING CHOICE. Unlike the
 * résumé route, chat's `ExperienceEntrySchema` (packages/ai-contracts/src/oie.ts) is `.strict()`
 * with no `employer_name` field AT ALL, on both sides of the AI-service boundary and pinned by
 * `test_contract_parity.py` — so there is nothing to strip, mask or certify here: an employer
 * name cannot reach this function's input no matter what the model produced, because it is
 * rejected at the contract boundary before `settleFromLlmDraft`/the extraction processor ever
 * see it. That schema's own docblock states why: "CLAUDE.md §2 forbids storing employer names…
 * a strict schema makes `employer_name` fail at the boundary, before it can reach a column."
 * The worker types the employer on this same page — precisely what
 * `WorkerEmploymentService.replaceForWorker` has always required ("THE EMPLOYER NAME NEVER
 * PASSES THROUGH THE AI SERVICE").
 *
 * `role_label` and `work_done` ARE the model's own structured output, already returned inside
 * the same interview turn — no second AI-service call is made to produce or re-read them. They
 * land in exactly the field `worker_employment.roles.work_done` already accepts free text into
 * from the worker's own typing, and the worker reviews/edits/discards every word before a save
 * writes it — the same trust boundary `PUT /workers/me/employment` already extends to a rewrite
 * the model composes for #1350's "polish" feature.
 *
 * NO DATES, EVER. The interview captures a DURATION (`duration_months`, "kuch saal"), never a
 * calendar start or end, so there is nothing honest to put in `start_ym`/`end_ym` — the same
 * "duration not stated" state `worker-employment.dto.ts` already renders correctly for a row
 * with no start month.
 *
 * EVERY ENTRY IS OFFERED. `role_label` is non-empty by `ExperienceEntrySchema` (`min(1)`), so an
 * entry is never empty the way a résumé row can be — one settled experience entry is always one
 * suggestion.
 */
export function buildChatEmploymentSuggestions(
  experiences: readonly ExperienceEntry[],
): EmploymentSuggestion[] {
  return experiences.map((entry) => ({
    source: "chat",
    values: {
      employer_name: null,
      employer_city: null,
      role_label: nonEmpty(entry.role_label),
      start_ym: null,
      end_ym: null,
      work_done: nonEmpty(entry.work_done),
    },
  }));
}
