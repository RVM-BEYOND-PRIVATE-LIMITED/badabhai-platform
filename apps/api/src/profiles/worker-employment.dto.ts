import { z } from "zod";

/**
 * The post-interview work-history form (R4 Q1, ruled: "Option A, simplified").
 *
 * FOUR EMPLOYERS, THREE FIELDS EACH, ONE ROLE. Employer name typed, city chipped, from/to as
 * month-year chips. Capture does not ask about promotions in v1 — the two-level
 * `employments[] → roles[]` schema stays exactly as built and §11 #14 already renders a second
 * role whenever one appears, so nothing has to change to support them later.
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
    /** The single role, per the v1 ruling. Promotions are a later capture change, not a schema one. */
    role_label: z.string().trim().min(1).max(80),
    work_done: z.string().trim().min(1).max(300).nullable().default(null),
  })
  .strict()
  .refine((e) => e.end_ym === null || e.start_ym === null || e.end_ym >= e.start_ym, {
    message: "end_ym must not precede start_ym",
    path: ["end_ym"],
  });

export const SetMyEmploymentSchema = z
  .object({
    // A worker with no history sends `[]`, which CLEARS the block. That is a legitimate edit,
    // not a no-op, so it is accepted rather than rejected as empty.
    employments: z.array(EmploymentEntrySchema).max(4),
  })
  .strict();

export type SetMyEmploymentDto = z.infer<typeof SetMyEmploymentSchema>;
export type EmploymentEntryDto = z.infer<typeof EmploymentEntrySchema>;
