import { z } from "zod";
import { uuidSchema, looksLikePii } from "@badabhai/validators";
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
const TITLE_MAX = 200;
const CITY_MAX = 120;
const AREA_MAX = 120;

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
 * offending content.
 */
const title = z
  .string()
  .min(1)
  .max(TITLE_MAX)
  .refine((s) => !looksLikePii(s), { message: "remove contact details from the title" });

/** COARSE location — a city label (e.g. "Pune"), never an address. */
const city = z.string().min(1).max(CITY_MAX);
/** COARSE locality bucket (e.g. "Pimpri-Chinchwad"), never an address. Optional. */
const area = z.string().min(1).max(AREA_MAX);

/** Monthly pay band (INR, whole rupees — never paise). Non-negative. */
const payAmount = z.number().int().nonnegative();
/** Experience window (years). Non-negative. */
const experienceYears = z.number().int().nonnegative();
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
