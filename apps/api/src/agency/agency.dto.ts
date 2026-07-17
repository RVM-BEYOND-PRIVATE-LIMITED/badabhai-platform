import { z } from "zod";
import { uuidSchema, looksLikePii, looksLikeOrgName, looksLikeUrl } from "@badabhai/validators";
import { REQUIRED_TRADE_KEYS } from "../resume/trade-content";

/**
 * DTOs for the Agency Supply Portal demand slice (ADR-0022). Every field here is a
 * COARSE, non-PII demand attribute on the faceless `jobs` row: a trade key, a generic
 * role title, a city/area label, integer ₹ pay bands, year counts, and a coarse timing
 * enum. There is NEVER an employer name, an address, or any worker identity — those are
 * not demand attributes and have no field here by construction.
 *
 * The `payer_id` (tenant owner) is NEVER a DTO field — it is taken from the verified
 * session (XB-A) and stamped server-side. A body/param payer id is impossible to supply.
 */

// Length caps (chars). title/city/area are short labels — never long free text.
// DESCRIPTION_MAX mirrors the ops job-postings precedent (job-postings.dto.ts:
// same value, same "oversize input never reaches the table" posture); benefits/
// requirements are SHORT worker-visible chips, so their caps are much tighter.
const TITLE_MAX = 200;
const CITY_MAX = 120;
const AREA_MAX = 120;
const DESCRIPTION_MAX = 2000;
const LIST_ITEM_MAX = 80; // one benefits/requirements chip
const LIST_ITEMS_MAX = 12; // per list

// Numeric ceilings (C10 — anti-abuse / overflow guards, NOT business rules). A sane upper
// bound stops absurd values (e.g. INT overflow, a fat-fingered ₹999999999, 1000-year
// experience) at the boundary. MUST stay in parity with payer-web
// `agencyJobInputSchema` (apps/payer-web/src/lib/contracts.ts) — same VALUES.
const PAY_MAX_INR = 10_000_000; // ₹/month sanity ceiling (₹1 crore — far above any real wage band)
const EXPERIENCE_MAX_YEARS = 60; // a plausible career length ceiling

/**
 * The trade key MUST be one of the ratified manufacturing alpha trades (the same set the
 * Reach core + resume content recognize). An enum (not free text) → a job can never carry
 * an arbitrary string that might smuggle PII, and the `jobs.trade_key` taxonomy link stays
 * valid. Hospitality keys are drafted-not-live (schema note) so they are intentionally not
 * accepted here yet.
 */
const tradeKeySchema = z.enum(REQUIRED_TRADE_KEYS);

/**
 * Generic role title (e.g. "CNC Operator — Night Shift"). NEVER an employer name (the
 * ADR-0009 §2 / ADR-0022 privacy line). PII-heuristic screened (defense-in-depth): a
 * phone/email in this human-typed field is a real leak risk; we name the field, never the
 * offending content. ADR-0024 final addendum (2026-07-16): the title is worker-visible,
 * so the legal-entity-suffix heuristic (`looksLikeOrgName`) also applies — a "Pvt
 * Ltd"-style name typed here is rejected with a clear 400, never stored.
 */
const title = z
  .string()
  .min(1)
  .max(TITLE_MAX)
  .refine((s) => !looksLikePii(s), { message: "remove contact details from the title" })
  .refine((s) => !looksLikeOrgName(s), { message: "title must not contain a company name" })
  .refine((s) => !looksLikeUrl(s), { message: "title must not contain links" });

/** COARSE location — a city label (e.g. "Pune"), never an address. */
const city = z.string().min(1).max(CITY_MAX);
/** COARSE locality bucket (e.g. "Pimpri-Chinchwad"), never an address. Optional. */
const area = z.string().min(1).max(AREA_MAX);

/**
 * Worker-visible free text (ADR-0024 final addendum, 2026-07-16): description +
 * benefits/requirements chips are shown VERBATIM to workers on the job card/detail, so
 * EVERY free-text surface is screened fail-closed at this write boundary with BOTH
 * heuristics — `looksLikePii` (phone/email shapes) AND `looksLikeOrgName` (legal-entity
 * suffixes; `looksLikePii` is documented as NOT catching employer names). A phone number
 * or a "Pvt Ltd"-style name typed into any of these is rejected with a clear 400, never
 * stored. Per-field messages name the FIELD, never the offending content.
 */
const description = z
  .string()
  .trim()
  .min(1)
  .max(DESCRIPTION_MAX)
  .refine((s) => !looksLikePii(s), { message: "remove contact details from the description" })
  .refine((s) => !looksLikeOrgName(s), {
    message: "description must not contain a company name",
  })
  .refine((s) => !looksLikeUrl(s), { message: "description must not contain links" });

/** Coarse shift enum for the worker-visible job card — mirrors db.JobShift. Non-PII. */
const shift = z.enum(["day", "night", "rotational"]);

/** One short worker-visible benefit chip (e.g. "PF + ESI") — both heuristics apply. */
const benefitItem = z
  .string()
  .trim()
  .min(1)
  .max(LIST_ITEM_MAX)
  .refine((s) => !looksLikePii(s), { message: "remove contact details from benefits" })
  .refine((s) => !looksLikeOrgName(s), { message: "benefits must not contain a company name" })
  .refine((s) => !looksLikeUrl(s), { message: "benefits must not contain links" });

/** One short worker-visible requirement tag (e.g. "Fanuc control") — both heuristics apply. */
const requirementItem = z
  .string()
  .trim()
  .min(1)
  .max(LIST_ITEM_MAX)
  .refine((s) => !looksLikePii(s), { message: "remove contact details from requirements" })
  .refine((s) => !looksLikeOrgName(s), {
    message: "requirements must not contain a company name",
  })
  .refine((s) => !looksLikeUrl(s), { message: "requirements must not contain links" });

const benefits = z.array(benefitItem).max(LIST_ITEMS_MAX);
const requirements = z.array(requirementItem).max(LIST_ITEMS_MAX);

/** Monthly pay band (INR, whole rupees — never paise). Non-negative, bounded (anti-abuse). */
const payAmount = z.number().int().nonnegative().max(PAY_MAX_INR);
/** Experience window (years). Non-negative, bounded (anti-abuse). */
const experienceYears = z.number().int().nonnegative().max(EXPERIENCE_MAX_YEARS);
/** When the job needs someone (coarse enum) — mirrors db.JobNeededBy. */
const neededBy = z.enum(["immediate", "soon", "flexible"]);

/**
 * Create an OWNED job. `payer_id` is NOT here (session-derived, XB-A). `status` is NOT
 * accepted — every job starts `open` (the service hard-codes it). Pay/experience are
 * supplied as bands and validated for ordering (max >= min) here at the boundary.
 */
export const CreateAgencyJobSchema = z
  .object({
    trade_key: tradeKeySchema,
    title,
    city,
    area: area.optional(),
    pay_min: payAmount.optional(),
    pay_max: payAmount.optional(),
    min_experience_years: experienceYears.optional(),
    max_experience_years: experienceYears.optional(),
    needed_by: neededBy.optional(),
    description: description.optional(),
    shift: shift.optional(),
    benefits: benefits.optional(),
    requirements: requirements.optional(),
  })
  .refine((o) => o.pay_min === undefined || o.pay_max === undefined || o.pay_max >= o.pay_min, {
    message: "pay_max must be >= pay_min",
    path: ["pay_max"],
  })
  .refine(
    (o) =>
      o.min_experience_years === undefined ||
      o.max_experience_years === undefined ||
      o.max_experience_years >= o.min_experience_years,
    { message: "max_experience_years must be >= min_experience_years", path: ["max_experience_years"] },
  );
export type CreateAgencyJobDto = z.infer<typeof CreateAgencyJobSchema>;

/**
 * Edit an OWNED job. All fields optional; at least one must be present. `status` is NOT
 * editable here (close/pause are dedicated endpoints). Pay/experience ordering is checked
 * only when BOTH ends of a range are supplied in the same patch (a one-sided edit is
 * validated against the stored value in the service).
 */
export const UpdateAgencyJobSchema = z
  .object({
    trade_key: tradeKeySchema.optional(),
    title: title.optional(),
    city: city.optional(),
    area: area.optional(),
    pay_min: payAmount.optional(),
    pay_max: payAmount.optional(),
    min_experience_years: experienceYears.optional(),
    max_experience_years: experienceYears.optional(),
    needed_by: neededBy.optional(),
    description: description.optional(),
    shift: shift.optional(),
    benefits: benefits.optional(),
    requirements: requirements.optional(),
  })
  .refine((o) => Object.values(o).some((v) => v !== undefined), {
    message: "no fields to update",
  })
  .refine((o) => o.pay_min === undefined || o.pay_max === undefined || o.pay_max >= o.pay_min, {
    message: "pay_max must be >= pay_min",
    path: ["pay_max"],
  })
  .refine(
    (o) =>
      o.min_experience_years === undefined ||
      o.max_experience_years === undefined ||
      o.max_experience_years >= o.min_experience_years,
    { message: "max_experience_years must be >= min_experience_years", path: ["max_experience_years"] },
  );
export type UpdateAgencyJobDto = z.infer<typeof UpdateAgencyJobSchema>;

/** Route param `:jobId` — must be a UUID. */
export const AgencyJobIdParamSchema = z.object({ jobId: uuidSchema });
export type AgencyJobIdParam = z.infer<typeof AgencyJobIdParamSchema>;

/**
 * Mint an OWNED invite. NO phone / name / email / worker id input (faceless): the only
 * optional input is a non-PII campaign tag (a short, screened code). `inviter_payer_id`
 * is session-derived (XB-A), never a field.
 */
export const CreateAgencyInviteSchema = z.object({
  campaign: z
    .string()
    .min(1)
    .max(64)
    .refine((s) => !looksLikePii(s), { message: "campaign must be a non-PII tag" })
    .optional(),
});
export type CreateAgencyInviteDto = z.infer<typeof CreateAgencyInviteSchema>;

/**
 * Route param `:code` for the click attribution. An opaque token, bounded length — a
 * lowercase hex slug (the mint format). Neutral on any unknown code (no-oracle), so a
 * shape mismatch is treated identically to an unknown code by the controller.
 */
export const AgencyInviteCodeParamSchema = z.object({
  code: z.string().min(1).max(64),
});
export type AgencyInviteCodeParam = z.infer<typeof AgencyInviteCodeParamSchema>;
