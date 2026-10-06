import { z } from "zod";
import { TRADE_FORM_KINDS_ALL } from "@badabhai/types";
import {
  looksLikePii,
  workerVisibleTextScreens,
  type WorkerVisibleScreen,
} from "@badabhai/validators";

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
 * THE PLACE FIELDS RUN IT TOO (#1848): `area` (below) and each DTO's `city`, through
 * {@link screenWorkerVisiblePlace}. Same three heuristics, same messages, one narrow waiver:
 * an Indian pincode next to a sector or phase number is not a phone number (see
 * {@link workerVisiblePlaceScreens}).
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
 * never mapped to a skill or a `job_domain_id`. On the worker card as art only (2026-10-05). No default
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
  return screenWith("screenWorkerVisibleText", base, name, workerVisibleTextScreens);
}

/**
 * The shared body of the two exported screens. NOT exported: the list of heuristics is
 * `@badabhai/validators`' to own, and a caller able to pass its own could pass a weaker one.
 */
function screenWith(
  label: string,
  base: z.ZodString,
  name: ScreenedFieldName,
  screens: (s: string) => WorkerVisibleScreen[],
) {
  const max = base.maxLength;
  if (max === null) {
    throw new Error(`${label}: ${name.subject} needs a .max() on its base`);
  }
  if (base._def.checks.some((c) => c.kind === "toLowerCase" || c.kind === "toUpperCase")) {
    throw new Error(`${label}: ${name.subject} must not case-transform its base`);
  }
  return base.superRefine((s, ctx) => {
    if (s.length > max) return; // the base's .max() has already refused it
    for (const screen of screens(s)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: SCREEN_MESSAGES[screen](name) });
    }
  });
}

// A standalone six-digit Indian pincode (PIN codes never start with 0), bounded by whitespace,
// a comma or the ends of the value. NOT `\b`: that treats "@" and "." as boundaries, so it
// would find "411026" inside "hr@411026.xyz" and cutting it out would hide the email.
const PINCODE_TOKEN = /(^|[\s,])([1-9]\d{5})(?=$|[\s,])/;
// The shortest Indian phone number a worker could dial: a ten-digit mobile. A landline with
// its STD code is eleven.
const PHONE_MIN_DIGITS = 10;

/**
 * True when a pincode alone explains the contact-details refusal of a place value.
 *
 * `looksLikePii` strips spaces and dashes before it counts digits, so "Sector 63 201301"
 * reads as the eight-digit run "63201301" and is refused as a phone number. Measured over
 * the repository's city lists and 167 real industrial localities (#1848), every refused
 * place was a sector, phase or plot number followed by a pincode.
 *
 * ALL of these must hold, and each is fail-closed:
 *  - no "@" anywhere, so an email is never weighed against a pincode at all;
 *  - fewer than ten digits in the whole value, so no ten-digit mobile or eleven-digit
 *    landline can be present however it is split ("411026 9876543210" has sixteen);
 *  - a six-digit pincode standing alone between whitespace, commas or the value's ends;
 *  - `looksLikePii` passes once that pincode is replaced by a space.
 *
 * Under ten digits there is at most one such token, so replacing the first is replacing it.
 *
 * THE ACCEPTED RESIDUAL (security review, #1848): a seven- or eight-digit local landline
 * written with a six-digit group on its own ("Pune 24 567890") is waived. A bare six-digit
 * number was never refused by `looksLikePii` either, and before #1848 these fields had no
 * server screen at all.
 */
function pincodeExplainsContactRefusal(s: string): boolean {
  if (s.includes("@")) return false;
  if ((s.match(/\d/g)?.length ?? 0) >= PHONE_MIN_DIGITS) return false;
  const pincode = PINCODE_TOKEN.exec(s);
  if (!pincode) return false;
  const start = pincode.index + pincode[1]!.length;
  return !looksLikePii(`${s.slice(0, start)} ${s.slice(start + pincode[2]!.length)}`);
}

/**
 * THE PLACE-FIELD SCREEN (#1848): {@link workerVisibleTextScreens}, except that a
 * contact-details refusal a pincode alone explains is waived. The company-name and link
 * screens are unchanged, so "Co. Op. Industrial Estate" is still refused as a company name
 * (an accepted false positive; the hyphenated "Co-op" and "Co-operative" forms pass).
 */
export function workerVisiblePlaceScreens(s: string): WorkerVisibleScreen[] {
  const screens = workerVisibleTextScreens(s);
  if (!screens.includes("contact_details") || !pincodeExplainsContactRefusal(s)) return screens;
  return screens.filter((screen) => screen !== "contact_details");
}

/**
 * {@link screenWorkerVisibleText} for a worker-visible PLACE: a `city` or an `area`. Same
 * contract (the base's `.max()` is required, messages name the field), with
 * {@link workerVisiblePlaceScreens} as the screen.
 *
 * WRITE-SIDE ONLY, like every screen here. A row stored before #1848 keeps its value until a
 * write resends the field; a PATCH that omits `city` / `area` does not re-screen them.
 */
export function screenWorkerVisiblePlace(base: z.ZodString, name: ScreenedFieldName) {
  return screenWith("screenWorkerVisiblePlace", base, name, workerVisiblePlaceScreens);
}

/**
 * COARSE locality bucket (e.g. "Pimpri-Chinchwad"), never an address. Screened as a place
 * (#1848); the base is unchanged.
 */
export const areaSchema = screenWorkerVisiblePlace(z.string().min(1).max(AREA_MAX), {
  from: "the area",
  subject: "area",
});

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
