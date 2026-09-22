import { z } from "zod";
import { looksLikePii, looksLikeOrgName, looksLikeUrl } from "@badabhai/validators";

/**
 * THE WORKER-VISIBLE JOB-CONTENT FIELD SCHEMAS — one copy, two demand surfaces.
 *
 * These are the fields shown VERBATIM to a worker on the job card / detail: the coarse
 * locality bucket, the experience window, the pay-type claim, and the benefit/requirement
 * chips. `apps/api/src/agency/agency.dto.ts` ratified them first (ADR-0024 final addendum,
 * 2026-07-16); issue #1646 needed the SAME fields on the payer-company job-posting routes,
 * and a second copy of a PII screen is a copy that drifts — the day one file gains a
 * heuristic and the other does not is the day the weaker surface becomes the leak. So the
 * definitions moved here and both DTO files import them.
 *
 * SCREENED FAIL-CLOSED WITH BOTH HEURISTICS. Every free-text surface here runs
 * `looksLikePii` (phone/email shapes), `looksLikeOrgName` (legal-entity suffixes —
 * `looksLikePii` is documented as NOT catching employer names) and `looksLikeUrl`. A
 * phone number or a "Pvt Ltd"-style name typed into any of them is rejected with a clear
 * 400 and never stored. Every message names the FIELD, never the offending content: an
 * error body that echoed the text back would be the leak the refusal just prevented.
 *
 * DELIBERATELY NOT HERE: `title` / `role_title` / `org_label` / `location_label` and the
 * job-postings `description`. Those carry surface-specific rules that differ between the
 * two DTOs on purpose — a payer-company posting's `org_label` IS the company's own name,
 * while an agency `title` must never contain one — and folding them together would
 * silently retighten or loosen a shipped validator.
 */

// Length caps (chars). `area` is a short bucket label; benefits/requirements are SHORT
// worker-visible chips. Values are the agency file's, carried across unchanged.
const AREA_MAX = 120;
const LIST_ITEM_MAX = 80; // one benefits/requirements chip
const LIST_ITEMS_MAX = 12; // per list

/**
 * Numeric ceilings (C10 — anti-abuse / overflow guards, NOT business rules). A sane upper
 * bound stops absurd values (INT overflow, a fat-fingered ₹999999999, a 1000-year career)
 * at the boundary. MUST stay in parity with payer-web `agencyJobInputSchema`
 * (apps/payer-web/src/lib/contracts.ts) — same VALUES.
 */
export const PAY_MAX_INR = 10_000_000; // ₹/month sanity ceiling (₹1 crore)
export const EXPERIENCE_MAX_YEARS = 60; // a plausible career length ceiling

/** COARSE locality bucket (e.g. "Pimpri-Chinchwad"), never an address. */
export const areaSchema = z.string().min(1).max(AREA_MAX);

/** Monthly pay band (INR, whole rupees — never paise). Non-negative, bounded. */
export const payAmountSchema = z.number().int().nonnegative().max(PAY_MAX_INR);

/** Experience window (years). Non-negative, bounded. */
export const experienceYearsSchema = z.number().int().nonnegative().max(EXPERIENCE_MAX_YEARS);

/** Coarse shift enum for the worker-visible job card — mirrors db.JobShift. Non-PII. */
export const shiftSchema = z.enum(["day", "night", "rotational"]);

/** When the job needs someone (coarse enum) — mirrors db.JobNeededBy. Non-PII. */
export const neededBySchema = z.enum(["immediate", "soon", "flexible"]);

/**
 * WHAT THE PAY BAND MEANS (#1648) — mirrors db.JobPayType. Coarse, closed, non-PII.
 *
 * There is NO default and no inference. A posting that omits this stores NULL, and the
 * worker card then renders the band with no pay-type pill. The platform states only what
 * a poster actually told it: "kitna haath me aayega" is the worker's first question, and
 * a guessed answer is worse than none.
 */
export const payTypeSchema = z.enum(["in_hand", "gross", "ctc"]);

/** One short worker-visible benefit chip (e.g. "PF + ESI") — all three heuristics apply. */
const benefitItem = z
  .string()
  .trim()
  .min(1)
  .max(LIST_ITEM_MAX)
  .refine((s) => !looksLikePii(s), { message: "remove contact details from benefits" })
  .refine((s) => !looksLikeOrgName(s), { message: "benefits must not contain a company name" })
  .refine((s) => !looksLikeUrl(s), { message: "benefits must not contain links" });

/** One short worker-visible requirement tag (e.g. "Fanuc control") — all three apply. */
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

export const benefitsSchema = z.array(benefitItem).max(LIST_ITEMS_MAX);
export const requirementsSchema = z.array(requirementItem).max(LIST_ITEMS_MAX);

/**
 * `pay_max >= pay_min` when BOTH are supplied. A one-sided edit is validated against the
 * STORED value in the service — a schema cannot see the row it is patching.
 */
export function payBandOrdered(o: { pay_min?: number; pay_max?: number }): boolean {
  return o.pay_min === undefined || o.pay_max === undefined || o.pay_max >= o.pay_min;
}

/** `max_experience_years >= min_experience_years` when BOTH are supplied. Same caveat. */
export function experienceWindowOrdered(o: {
  min_experience_years?: number;
  max_experience_years?: number;
}): boolean {
  return (
    o.min_experience_years === undefined ||
    o.max_experience_years === undefined ||
    o.max_experience_years >= o.min_experience_years
  );
}
