import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";

import type { EmploymentSuggestion } from "./employment-suggestions";

/**
 * The post-interview work-history form (R4 Q1, ruled: "Option A, simplified").
 *
 * FOUR EMPLOYERS, THREE FIELDS EACH. Employer name typed, city chipped, from/to as month-year
 * chips.
 *
 * PROMOTIONS ARE NOW CAPTURABLE (#1328, unblocking #1313). v1 said "one role" and noted that
 * the two-level `employments[] → roles[]` schema was already built and that §11 #14 already
 * renders a second role whenever one appears, so nothing would have to change to support them
 * later. This is later, and the note held: the table, the reader and the renderer are
 * untouched, and only the ASK widened.
 *
 * WHY A FORM AND NOT MORE PACK QUESTIONS. `MAX_ENGINE_ASKS` is 24; a senior turner already
 * spends 23 of them. A multi-employer loop needs roughly six keys per employer, so one employer
 * would exhaust the budget and the trade questions — the point of the pack — would never be
 * asked.
 *
 * WHY THE CAP LIVES HERE. Four is a RENDER budget (`EMPLOYMENT_BLOCK_BUDGET`), not a database
 * constraint, so nothing below this layer enforces it. A fifth employer would be accepted,
 * stored, and then silently dropped by the sheet — which is the shape of failure §11 #7 exists
 * to forbid.
 */

/** `YYYY-MM`, matching `we_ym_format_chk` exactly. A month, never a date — §11 #3. */
const yearMonth = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/, "expected YYYY-MM");

/**
 * ROLES PER EMPLOYMENT accepted from one submission.
 *
 * NOT A RENDER BUDGET, unlike {@link EMPLOYMENT_BLOCK_BUDGET} — `roleStints` prints every
 * stint it is given, so no role is silently dropped by the sheet and the argument that puts
 * the employer cap in this file does not apply. This is a plain bound so a malformed client
 * cannot hand the degradation ladder an employment with forty promotions in it.
 */
export const ROLES_PER_EMPLOYMENT_MAX = 4;

/**
 * One stint inside an employment — a title held for a span (#1328, unblocking #1313).
 *
 * ITS OWN DATES, AND THEY ARE THE POINT. A promotion is exactly the case where the role's span
 * is narrower than the employment's, and §11 #14 renders that: a lone stint whose span equals
 * its employment prints no dates, and two stints always carry their own. A role with no start
 * inherits nothing — an inherited range would assert the worker held THAT title for the whole
 * tenure, which is precisely what a promotion did not do.
 *
 * `work_done` IS PER ROLE, not per employment, because that is where the data model already
 * puts it: `workLine()` composes the employment's single printed work line from the distinct
 * descriptions across its roles.
 */
const EmploymentRoleSchema = z
  .object({
    role_label: z.string().trim().min(1).max(80),
    start_ym: yearMonth.nullable().default(null),
    /** Null means CURRENT for this stint — the worker still holds this title. */
    end_ym: yearMonth.nullable().default(null),
    work_done: z.string().trim().min(1).max(300).nullable().default(null),
    /**
     * The clip this stint's {@link work_done} was SPOKEN into, when the worker used the mic.
     *
     * OPTIONAL AND ADDITIVE. Every shipped client omits it and keeps working unchanged — the same
     * widening discipline `roles` was added under. Absent means "typed", which is what every row
     * written before this shipped means too.
     *
     * The text is still sent in `work_done` and is still the answer of record: the client puts the
     * transcript in the box, the worker edits it if the ASR misheard, and what they submit is what
     * the sheet prints. This id only records where the first draft came from — which is why it may
     * accompany an EDITED description without lying.
     */
    work_done_voice_note_id: uuidSchema.nullable().default(null),
  })
  .strict()
  .refine((r) => r.end_ym === null || r.start_ym === null || r.end_ym >= r.start_ym, {
    message: "end_ym must not precede start_ym",
    path: ["end_ym"],
  })
  // A CLIP WITHOUT A DESCRIPTION IS NOT AN ANSWER. The transcript is what the worker submits; a
  // recording whose text was cleared says the worker rejected it, and keeping the id would leave
  // provenance pointing at a description that is not there.
  .refine((r) => r.work_done !== null || r.work_done_voice_note_id === null, {
    message: "work_done_voice_note_id requires work_done",
    path: ["work_done_voice_note_id"],
  });

const EmploymentEntrySchema = z
  .object({
    /**
     * The worker's own typing. §11 #4: contract or thekedar work with no company name renders
     * the site or the literal "contract work" — the field is never blank and never invented, so
     * the client must have already decided which, and an empty string is a client bug.
     */
    employer_name: z.string().trim().min(1).max(120),
    employer_city: z.string().trim().min(1).max(80).nullable().default(null),
    employer_state: z.string().trim().min(1).max(80).nullable().default(null),
    start_ym: yearMonth.nullable().default(null),
    /** Null means CURRENT — a real state, not missing data. */
    end_ym: yearMonth.nullable().default(null),
    /**
     * THE SINGLE-ROLE SHORTHAND, and it is kept rather than replaced.
     *
     * Every shipped client sends this pair and one role is still the overwhelming case. Making
     * it optional beside `roles` means an app build that predates promotion capture keeps
     * working unchanged and renders BYTE-IDENTICALLY — which is #1328's own acceptance
     * condition, and is why this is a widening rather than a migration.
     */
    role_label: z.string().trim().min(1).max(80).optional(),
    work_done: z.string().trim().min(1).max(300).nullable().default(null),
    /** The shorthand's clip. See {@link EmploymentRoleSchema.work_done_voice_note_id}. */
    work_done_voice_note_id: uuidSchema.nullable().default(null),
    /** Two or more titles at one employer — a promotion. See {@link EmploymentRoleSchema}. */
    roles: z.array(EmploymentRoleSchema).min(1).max(ROLES_PER_EMPLOYMENT_MAX).optional(),
  })
  .strict()
  .refine((e) => e.end_ym === null || e.start_ym === null || e.end_ym >= e.start_ym, {
    message: "end_ym must not precede start_ym",
    path: ["end_ym"],
  })
  // EXACTLY ONE OF THE TWO, never both and never neither.
  //
  // Neither is an employment with no title, which the sheet cannot print and the role table
  // cannot represent. BOTH is worse than redundant: the two would be free to disagree about
  // what the worker did there, and nothing downstream could say which one the worker meant.
  // Rejecting names the mistake at the boundary instead of silently preferring one.
  .refine((e) => (e.role_label === undefined) !== (e.roles === undefined), {
    message: "send either role_label or roles, not both and not neither",
    path: ["roles"],
  })
  // `work_done` is the SHORTHAND's field. With `roles` it belongs on the stint that earned it,
  // and accepting it at both levels would be a second place for one fact to live.
  .refine((e) => e.roles === undefined || e.work_done === null, {
    message: "work_done belongs on each role when roles is used",
    path: ["work_done"],
  })
  // The clip travels with the description it produced, so it obeys the same two rules.
  .refine((e) => e.roles === undefined || e.work_done_voice_note_id === null, {
    message: "work_done_voice_note_id belongs on each role when roles is used",
    path: ["work_done_voice_note_id"],
  })
  .refine((e) => e.work_done !== null || e.work_done_voice_note_id === null, {
    message: "work_done_voice_note_id requires work_done",
    path: ["work_done_voice_note_id"],
  });

export const SetMyEmploymentSchema = z
  .object({
    // A worker with no history sends `[]`, which CLEARS the block. That is a legitimate edit,
    // not a no-op, so it is accepted rather than rejected as empty.
    employments: z.array(EmploymentEntrySchema).max(4),
    /**
     * HOW MANY ROWS THE CLIENT BELIEVES IT IS REPLACING (#1504) — `employments.length +
     * unreadable_count` from the `GET` it prefilled from. OPTIONAL AND ADDITIVE.
     *
     * CHECKED INSIDE THE REPLACE TRANSACTION, against the rows that transaction just read, and a
     * mismatch is a 409 with nothing written and no event. A separate count before the write would
     * be a check another save could slip between; the transaction's own read cannot be.
     *
     * ITS PRESENCE IS ALSO THE NEW-BUILD SIGNAL. A body WITHOUT it is an old build, and an old
     * build sends `[]` for a page the worker never touched — so an empty list from an old build is
     * a no-op wherever rows exist (owner ruling 2026-09-15). With it, `[]` clears, as it always
     * has. The bound is not a cap on history: undecryptable rows survive a replace (see the
     * repository), so the stored count can legitimately exceed four.
     */
    expected_existing_count: z.number().int().min(0).max(64).optional(),
  })
  .strict();

export type SetMyEmploymentDto = z.infer<typeof SetMyEmploymentSchema>;

/** Which text prints as one stint's work line, as the worker last left it (#1354). */
export type DescriptionSource = "own_words" | "polished";

/** One stint as `GET /workers/me/employment` returns it (#1504). */
export interface EmploymentRoleView {
  readonly role_label: string;
  readonly start_ym: string | null;
  readonly end_ym: string | null;
  readonly work_done: string | null;
  readonly work_done_voice_note_id: string | null;
  /**
   * NOT A PUT FIELD. `own_words` when the worker refused the rewrite, `polished` when a rewrite
   * exists and prints, `null` when there is none. It is read-only context for the page; the choice
   * itself is changed through `PUT me/employment/:employmentId/description-source`.
   */
  readonly description_source: DescriptionSource | null;
}

/** One employment as `GET /workers/me/employment` returns it (#1504). */
export interface EmploymentView {
  /** NOT A PUT FIELD — it addresses the description-source route. Strip it before a PUT. */
  readonly employment_id: string;
  readonly employer_name: string;
  readonly employer_city: string | null;
  readonly employer_state: string | null;
  readonly start_ym: string | null;
  readonly end_ym: string | null;
  readonly roles: readonly EmploymentRoleView[];
}

export interface MyEmploymentResponse {
  readonly employments: readonly EmploymentView[];
  /**
   * Stored rows whose employer name would not decrypt, withheld from `employments`. They are NOT
   * erased by a replace — the repository carries them across — and they ARE counted by
   * `expected_existing_count`, so a client sends `employments.length + unreadable_count`.
   */
  readonly unreadable_count: number;
  /**
   * Jobs the worker never confirmed — from an uploaded résumé, from the chat interview's Phase A,
   * or both — offered beside his stored history (the ruling: "résumé-parsed jobs AND
   * chat-described jobs prefill Work History rows; saved only when the worker saves").
   *
   * BOTH SOURCES CAN BE PRESENT AT ONCE, AND NEITHER IS DROPPED FOR THE OTHER. A worker who both
   * uploaded a résumé and described a different job in chat sees two distinct entries, tagged by
   * `source`, rather than this route silently preferring one — the same "offer both, let the
   * worker choose" posture the résumé-import plan already states for a stored answer versus a
   * résumé's value.
   *
   * NOT A PUT FIELD. A suggestion becomes a real row only when the worker edits `employments[]`
   * himself and submits `PUT /workers/me/employment` — this array is never read by that route.
   */
  readonly employment_suggestions: readonly EmploymentSuggestion[];
}

/**
 * THE PROJECTION RULE FROM A GET ROW BACK TO A PUT ENTRY (#1504), stated as code so it can be tested.
 *
 * `EmploymentEntrySchema` is `.strict()` and demands EXACTLY ONE of the single-role shorthand or
 * `roles[]`, so a GET row cannot be echoed back and a client has to choose. The rule that preserves
 * everything stored:
 *
 *   ONE stint whose dates EQUAL the employment's  → the shorthand (`role_label`, `work_done`,
 *                                                   `work_done_voice_note_id` at employment level).
 *                                                   That is exactly the row the shorthand writes.
 *   anything else                                  → `roles[]`, each stint with its own dates, and
 *                                                   no employment-level `work_done`.
 *
 * A single stint with DIFFERENT dates must go through `roles[]`: the shorthand gives its one role
 * the employment's dates, so choosing it would silently widen the stint to the whole tenure.
 * `employment_id` and `description_source` are dropped — neither is a PUT field.
 *
 * This is the contract the mobile client implements; the server never calls it on a request.
 */
export function projectEmploymentForPut(view: EmploymentView): Record<string, unknown> {
  const base = {
    employer_name: view.employer_name,
    employer_city: view.employer_city,
    employer_state: view.employer_state,
    start_ym: view.start_ym,
    end_ym: view.end_ym,
  };
  const only = view.roles.length === 1 ? view.roles[0]! : null;
  if (only !== null && only.start_ym === view.start_ym && only.end_ym === view.end_ym) {
    return {
      ...base,
      role_label: only.role_label,
      work_done: only.work_done,
      work_done_voice_note_id: only.work_done_voice_note_id,
    };
  }
  return {
    ...base,
    roles: view.roles.map((r) => ({
      role_label: r.role_label,
      start_ym: r.start_ym,
      end_ym: r.end_ym,
      work_done: r.work_done,
      work_done_voice_note_id: r.work_done_voice_note_id,
    })),
  };
}

/**
 * Which text prints as this employment's work line (#1354).
 *
 * A CHOICE, NOT A DELETION. `own_words` records that the worker looked at the rewrite and
 * preferred what they actually wrote; the rewrite is kept, so `polished` puts it back with no
 * second model call. Reversible in both directions on purpose — a worker who taps the wrong
 * one must not have to re-enter their history to undo it.
 *
 * NAMED FOR WHAT PRINTS rather than for the flag it sets. `{ decline_polish: true }` would be
 * a client having to know the model wrote something in order to refuse it; this reads the way
 * the screen does.
 */
export const SetDescriptionSourceSchema = z
  .object({
    source: z.enum(["own_words", "polished"]),
  })
  .strict();
export type SetDescriptionSourceDto = z.infer<typeof SetDescriptionSourceSchema>;
export type EmploymentEntryDto = z.infer<typeof EmploymentEntrySchema>;
