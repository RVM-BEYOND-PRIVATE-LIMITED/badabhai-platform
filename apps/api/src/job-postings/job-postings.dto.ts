import { z } from "zod";
import { uuidSchema, looksLikePii } from "@badabhai/validators";
import { VACANCY_BANDS } from "@badabhai/types";
import { clearFieldSchema, contradictoryClears } from "../common/clearable-fields";
import {
  areaSchema,
  benefitsSchema,
  experienceWindowOrdered,
  experienceYearsSchema,
  neededBySchema,
  payAmountSchema,
  payBandOrdered,
  payTypeSchema,
  requirementsSchema,
  shiftSchema,
} from "../common/job-content.schemas";

// Length caps (chars). org/role/location are short labels; description is a
// longer free-text blurb. Enforced in the schema so oversize input never reaches
// the service or the table.
const LABEL_MAX = 200;
const DESCRIPTION_MAX = 2000;

const orgLabel = z.string().min(1).max(LABEL_MAX);
const roleTitle = z.string().min(1).max(LABEL_MAX);
const locationLabel = z.string().min(1).max(LABEL_MAX);

/**
 * Description is the ONLY free-text field we run the PII heuristic on. A long
 * digit run in org_label/role_title/location_label is a legit machine model
 * number / pincode / job code (false positive), so we do NOT screen those — but a
 * phone/email in the human-typed description is a real leak risk. This is D3
 * defense-in-depth, NOT the primary control (the events are PII-free by
 * construction); we name the field, never the offending content.
 */
const description = z
  .string()
  .min(1)
  .max(DESCRIPTION_MAX)
  .refine((s) => !looksLikePii(s), {
    message: "remove contact details from the description",
  });

/**
 * Raw vacancy count — INTAKE ONLY. An ops actor MAY supply a concrete head count
 * (e.g. `vacancies: 7`) instead of choosing a band; the service derives the band
 * via `bandForCount` and then DISCARDS the integer. Per ADR-0012 the raw count is
 * NEVER stored on a column and NEVER put in an event — only the derived
 * `vacancyBand` (the existing banded enum) is persisted/evented.
 */
const vacancies = z.number().int().positive();

/**
 * Create a job posting. `status` is intentionally NOT accepted — every posting
 * starts as `draft` (the service hard-codes it, ignoring any client value).
 *
 * `created_by` is a REQUIRED opaque ops-actor uuid: there is no ops auth in
 * alpha, so the caller supplies the actor id (used for both the column and the
 * event payload). Resolving it from an authenticated ops session is deferred to
 * Phase 2.
 *
 * Vacancy is supplied EXACTLY ONE of two ways: a pre-chosen `vacancy_band` (the
 * existing banded enum) OR a raw `vacancies` integer that the service derives to
 * a band. Both are optional on the object; the refine enforces "exactly one".
 * Existing callers that pass `vacancy_band` keep working unchanged.
 */

/**
 * ADR-0030 / TAX-6: optional skill PHRASES on a posting. Free text from the poster
 * (like `description`) — canonicalized into closed-set skill_ids by the SAME
 * canonicalize_skill pipeline the worker side uses; the ids stored are only ever
 * vector-layer-assigned (SG-3). Bounded: <=10 phrases, each 1..80 chars.
 */
const skillsInput = z.array(z.string().min(1).max(80)).max(10);

/**
 * A Matching V1 `mskill_*` id (ADR-0036). SHAPE only — closed-set membership is
 * checked in `MatchSkillsService` against `@badabhai/taxonomy`, because that is where
 * the vocabulary lives and a Zod enum here would be a second copy to keep in sync.
 * DISTINCT from `skillsInput` above: that is ADR-0030 descriptive free text and is
 * never matched on; these are the match inputs.
 */
const matchSkillId = z.string().regex(/^mskill_[a-z0-9_]+$/, "not a match skill id");

/**
 * THE WORKER-VISIBLE POSTING FIELDS — one definition, every write route (#1645/#1646/#1648).
 *
 * `job_postings` became THE SERVED entity at the 0054 cutover and gained the display
 * columns `jobs` used to carry; migration 0116 (#1561) added the rich card content on top.
 * Until now ONLY `PATCH` accepted any of them, so a payer could complete the entire create
 * flow, get a `201`, and have every one of these fields silently dropped by Zod — and with
 * `match_skill_ids` among them, `reach_skills` stayed empty, `materializeIfNeeded` returned
 * early at publish, `job_reach` got no rows, and the posting reached NO WORKER AT ALL while
 * showing the company a success state (#1645).
 *
 * Spread into BOTH create schemas and the update schema so the three can never disagree
 * again: a field added here is accepted on every route or on none.
 *
 * PII: every field is PII-free by its own classification — COARSE buckets (city, area),
 * integer ₹ bands, year counts, closed enums, and short chips screened fail-closed by
 * `../common/job-content.schemas` with all three heuristics.
 */
const postingContentFields = {
  // COARSE city bucket (never an address). `location_label` stays the poster's free text.
  city: z.string().trim().min(1).max(80).optional(),
  // COARSE locality bucket (e.g. "Chakan"), never an address and never derived from
  // `location_label` — see the repository note that keeps that wall.
  area: areaSchema.optional(),
  pay_min: payAmountSchema.optional(),
  pay_max: payAmountSchema.optional(),
  // #1648 — what the band MEANS. No default: omitted stores NULL and the card shows the
  // band with no pay-type pill. The platform never guesses net-vs-gross.
  pay_type: payTypeSchema.optional(),
  min_experience_years: experienceYearsSchema.optional(),
  max_experience_years: experienceYearsSchema.optional(),
  shift: shiftSchema.optional(),
  needed_by: neededBySchema.optional(),
  // Worker-visible chips, shown VERBATIM (ADR-0024 final addendum) — screened with
  // looksLikePii + looksLikeOrgName + looksLikeUrl, capped at 12 items of 80 chars.
  benefits: benefitsSchema.optional(),
  requirements: requirementsSchema.optional(),
} as const;

/**
 * THE MATCHABLE HALF (ADR-0036). Distinct from `skills` above: that is ADR-0030 descriptive
 * free text and is explicitly never matched on; these are the match inputs.
 *
 * THE FINAL REACH SET IS NEVER A CLIENT INPUT. There is deliberately no `reach_skill_ids`
 * field: the server resolves it with `resolveReachSet`, which honours an untick only when
 * it names a SUGGESTED related skill and can never untick a POSTED one (Policy 10).
 *
 * NO `.max()` FROM THE CONFIG. The per-posting skill cap is `match_config
 * .max_skills_per_posting` — a runtime value — and a second copy here would disagree the
 * moment ops change it. `MatchSkillsService` enforces it and returns a 400; it never
 * truncates. The bounds below are anti-abuse ceilings, not the business rule.
 */
const matchSkillFields = {
  match_skill_ids: z.array(matchSkillId).min(1).max(50).optional(),
  unticked_related_ids: z.array(matchSkillId).max(200).optional(),
} as const;

/**
 * THE POSTING FIELDS A PATCH MAY UNSET (#1652).
 *
 * EVERY NAME HERE IS A NULLABLE COLUMN on `job_postings`, and that is the whole safety
 * property: `clear` can never reach a NOT NULL column because a NOT NULL column has no name
 * in this list. Note `city` IS here — `job_postings.city` is nullable — while the agency
 * contract's own list deliberately omits it, because `jobs.city` is NOT NULL. Same word,
 * different table, different answer.
 *
 * `benefits` / `requirements` are included even though an explicit `[]` already "clears"
 * them, because the two are NOT the same value: `[]` is "the poster stated no benefits" and
 * NULL is "the poster never said". Both jsonb columns have no DB default precisely so that
 * distinction survives, and the client renders them differently.
 *
 * DELIBERATELY ABSENT: `org_label`, `role_title`, `vacancy_band` and `status` (NOT NULL — a
 * posting with no role or no vacancy band is not a posting), and `match_skill_ids` /
 * `reach_skill_ids` / `unticked_related_ids`. The skill sets are NOT NULL `[]`-defaulted and
 * the reach set is server-resolved: emptying the posted skills is expressible as a normal
 * edit, and letting `clear` touch the RESOLVED set would be the Policy 10 hole again.
 */
const CLEARABLE_POSTING_FIELDS = [
  "location_label",
  "description",
  "city",
  "area",
  "pay_min",
  "pay_max",
  "pay_type",
  "min_experience_years",
  "max_experience_years",
  "shift",
  "needed_by",
  "benefits",
  "requirements",
] as const;
export type ClearablePostingField = (typeof CLEARABLE_POSTING_FIELDS)[number];
export { CLEARABLE_POSTING_FIELDS };

export const CreateJobPostingSchema = z
  .object({
    created_by: uuidSchema,
    org_label: orgLabel,
    role_title: roleTitle,
    location_label: locationLabel.optional(),
    description: description.optional(),
    vacancy_band: z.enum(VACANCY_BANDS).optional(),
    vacancies: vacancies.optional(),
    skills: skillsInput.optional(),
    // #1645/#1646/#1648 parity: the ops register creates the same entity the payer does,
    // so it accepts the same worker-visible content and the same match inputs. An ops
    // posting that could not carry a pay band or a reach set would be a second, thinner
    // create path — exactly the divergence that produced the original bug.
    ...postingContentFields,
    ...matchSkillFields,
  })
  .refine((o) => (o.vacancy_band !== undefined) !== (o.vacancies !== undefined), {
    message: "provide exactly one of vacancy_band or vacancies",
    path: ["vacancy_band"],
  })
  .refine(payBandOrdered, { message: "pay_max must be >= pay_min", path: ["pay_max"] })
  .refine(experienceWindowOrdered, {
    message: "max_experience_years must be >= min_experience_years",
    path: ["max_experience_years"],
  });
export type CreateJobPostingDto = z.infer<typeof CreateJobPostingSchema>;

/**
 * Payer self-serve create (ADR-0019 / ADR-0022 module 9). IDENTICAL to
 * {@link CreateJobPostingSchema} EXCEPT it has NO `created_by`: the owner/creator is
 * the verified SESSION payer (`req.payer.id`), stamped by the service — never a body
 * value (XB-A). Same "exactly one of vacancy_band | vacancies" intake rule.
 */
export const PayerCreateJobPostingSchema = z
  .object({
    org_label: orgLabel,
    role_title: roleTitle,
    location_label: locationLabel.optional(),
    description: description.optional(),
    vacancy_band: z.enum(VACANCY_BANDS).optional(),
    vacancies: vacancies.optional(),
    skills: skillsInput.optional(),
    // #1645/#1646/#1648 — the fields the payer app has been sending all along and Zod has
    // been stripping. See `postingContentFields` for why silently dropping them was a P0.
    ...postingContentFields,
    ...matchSkillFields,
  })
  .refine((o) => (o.vacancy_band !== undefined) !== (o.vacancies !== undefined), {
    message: "provide exactly one of vacancy_band or vacancies",
    path: ["vacancy_band"],
  })
  .refine(payBandOrdered, { message: "pay_max must be >= pay_min", path: ["pay_max"] })
  .refine(experienceWindowOrdered, {
    message: "max_experience_years must be >= min_experience_years",
    path: ["max_experience_years"],
  });
export type PayerCreateJobPostingDto = z.infer<typeof PayerCreateJobPostingSchema>;

/**
 * Edit a job posting and/or publish it (`draft -> open`). All free-text fields
 * and the vacancy band are optional; `status`, if present, may ONLY be `"open"`
 * (publish). Closing is a separate endpoint; any other status value is rejected
 * here. At least one field must be present.
 *
 * Vacancy may be edited EITHER as a pre-chosen `vacancy_band` OR as a raw
 * `vacancies` integer (intake-only; the service derives the band and discards the
 * number). Supplying both is ambiguous and rejected; supplying neither is fine
 * (vacancy is simply not part of this edit).
 */
export const UpdateJobPostingSchema = z
  .object({
    org_label: orgLabel.optional(),
    role_title: roleTitle.optional(),
    location_label: locationLabel.optional(),
    description: description.optional(),
    vacancy_band: z.enum(VACANCY_BANDS).optional(),
    vacancies: vacancies.optional(),
    skills: skillsInput.optional(),
    // Only "open" is a valid status transition via PATCH (publish a draft).
    status: z.literal("open").optional(),

    // The same two blocks the create schemas spread — see their definitions above. They
    // were declared inline here and NOWHERE ELSE until #1645; that asymmetry between the
    // create and update paths IS the bug this batch closes.
    ...postingContentFields,
    ...matchSkillFields,

    // #1652 — the fields a payer may UNSET. See `clearFieldSchema` for why this is a list
    // rather than an accepted `null`, and why a body that both sets and clears the same
    // field is a 400 rather than a precedence rule.
    clear: clearFieldSchema(CLEARABLE_POSTING_FIELDS),
  })
  .refine((o) => Object.values(o).some((v) => v !== undefined), {
    message: "no fields to update",
  })
  // #1652 — SET and CLEAR of the same field is a client bug, not a precedence puzzle.
  // Resolving it with a rule would mean one of the two things the payer asked for silently
  // did not happen; the 400 names the FIELD, never the value.
  .refine((o) => contradictoryClears(o as Record<string, unknown>, o.clear).length === 0, {
    message: "a field cannot be both set and cleared in one request",
    path: ["clear"],
  })
  .refine((o) => !(o.vacancy_band !== undefined && o.vacancies !== undefined), {
    message: "provide at most one of vacancy_band or vacancies",
    path: ["vacancy_band"],
  })
  // Both orderings are checked here only when BOTH ends arrive in the SAME patch; a
  // one-sided edit is validated against the STORED row in the service, which is the only
  // place that can see it.
  .refine(payBandOrdered, { message: "pay_max must be >= pay_min", path: ["pay_max"] })
  .refine(experienceWindowOrdered, {
    message: "max_experience_years must be >= min_experience_years",
    path: ["max_experience_years"],
  });
export type UpdateJobPostingDto = z.infer<typeof UpdateJobPostingSchema>;

/**
 * Optional `?status=` filter for the list endpoint (includes `paused` — B1, and
 * `suspended` — ADR-0037 Decision 1, so ops can find the postings a payer suspension
 * froze). Enumerated EXPLICITLY rather than derived from `JOB_POSTING_STATUSES`: this is
 * request input, and a status added to the shared const for storage reasons must not
 * silently become a queryable filter value.
 */
export const ListJobPostingsQuerySchema = z.object({
  status: z.enum(["draft", "open", "paused", "suspended", "closed"]).optional(),
});
export type ListJobPostingsQueryDto = z.infer<typeof ListJobPostingsQuerySchema>;
