import { z } from "zod";
import { uuidSchema, looksLikePii } from "@badabhai/validators";
import { VACANCY_BANDS } from "@badabhai/types";

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
  })
  .refine((o) => (o.vacancy_band !== undefined) !== (o.vacancies !== undefined), {
    message: "provide exactly one of vacancy_band or vacancies",
    path: ["vacancy_band"],
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
  })
  .refine((o) => (o.vacancy_band !== undefined) !== (o.vacancies !== undefined), {
    message: "provide exactly one of vacancy_band or vacancies",
    path: ["vacancy_band"],
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

    // ── Matching V1 (ADR-0036) — the MATCHABLE half of a posting ──────────────
    // `skills` above is ADR-0030's descriptive free-text tagging and is explicitly
    // NOT a match input. These are: `match_skill_ids` are the closed-set `mskill_*`
    // ids the company actually asks for (TIER 1 is membership of them), and
    // `unticked_related_ids` are the curated related skills it chose to drop.
    //
    // THE FINAL REACH SET IS NEVER A CLIENT INPUT. There is deliberately no
    // `reach_skill_ids` field here: the server resolves it with `resolveReachSet`,
    // which honours an untick only when it names a SUGGESTED related skill and can
    // never untick a POSTED one (Policy 10 — the platform never silently widens past
    // the curated relations, and the company never accidentally excludes the trade it
    // advertised).
    //
    // NO `.max()` ON THE SKILL LIST. The cap is `match_config.max_skills_per_posting`
    // — a runtime value — and hard-coding a second copy here would disagree with the
    // config the moment ops change it. `MatchSkillsService` enforces it and returns a
    // 400; it never truncates.
    match_skill_ids: z.array(matchSkillId).min(1).max(50).optional(),
    unticked_related_ids: z.array(matchSkillId).max(200).optional(),

    // The worker-visible display fields the SERVED entity gained in migration 0054.
    // PII-free by the schema's own classification: a COARSE city bucket (never an
    // address), an integer ₹ band (never an exact salary), two coarse enums.
    city: z.string().trim().min(1).max(80).optional(),
    pay_min: z.number().int().nonnegative().optional(),
    pay_max: z.number().int().nonnegative().optional(),
    shift: z.enum(["day", "night", "rotational"]).optional(),
    needed_by: z.enum(["immediate", "soon", "flexible"]).optional(),
  })
  .refine((o) => Object.values(o).some((v) => v !== undefined), {
    message: "no fields to update",
  })
  .refine((o) => !(o.vacancy_band !== undefined && o.vacancies !== undefined), {
    message: "provide at most one of vacancy_band or vacancies",
    path: ["vacancy_band"],
  })
  .refine((o) => o.pay_min === undefined || o.pay_max === undefined || o.pay_max >= o.pay_min, {
    message: "pay_max must be >= pay_min",
    path: ["pay_max"],
  });
export type UpdateJobPostingDto = z.infer<typeof UpdateJobPostingSchema>;

/** Optional `?status=` filter for the list endpoint (includes `paused` — B1). */
export const ListJobPostingsQuerySchema = z.object({
  status: z.enum(["draft", "open", "paused", "closed"]).optional(),
});
export type ListJobPostingsQueryDto = z.infer<typeof ListJobPostingsQuerySchema>;
