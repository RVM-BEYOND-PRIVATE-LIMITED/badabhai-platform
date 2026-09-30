import { jobRoleLabel } from "./job-roles";
import type { AgencyJob, JobPostingWire } from "./contracts";

/**
 * THE ONE JOB-CARD MAPPER — the lineage's single seam.
 *
 * A job card is drawn from EXACTLY the fields the posting form collected: the role, the place,
 * the ₹ band and what it means, the experience window, the shift, the needed-by chip, and the
 * requirement/benefit chip rows. {@link toJobCardView} is the ONLY function that turns those
 * collected {@link CardFields} into what the preview renders — so Create, Edit, View, the Card
 * preview and the Agency surfaces all agree by construction (one mapper, not five).
 *
 * The formatters are BYTE-FOR-BYTE ports of the worker app's own (`core/util/pay_format.dart`
 * + `core/util/job_display.dart`), so the payer's preview reads the same numbers, the same
 * "/mah" suffix, the same Hinglish needed-by copy, and the same "N Shift"/"N–M yrs experience"
 * wording the worker will see. An UNKNOWN enum value maps to null → the row is HIDDEN, never
 * echoed and never guessed (the worker-app rule).
 *
 * NOTHING WORKER-IDENTIFYING OR TRUST-CLAIMING crosses this seam. `org_label`, a verified seal,
 * a boost/urgency flag and a spots count are DELIBERATELY not fields of {@link CardFields} and
 * cannot map through — the preview is "built from what you entered", not a worker-facing trust
 * surface (ADR-0024 addendum, #1823).
 */

/**
 * The collected card fields, snake_case (the shared wire vocabulary). One entry per row the
 * card can draw — no `org_label`, no seal, no boost, no spots. `role_kind` is the payer's
 * picked role (display-only); everything else is the coarse, PII-free posting content.
 */
export interface CardFields {
  role_title: string | null;
  role_kind: string | null;
  city: string | null;
  area: string | null;
  pay_min: number | null;
  pay_max: number | null;
  pay_type: string | null;
  min_experience_years: number | null;
  max_experience_years: number | null;
  shift: string | null;
  needed_by: string | null;
  requirements: string[];
  benefits: string[];
}

/** One rendered chip: a coarse `kind` (for the key/icon) + the display `label`. */
export interface JobCardChip {
  kind: "shift" | "experience" | "needed_by" | "requirement" | "benefit";
  label: string;
}

/** Exactly what the card preview renders — derived, never re-derivable to anything worker-identifying. */
export interface JobCardView {
  /** The role title the payer typed (the card heading). Empty string when not yet entered. */
  title: string;
  /** The role label from `role_kind` (one of the 21), or null when off-set/unset. */
  roleLabel: string | null;
  /** City (+ area) as one line, or null when there is no city (row hidden). */
  place: string | null;
  /** The monthly band + the optional pay-type pill, or null when no band is stated (box hidden). */
  salary: { band: string; payTypePill: string | null } | null;
  /** The "Duty & Suvidhayein" chips, in card order: shift, experience, needed-by, requirements, benefits. */
  chips: JobCardChip[];
}

/* ── Formatters — BYTE-FOR-BYTE ports of the worker app ─────────────────────────── */

/**
 * Indian-style digit grouping: last three digits, then groups of two —
 * 16000 → "16,000", 125000 → "1,25,000". Ported from `formatIndianGrouped` (Dart).
 */
export function formatIndianGrouped(value: number): string {
  const digits = value.toString();
  if (digits.length <= 3) return digits;
  const parts: string[] = [digits.substring(digits.length - 3)];
  let rest = digits.substring(0, digits.length - 3);
  while (rest.length > 2) {
    parts.unshift(rest.substring(rest.length - 2));
    rest = rest.substring(0, rest.length - 2);
  }
  parts.unshift(rest);
  return parts.join(",");
}

/** A pay bound must be a non-negative rupee amount; anything else is treated as "not stated". */
function validBound(bound: number | null): number | null {
  return bound === null || bound < 0 ? null : bound;
}

/**
 * Full pay-band line, e.g. "₹16,000–26,000/mah" / "₹16,000/mah" / "₹16,000+/mah" /
 * "Up to ₹26,000/mah" / null (caller hides the box). The period token is '/mah', the SAME one
 * the worker's feed card and detail screen print. Ported from `formatPayBandFull` (Dart).
 */
export function formatPayBandFull(payMin: number | null, payMax: number | null): string | null {
  const min = validBound(payMin);
  const max = validBound(payMax);
  if (min !== null && max !== null) {
    if (min === max) return `₹${formatIndianGrouped(min)}/mah`;
    return `₹${formatIndianGrouped(min)}–${formatIndianGrouped(max)}/mah`;
  }
  if (min !== null) return `₹${formatIndianGrouped(min)}+/mah`;
  if (max !== null) return `Up to ₹${formatIndianGrouped(max)}/mah`;
  return null;
}

/**
 * What the pay band MEANS (#1648): 'in_hand' → 'IN-HAND', 'gross' → 'GROSS', 'ctc' → 'CTC';
 * anything else — including the very common null — → null (no pay-type pill). Ported from
 * `payTypeLabel` (Dart) — an unrecognised value is never echoed.
 */
export function payTypeLabel(payType: string | null): string | null {
  switch (payType) {
    case "in_hand":
      return "IN-HAND";
    case "gross":
      return "GROSS";
    case "ctc":
      return "CTC";
    default:
      return null;
  }
}

/**
 * 'day' → 'Day', 'night' → 'Night', 'rotational' → 'Rotational'; anything else → null. The card
 * appends " Shift" to this base word (e.g. "Day Shift"). Ported from `shiftLabel` (Dart).
 */
export function shiftLabel(shift: string | null): string | null {
  switch (shift) {
    case "day":
      return "Day";
    case "night":
      return "Night";
    case "rotational":
      return "Rotational";
    default:
      return null;
  }
}

/**
 * The experience window as one honest line: "2–5 yrs experience" / "3 yrs experience" /
 * "5+ yrs experience" / "Up to 5 yrs experience" / null (caller hides the row). Ported from
 * `experienceLabel` (Dart).
 */
export function experienceLabel(
  minYears: number | null,
  maxYears: number | null,
): string | null {
  const min = minYears !== null && minYears >= 0 ? minYears : null;
  const max = maxYears !== null && maxYears >= 0 ? maxYears : null;
  if (min !== null && max !== null) {
    if (min === max) return `${min} yrs experience`;
    return `${min}–${max} yrs experience`;
  }
  if (min !== null) return `${min}+ yrs experience`;
  if (max !== null) return `Up to ${max} yrs experience`;
  return null;
}

/**
 * Hinglish urgency copy for `needed_by`: 'immediate' → 'Turant chahiye', 'soon' → 'Jaldi
 * chahiye', 'flexible' → 'Flexible'; anything else → null. Ported from `neededByLabel` (Dart).
 */
export function neededByLabel(neededBy: string | null): string | null {
  switch (neededBy) {
    case "immediate":
      return "Turant chahiye";
    case "soon":
      return "Jaldi chahiye";
    case "flexible":
      return "Flexible";
    default:
      return null;
  }
}

/** City (+ optional area) as one place line, or null when there is no city (row hidden). */
function placeLabel(city: string | null, area: string | null): string | null {
  const c = (city ?? "").trim();
  if (c === "") return null;
  const a = (area ?? "").trim();
  return a === "" ? c : `${c}, ${a}`;
}

/**
 * THE ONE MAPPER. Collected {@link CardFields} → the {@link JobCardView} the preview renders.
 * Unknown enum values collapse to null (the row/box/pill is hidden). `roleLabel` uses
 * `jobRoleLabel`, which returns null for anything that is not one of the 21 (never echoes a raw id).
 */
export function toJobCardView(fields: CardFields): JobCardView {
  const chips: JobCardChip[] = [];

  const shift = shiftLabel(fields.shift);
  if (shift !== null) chips.push({ kind: "shift", label: `${shift} Shift` });

  const exp = experienceLabel(fields.min_experience_years, fields.max_experience_years);
  if (exp !== null) chips.push({ kind: "experience", label: exp });

  const needed = neededByLabel(fields.needed_by);
  if (needed !== null) chips.push({ kind: "needed_by", label: needed });

  for (const req of fields.requirements) {
    const label = req.trim();
    if (label !== "") chips.push({ kind: "requirement", label });
  }
  for (const ben of fields.benefits) {
    const label = ben.trim();
    if (label !== "") chips.push({ kind: "benefit", label });
  }

  const band = formatPayBandFull(fields.pay_min, fields.pay_max);

  return {
    title: fields.role_title ?? "",
    roleLabel: jobRoleLabel(fields.role_kind),
    place: placeLabel(fields.city, fields.area),
    salary: band === null ? null : { band, payTypePill: payTypeLabel(fields.pay_type) },
    chips,
  };
}

/* ── Adapters — wire → CardFields (the ONLY entry points to {@link toJobCardView}) ── */

/**
 * The EMPLOYER posting wire row → {@link CardFields}. The posting wire is snake_case already, so
 * this normalizes nullability only. `org_label` / `payer_id` / `created_by` are on the wire but
 * DELIBERATELY not read — they can never reach the card.
 */
export function cardFieldsFromPostingWire(wire: JobPostingWire): CardFields {
  return {
    role_title: wire.role_title ?? null,
    role_kind: wire.role_kind ?? null,
    city: wire.city ?? null,
    area: wire.area ?? null,
    pay_min: wire.pay_min ?? null,
    pay_max: wire.pay_max ?? null,
    pay_type: wire.pay_type ?? null,
    min_experience_years: wire.min_experience_years ?? null,
    max_experience_years: wire.max_experience_years ?? null,
    shift: wire.shift ?? null,
    needed_by: wire.needed_by ?? null,
    requirements: wire.requirements ?? [],
    benefits: wire.benefits ?? [],
  };
}

/**
 * The AGENCY job wire (camelCase) → {@link CardFields} (snake_case). `tradeKey` is the agency's
 * MATCHING classifier and is NOT a card field — the card's role is `roleKind` (display-only).
 */
export function cardFieldsFromAgencyJob(job: AgencyJob): CardFields {
  return {
    role_title: job.title,
    role_kind: job.roleKind ?? null,
    city: job.city,
    area: job.area,
    pay_min: job.payMin,
    pay_max: job.payMax,
    pay_type: job.payType ?? null,
    min_experience_years: job.minExperienceYears,
    max_experience_years: job.maxExperienceYears,
    shift: job.shift ?? null,
    needed_by: job.neededBy,
    requirements: job.requirements ?? [],
    benefits: job.benefits ?? [],
  };
}
