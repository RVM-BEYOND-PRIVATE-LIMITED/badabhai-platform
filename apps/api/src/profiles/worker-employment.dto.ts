import { z } from "zod";

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
  })
  .strict()
  .refine((r) => r.end_ym === null || r.start_ym === null || r.end_ym >= r.start_ym, {
    message: "end_ym must not precede start_ym",
    path: ["end_ym"],
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
  });

export const SetMyEmploymentSchema = z
  .object({
    // A worker with no history sends `[]`, which CLEARS the block. That is a legitimate edit,
    // not a no-op, so it is accepted rather than rejected as empty.
    employments: z.array(EmploymentEntrySchema).max(4),
  })
  .strict();

export type SetMyEmploymentDto = z.infer<typeof SetMyEmploymentSchema>;

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
