import { z } from "zod";
import { TRADE_FORM_KINDS_ALL } from "@badabhai/types";
import { workerVisibleTextScreens, type WorkerVisibleScreen } from "@badabhai/validators";

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
 * SCREENED FAIL-CLOSED WITH THREE HEURISTICS, through {@link screenWorkerVisibleText}:
 * `looksLikePii` (phone/email shapes), `looksLikeOrgName` (legal-entity suffixes —
 * `looksLikePii` is documented as NOT catching employer names) and `looksLikeUrl`. The
 * benefit/requirement chips here run it, and so do the agency `title` / `description` and
 * the posting `role_title` / `description`. A phone number or a "Pvt Ltd"-style name typed
 * into any of those is rejected with a clear 400 and never stored. Every message names the
 * FIELD, never the offending content: an error body that echoed the text back would be the
 * leak the refusal just prevented.
 *
 * NOT SCREENED AT THE SERVER, though a worker sees both verbatim: `area` (below) and each
 * DTO's `city`. ADR-0024's guard names title, description, benefits and tags; payer-web
 * screens city and area client-side only. Screening them here, and keeping a pincode legal
 * if so, is an open follow-up from the #1823 B3 review, not a gap this file closes.
 *
 * ONE LIST OF HEURISTICS. `workerVisibleTextScreens` in `@badabhai/validators` is the list;
 * this file only maps each screen to its field-naming message, and the D4 seed-job converter
 * and the seed scripts call the same list. B3 (#1823) is what one copy per field produced: a
 * posting `role_title` with no screen at all, and a posting `description` with one heuristic
 * of three, while the agency fields they mirror had all three. Search and job detail served
 * that gap to workers.
 *
 * DELIBERATELY NOT HERE: the BASE SHAPE of `title` / `role_title` / `description`
 * (length caps, `.trim()`) and the `org_label` / `location_label` fields. Those stay in
 * each DTO. A payer-company posting's `org_label` IS the company's own name and is never
 * screened, and only the agency description trims, so folding the bases together would
 * silently change what a shipped route stores.
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

/**
 * THE POSTING'S ROLE (migration 0131) — one of the 21 DECLARED worker-side kinds
 * (`TRADE_FORM_KINDS_ALL`). Closed and PII-free, so it needs no heuristic screen.
 *
 * DISPLAY / CLASSIFICATION ONLY (ADR-0036 addendum 2026-09-29): never a match or rank input,
 * never mapped to a skill or a `job_domain_id`, and on no worker read this phase. No default
 * and no inference — omitted stores NULL ("no role picked"). A `null` in a body is a 400 like
 * every other field here; unsetting goes through `clear: ["role_kind"]` (#1652).
 *
 * ALL 21, NOT THE 16 WITH A WORKER FORM: whether a worker-side form exists is a profiling
 * concern, and the owner ruled every declared role postable.
 */
export const roleKindSchema = z.enum(TRADE_FORM_KINDS_ALL);

/**
 * How a refusal NAMES its field. `from` completes "remove contact details from …" and
 * `subject` opens "… must not contain a company name" / "… must not contain links". Both
 * are static per field, so a message never carries the offending value.
 */
export interface ScreenedFieldName {
  readonly from: string;
  readonly subject: string;
}

/**
 * One message per screen. EXHAUSTIVE over `WorkerVisibleScreen`, so a heuristic added to
 * `workerVisibleTextScreens` fails the typecheck here until it has a message.
 */
const SCREEN_MESSAGES: Readonly<Record<WorkerVisibleScreen, (n: ScreenedFieldName) => string>> = {
  contact_details: (n) => `remove contact details from ${n.from}`,
  company_name: (n) => `${n.subject} must not contain a company name`,
  link: (n) => `${n.subject} must not contain links`,
};

/**
 * THE ADR-0024 WORKER-VISIBLE FREE-TEXT SCREEN: every screen `workerVisibleTextScreens`
 * reports (`looksLikePii`, then `looksLikeOrgName`, then `looksLikeUrl`) is a fail-closed
 * 400 that names the field. A value that trips two heuristics reports both, in that order.
 *
 * It takes the BASE schema rather than building one, because the base is the part that
 * legitimately differs per surface (see the header). Apply it to a field shown verbatim to
 * a worker. A field that is not, such as a posting's `org_label`, must not use it.
 *
 * THE SCREEN NEVER RUNS ON UNBOUNDED TEXT (#1924). Zod 3 still runs a refine after `.max()`
 * has failed, so the cap alone did not bound the heuristics: only the JSON body limit did.
 * A value longer than the base's `.max()` is already refused by the base, so it is not
 * screened at all. That makes `.max()` load-bearing, and the base is checked when the
 * schema is built: no `.max()` throws, and so does a case transform, which can lengthen a
 * value after its `.max()` has passed ("ß" upper-cases to "SS"). `.trim()` only shortens.
 */
export function screenWorkerVisibleText(base: z.ZodString, name: ScreenedFieldName) {
  const max = base.maxLength;
  if (max === null) {
    throw new Error(`screenWorkerVisibleText: ${name.subject} needs a .max() on its base`);
  }
  if (base._def.checks.some((c) => c.kind === "toLowerCase" || c.kind === "toUpperCase")) {
    throw new Error(`screenWorkerVisibleText: ${name.subject} must not case-transform its base`);
  }
  return base.superRefine((s, ctx) => {
    if (s.length > max) return; // the base's .max() has already refused it
    for (const screen of workerVisibleTextScreens(s)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: SCREEN_MESSAGES[screen](name) });
    }
  });
}

/** One short worker-visible benefit chip (e.g. "PF + ESI") — all three heuristics apply. */
const benefitItem = screenWorkerVisibleText(z.string().trim().min(1).max(LIST_ITEM_MAX), {
  from: "benefits",
  subject: "benefits",
});

/** One short worker-visible requirement tag (e.g. "Fanuc control") — all three apply. */
const requirementItem = screenWorkerVisibleText(z.string().trim().min(1).max(LIST_ITEM_MAX), {
  from: "requirements",
  subject: "requirements",
});

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
