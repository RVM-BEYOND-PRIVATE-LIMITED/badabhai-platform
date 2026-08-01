import { z } from "zod";
import {
  uuidSchema,
  looksLikePii,
  looksLikeActionContextPii,
  looksLikeOrgName,
  looksLikeUrl,
} from "@badabhai/validators";
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

/** Max chars for the campaign tag — a short label, never narrative free text. */
const CAMPAIGN_MAX = 64;

/**
 * SERVER-side ceiling on one batch mint (ADR-0022 Amendment 3, condition C2). A named
 * constant, NOT a config value: raising it is a code change that goes through review,
 * because the batch size is the amplification factor on every downstream write (rows,
 * events, live invite codes). The browser control is irrelevant — this is the only limit.
 */
export const AGENCY_INVITE_BATCH_MAX = 50;

/**
 * The optional, non-PII CAMPAIGN tag shared by the singular and batch mints.
 *
 * Screened with `looksLikeActionContextPii`, NOT the looser `looksLikePii` (ADR-0022
 * Amendment 3, condition C9 — a MEDIUM pre-existing gap tightened here): `looksLikePii`
 * catches only email shapes and phone digit runs, so a personal NAME ("Ramesh Kumar")
 * passed it — and `campaign` is written to `agency_invites.campaign` AND emitted in the
 * `agency_invite.created` payload, which is an invariant-#2 sink (events). Batch minting
 * multiplies this field's reach by up to {@link AGENCY_INVITE_BATCH_MAX} per call and
 * makes per-person tagging the tempting workflow, so the stricter screen (which adds the
 * human-name / address shapes) applies. This is exactly the short non-narrative label
 * class `looksLikeActionContextPii` was written for.
 *
 * PARITY NOTE: the payer-web mirrors (`invite-actions.ts`, `invite-panel.tsx`) must be
 * tightened to match — tracked as the frontend half of the same condition.
 */
const campaignTag = z
  .string()
  .min(1)
  .max(CAMPAIGN_MAX)
  .refine((s) => !looksLikeActionContextPii(s), { message: "campaign must be a non-PII tag" });

/**
 * Mint an OWNED invite. NO phone / name / email / worker id input (faceless): the only
 * optional input is a non-PII campaign tag (a short, screened code). `inviter_payer_id`
 * is session-derived (XB-A), never a field.
 *
 * `.strict()` (parity with the batch schema): an attempted `{phone}`/`{worker_id}` key is
 * a LOUD 400 rather than a silently stripped key. Same data outcome, auditable attempt.
 */
export const CreateAgencyInviteSchema = z
  .object({
    campaign: campaignTag.optional(),
  })
  .strict();
export type CreateAgencyInviteDto = z.infer<typeof CreateAgencyInviteSchema>;

/**
 * BATCH mint (ADR-0022 Amendment 3). THIS SCHEMA IS THE ENTIRE SECURITY BOUNDARY between
 * this feature and the DEAD module-2 "bulk worker/candidate upload".
 *
 * The distinction is the DIRECTION and REFERENT of the data, not the count:
 *  - Bulk upload is INBOUND and has ARITY OVER PEOPLE — the agency asserts a list of real,
 *    existing, non-consented individuals and the platform ingests contactable identifiers
 *    for them. Invariant #6 cannot even be evaluated, because the processing already
 *    happened at ingest. That is why it is DEAD, with no gate that revives it.
 *  - Batch mint is OUTBOUND and REFERENT-FREE — the platform GENERATES N cryptographically
 *    random opaque bearer codes. Each row denotes nothing and nobody (`invited_worker_id`
 *    is NULL and writable only by the consent-gated internal seam). The agency's entire
 *    contribution is ONE INTEGER plus ONE optional non-PII tag. Fifty random tokens are a
 *    CARDINALITY, not a list.
 *
 * Therefore the body is CARDINALITY-SHAPED and `.strict()`:
 *  - NO array-typed property may ever be added here. `labels[]`, `recipients[]`,
 *    `invitees[]`, `notes[]`, `names[]`, `phones[]`, `for[]`, `contacts[]` — any of them
 *    re-introduces arity over people, flips the direction to inbound, and makes this bulk
 *    upload with a weaker identifier.
 *  - NO delivery field (`to`, `phone`, `msisdn`, `email`). Delivery stays OUT-OF-BAND: the
 *    agency shares the links itself. The platform sends nothing (condition C8).
 *  - `.strict()` rather than zod's default strip, so an attempted list is a loud, auditable
 *    400 instead of a silently dropped key — the boundary must be self-documenting to the
 *    next engineer who reads this endpoint.
 *
 * `campaign` is ONE SCALAR applied identically to all N invites. It can never be
 * per-invite (that is the `labels[]` violation above, wearing a different name).
 */
export const CreateAgencyInviteBatchSchema = z
  .object({
    // Bounded server-side: non-integer, negative, zero, NaN, Infinity, string-coerced and
    // over-ceiling values are all rejected AT THE BOUNDARY, never normalized downstream.
    // An unbounded/client-trusted count would turn one authenticated request into an
    // unbounded row-insert + event-emit amplifier, and would defeat the cap reservation
    // before it is even reached.
    count: z.number().int().min(1).max(AGENCY_INVITE_BATCH_MAX),
    campaign: campaignTag.optional(),
  })
  .strict();
export type CreateAgencyInviteBatchDto = z.infer<typeof CreateAgencyInviteBatchSchema>;

/**
 * Route param `:code` for the click attribution. An opaque token, bounded length — a
 * lowercase hex slug (the mint format). Neutral on any unknown code (no-oracle), so a
 * shape mismatch is treated identically to an unknown code by the controller.
 */
export const AgencyInviteCodeParamSchema = z.object({
  code: z.string().min(1).max(64),
});
export type AgencyInviteCodeParam = z.infer<typeof AgencyInviteCodeParamSchema>;
