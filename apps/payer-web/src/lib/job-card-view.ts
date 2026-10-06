import type { AgencyJob, JobPostingWire } from "./contracts";

/**
 * THE ONE JOB-CARD MAPPER — the lineage's single seam.
 *
 * THE REFERENCE IS THE WORKER'S PHONE. The card a worker swipes on the Jobs tab is
 * `Design1JobCard` (apps/worker-app/lib/features/swipe/presentation/widgets/design1_job_card.dart),
 * fed by `_cardData` in `swipe_jobs_screen.dart`. It draws, top to bottom and nothing else:
 *   1. the title (`role_title`, 2 lines + ellipsis, a chevron beside it),
 *   2. the place — "Area, City" (area FIRST), 1 line + ellipsis,
 *   3. the "MAHINE KI SALARY" box: the pay-type pill + the full band, 1 line + ellipsis,
 *   4. "Duty & Suvidhayein" chips: shift → experience → needed-by → requirements → benefits,
 *      each chip label 2 lines + ellipsis,
 *   5. the BadaBhai lockup at the foot.
 * It draws NO role kind, NO openings, NO company, NO seal, NO description and NO match skills.
 * (One more row exists on the phone and is deliberately NOT previewed: the "why this job" line a
 * worker sees when they matched through a RELATED skill — `_MatchLine`, from `matchNoteFor`. It
 * depends on which worker is looking, so there is no single card to show the payer.)
 * {@link toJobCardView} produces exactly those rows, in that order; {@link JOB_CARD_CLAMPS} carries
 * the line limits. Create, Edit, Detail and the Agency surfaces all render through it.
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
 * The worker card's line limits, verbatim from `design1_job_card.dart` (`maxLines`): the title is
 * 2 lines, the place 1, the salary label 1, the band 1, and each duty chip's label 2. The preview
 * stamps these as `data-clamp` and the stylesheet clamps to them (both are pinned by tests), so a
 * clamp can never drift from the phone's without a test going red.
 */
export const JOB_CARD_CLAMPS = {
  title: 2,
  place: 1,
  pay_label: 1,
  pay_band: 1,
  chip: 2,
} as const;

/**
 * THE REFERENCE PHONE the preview is drawn for — MEASURED, not guessed (2026-10-01, a Flutter
 * widget test pumping the real `SwipeJobsScreen` + the real 64dp `BbBottomNav` at 360×800dp with
 * a 24dp status bar and a 24dp gesture inset — the commonest mid-range Android class in India,
 * e.g. 1080×2400 @3x). On that phone the deck face is 332×464dp and the card's CONTENT BOX (above
 * the fixed brand footer) is 298×386dp; content below 386dp is CLIPPED with no scroll — the deck
 * card deliberately has none (`design1_job_card.dart`, "the clip IS the contract"). Other phones
 * measured the same way: 360×780 → 366dp, 360×740 → 326dp, 390×844 (47/34 insets) → 397dp,
 * 412×915 → 501dp. The preview draws the card at 332dp × a scale and clips at 386dp × the same
 * scale, so what it cuts is what this phone cuts. The stylesheet carries the same numbers (pinned).
 */
export const REFERENCE_PHONE = {
  widthDp: 360,
  heightDp: 800,
  cardWidthDp: 332,
  contentHeightDp: 386,
} as const;

/**
 * The collected card fields, snake_case (the shared wire vocabulary). One entry per row the
 * card can draw — no `org_label`, no seal, no boost, no spots. `role_kind` rides along because
 * the payer picked it: it keys the card's ROLE ILLUSTRATION (`@badabhai/role-art`, the same art
 * the worker's card paints for the same kind), but its NAME is NOT a card row — it is listed
 * under the preview as "Also in your posting — not written on the worker's card", because the
 * picture is on that card and the word never is.
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

/**
 * One rendered chip: a coarse `kind` (for the key/icon) + the display `label`. `state` exists only
 * on a LIVE FORM's card (never on a saved posting): `pending` = typed in the chip box but not yet
 * added — it WILL be saved (the forms commit it on blur and on submit), so it is drawn, dashed;
 * `invalid` = the value cannot be shown as typed, so the label is the fix, never a guessed value.
 */
export interface JobCardChip {
  kind: "shift" | "experience" | "needed_by" | "requirement" | "benefit";
  label: string;
  state?: "pending" | "invalid";
}

/**
 * The salary box. `band` is the worker's exact line; `issue` replaces it on a LIVE FORM whose pay
 * cannot be shown as typed ("21k", "1.5", max below min, over the ceiling) — the box then names
 * the fix instead of drawing a plausible WRONG band ("Up to ₹30,000/mah"). Exactly one is set.
 */
export type JobCardSalary =
  | { band: string; issue: null; payTypePill: string | null }
  | { band: null; issue: string; payTypePill: string | null };

/** Exactly what the card preview renders — derived, never re-derivable to anything worker-identifying. */
export interface JobCardView {
  /** The role title the payer typed (the card heading). Empty string when not yet entered. */
  title: string;
  /**
   * The place line exactly as the worker's card builds it ("Area, City"). Always drawn, like the
   * phone's row — "" when neither is set (the phone shows a pin with nothing beside it).
   */
  place: string;
  /** The salary box, or null when no band is stated and nothing needs fixing (box hidden). */
  salary: JobCardSalary | null;
  /** The "Duty & Suvidhayein" chips, in card order: shift, experience, needed-by, requirements, benefits. */
  chips: JobCardChip[];
}

/**
 * What a LIVE FORM knows that a saved posting does not: a pay / experience value that cannot be
 * drawn as typed (the message to show instead) and the chip-box text not yet added. Detail pages
 * pass nothing — a saved posting has no draft state.
 */
export interface JobCardDraft {
  payIssue?: string | null;
  experienceIssue?: string | null;
  pendingRequirement?: string | null;
  pendingBenefit?: string | null;
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

/**
 * The place line exactly as the worker's `_cardData` builds it (swipe_jobs_screen.dart):
 * `(area == null || area.isEmpty) ? city : '${area}, ${city}'` — area first, and mirrored to the
 * letter even where a published posting should never go: with no city the phone still draws the
 * row ("Chakan, " beside the pin), and with neither it draws the pin with NOTHING beside it — the
 * hole "Add the city" warns about. The preview keeps the row too, so the payer sees the hole the
 * worker would; the empty row's placeholder lives in CSS only, so the card's text stays the
 * worker's (pinned by the cross-language fixture).
 */
export function placeLabel(city: string | null, area: string | null): string {
  const c = (city ?? "").trim();
  const a = (area ?? "").trim();
  return a === "" ? c : `${a}, ${c}`;
}

/** Marks the LAST chip of `kind` whose label is `pending` (the forms append the draft last). */
function markPending(chips: JobCardChip[], kind: JobCardChip["kind"], pending: string | null | undefined) {
  const text = (pending ?? "").trim();
  if (text === "") return;
  for (let i = chips.length - 1; i >= 0; i -= 1) {
    const chip = chips[i]!;
    if (chip.kind === kind && chip.label === text) {
      chips[i] = { ...chip, state: "pending" };
      return;
    }
  }
}

/**
 * THE ONE MAPPER. Collected {@link CardFields} (+ a live form's {@link JobCardDraft}) → the
 * {@link JobCardView} the preview renders. Unknown enum values collapse to null (the row/box/pill
 * is hidden). A draft issue REPLACES the row it concerns — the salary box shows the fix instead
 * of a band, the experience chip shows the fix instead of a window — so a value the payer typed
 * that cannot be saved as-is is never drawn as a different, plausible one.
 */
export function toJobCardView(fields: CardFields, draft: JobCardDraft = {}): JobCardView {
  const chips: JobCardChip[] = [];

  const shift = shiftLabel(fields.shift);
  if (shift !== null) chips.push({ kind: "shift", label: `${shift} Shift` });

  const expIssue = draft.experienceIssue ?? null;
  const exp = experienceLabel(fields.min_experience_years, fields.max_experience_years);
  if (expIssue !== null) chips.push({ kind: "experience", label: expIssue, state: "invalid" });
  else if (exp !== null) chips.push({ kind: "experience", label: exp });

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
  markPending(chips, "requirement", draft.pendingRequirement);
  markPending(chips, "benefit", draft.pendingBenefit);

  const payTypePill = payTypeLabel(fields.pay_type);
  const payIssue = draft.payIssue ?? null;
  const band = formatPayBandFull(fields.pay_min, fields.pay_max);
  let salary: JobCardSalary | null = null;
  if (payIssue !== null) salary = { band: null, issue: payIssue, payTypePill };
  else if (band !== null) salary = { band, issue: null, payTypePill };

  return {
    title: (fields.role_title ?? "").trim(),
    place: placeLabel(fields.city, fields.area),
    salary,
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
 * MATCHING classifier and is NOT a card field; `roleKind` rides along for the "Also in your
 * posting" list, never as a card row.
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
