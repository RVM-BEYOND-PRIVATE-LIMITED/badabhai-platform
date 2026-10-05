import { formatIndianGrouped, type CardFields, type JobCardDraft } from "./job-card-view";
import type { WorkerCardGapInput } from "./worker-card-gap";

/**
 * THE ONE FORM → CARD READER — what every posting form (company create, company edit, agency
 * create/edit) reads its card fields through, for the preview AND for the submit.
 *
 * The forms hold raw strings (what is in the boxes). {@link readCardForm} turns them into:
 *   - `values`  — the card fields the SUBMIT sends (undefined = "not stated"),
 *   - `card`    — the {@link CardFields} the PREVIEW draws, derived from `values` and nothing else,
 *   - `issues`  — every number that cannot be saved as typed,
 *   - `draft`   — the same issues + the not-yet-added chip text, phrased for the card.
 * Because `card` is built from `values`, the preview cannot show something the submit would not
 * save; because `issues` block the submit, the card never draws a value the payer did not mean.
 *
 * NUMBERS ARE WHOLE OR THEY ARE AN ISSUE. "21,000" and "1,50,000" read as 21000 / 150000 (digit
 * grouping is how a payer writes rupees). "21k", "1.5", "2 saal", "1e5", "-3" are NOT silently
 * dropped to "not stated" — that used to turn a ₹21k–30k band into "Up to ₹30,000/mah" and
 * "1.5–4 yrs" into "Up to 4 yrs experience" on the card. They are an issue now: the field says
 * "needs a whole number", the card names the fix, and the submit is blocked.
 *
 * CHIP DRAFTS ARE NEVER DROPPED. Text typed in the Requirements / Benefits box but not yet added
 * is part of `values` (and drawn on the card as a pending chip): the forms also commit it on blur,
 * but a submit that arrives first still carries it.
 *
 * The API body shapes and the Zod schemas are unchanged — this only decides which numbers reach
 * them. The server stays the authority and re-validates everything.
 */

/** ₹/month sanity ceiling — parity with contracts.ts / the backend DTO (C10). */
export const PAY_MAX_INR = 10_000_000;
/** A plausible career-length ceiling — parity with contracts.ts / the backend DTO (C10). */
export const EXPERIENCE_MAX_YEARS = 60;

/** One number box, read: nothing typed, a whole number, or something that is not one. */
export type WholeNumber =
  | { readonly kind: "empty" }
  | { readonly kind: "ok"; readonly value: number }
  | { readonly kind: "invalid" };

const EMPTY: WholeNumber = { kind: "empty" };
const INVALID: WholeNumber = { kind: "invalid" };
const DIGITS = /^\d+$/;
/** Indian grouping: 21,000 · 1,50,000 · 1,00,00,000 (last group of 3, then groups of 2). */
const INDIAN_GROUPED = /^\d{1,2}(?:,\d{2})*,\d{3}$/;
/** Western grouping: 150,000 · 1,000,000. */
const WESTERN_GROUPED = /^\d{1,3}(?:,\d{3})+$/;
const COMMA = /,/g;

/**
 * A whole, non-negative number as a payer types it. Digits only, or digits grouped with commas
 * (either convention). Anything else — a decimal, a unit, a sign, an exponent, a space — is
 * `invalid`, never a guess and never "empty".
 */
export function parseWholeNumber(raw: string): WholeNumber {
  const text = raw.trim();
  if (text === "") return EMPTY;
  if (DIGITS.test(text)) return { kind: "ok", value: Number(text) };
  if (INDIAN_GROUPED.test(text) || WESTERN_GROUPED.test(text)) {
    return { kind: "ok", value: Number(text.replace(COMMA, "")) };
  }
  return INVALID;
}

/** The raw strings a posting form holds for the card (each form maps its own keys onto these). */
export interface CardFormFields {
  roleKind: string;
  title: string;
  city: string;
  area: string;
  payMin: string;
  payMax: string;
  payType: string;
  minExperienceYears: string;
  maxExperienceYears: string;
  shift: string;
  neededBy: string;
}

/** The chip editors' state: the added chips + the text still in each box. */
export interface CardFormChips {
  requirements: readonly string[];
  benefits: readonly string[];
  reqDraft: string;
  benDraft: string;
}

/** The card fields exactly as the submit sends them. `undefined` = not stated (never ""). */
export interface CardFormValues {
  roleKind: string | undefined;
  title: string;
  city: string | undefined;
  area: string | undefined;
  payMin: number | undefined;
  payMax: number | undefined;
  payType: string | undefined;
  minExperienceYears: number | undefined;
  maxExperienceYears: number | undefined;
  shift: string | undefined;
  neededBy: string | undefined;
  requirements: string[];
  benefits: string[];
}

export type CardNumberField = "payMin" | "payMax" | "minExperienceYears" | "maxExperienceYears";
export const CARD_NUMBER_FIELDS: readonly CardNumberField[] = [
  "payMin",
  "payMax",
  "minExperienceYears",
  "maxExperienceYears",
];
/** Why a number cannot be saved as typed. */
export type CardNumberIssue = "not_whole" | "too_large" | "below_min";
export type CardFormIssues = Partial<Record<CardNumberField, CardNumberIssue>>;

export interface CardFormRead {
  values: CardFormValues;
  card: CardFields;
  issues: CardFormIssues;
  draft: JobCardDraft;
}

const isPay = (field: CardNumberField) => field === "payMin" || field === "payMax";
const ceilingOf = (field: CardNumberField) => (isPay(field) ? PAY_MAX_INR : EXPERIENCE_MAX_YEARS);

/** The draft text appended to the chips when it is new — the same trim + de-dupe the Add button applies. */
export function withChipDraft(
  items: readonly string[],
  draft: string,
): { list: string[]; pending: string | null } {
  const text = draft.trim();
  if (text === "" || items.includes(text)) return { list: [...items], pending: null };
  return { list: [...items, text], pending: text };
}

/** The submit's card values → the {@link CardFields} the preview draws (one direction only). */
export function cardFieldsFromValues(values: CardFormValues): CardFields {
  return {
    role_title: values.title === "" ? null : values.title,
    role_kind: values.roleKind ?? null,
    city: values.city ?? null,
    area: values.area ?? null,
    pay_min: values.payMin ?? null,
    pay_max: values.payMax ?? null,
    pay_type: values.payType ?? null,
    min_experience_years: values.minExperienceYears ?? null,
    max_experience_years: values.maxExperienceYears ?? null,
    shift: values.shift ?? null,
    needed_by: values.neededBy ?? null,
    requirements: values.requirements,
    benefits: values.benefits,
  };
}

/** The card's own wording for a number it cannot draw (short — it sits where the value would). */
function cardIssueText(pay: boolean, issue: CardNumberIssue): string {
  if (pay) {
    if (issue === "not_whole") return "Pay needs a whole number";
    if (issue === "too_large") return `Pay is over ₹${formatIndianGrouped(PAY_MAX_INR)}`;
    return "Max pay is below min pay";
  }
  if (issue === "not_whole") return "Experience needs whole years";
  if (issue === "too_large") return `Experience is over ${EXPERIENCE_MAX_YEARS} years`;
  return "Max experience is below min";
}

function firstIssue(issues: CardFormIssues, a: CardNumberField, b: CardNumberField) {
  return issues[a] ?? issues[b] ?? null;
}

/** THE READER — see the module comment. Pure; called on every render and again on submit. */
export function readCardForm(fields: CardFormFields, chips: CardFormChips): CardFormRead {
  const parsed: Record<CardNumberField, WholeNumber> = {
    payMin: parseWholeNumber(fields.payMin),
    payMax: parseWholeNumber(fields.payMax),
    minExperienceYears: parseWholeNumber(fields.minExperienceYears),
    maxExperienceYears: parseWholeNumber(fields.maxExperienceYears),
  };

  const issues: CardFormIssues = {};
  for (const field of CARD_NUMBER_FIELDS) {
    const n = parsed[field];
    if (n.kind === "invalid") issues[field] = "not_whole";
    else if (n.kind === "ok" && n.value > ceilingOf(field)) issues[field] = "too_large";
  }
  const ordered = (min: CardNumberField, max: CardNumberField) => {
    const lo = parsed[min];
    const hi = parsed[max];
    if (issues[min] || issues[max] || lo.kind !== "ok" || hi.kind !== "ok") return;
    if (hi.value < lo.value) issues[max] = "below_min";
  };
  ordered("payMin", "payMax");
  ordered("minExperienceYears", "maxExperienceYears");

  const value = (field: CardNumberField): number | undefined => {
    const n = parsed[field];
    return n.kind === "ok" && issues[field] === undefined ? n.value : undefined;
  };

  const requirements = withChipDraft(chips.requirements, chips.reqDraft);
  const benefits = withChipDraft(chips.benefits, chips.benDraft);

  const values: CardFormValues = {
    roleKind: fields.roleKind === "" ? undefined : fields.roleKind,
    title: fields.title.trim(),
    city: fields.city.trim() || undefined,
    area: fields.area.trim() || undefined,
    payMin: value("payMin"),
    payMax: value("payMax"),
    payType: fields.payType === "" ? undefined : fields.payType,
    minExperienceYears: value("minExperienceYears"),
    maxExperienceYears: value("maxExperienceYears"),
    shift: fields.shift === "" ? undefined : fields.shift,
    neededBy: fields.neededBy === "" ? undefined : fields.neededBy,
    requirements: requirements.list,
    benefits: benefits.list,
  };

  const payIssue = firstIssue(issues, "payMin", "payMax");
  const expIssue = firstIssue(issues, "minExperienceYears", "maxExperienceYears");

  return {
    values,
    card: cardFieldsFromValues(values),
    issues,
    draft: {
      payIssue: payIssue === null ? null : cardIssueText(true, payIssue),
      experienceIssue: expIssue === null ? null : cardIssueText(false, expIssue),
      pendingRequirement: requirements.pending,
      pendingBenefit: benefits.pending,
    },
  };
}

const FIELD_NAME: Record<CardNumberField, string> = {
  payMin: "Min pay",
  payMax: "Max pay",
  minExperienceYears: "Min experience",
  maxExperienceYears: "Max experience",
};

/** The inline field error for one number issue (the copy the forms have always used, plus "whole number"). */
export function cardIssueMessage(field: CardNumberField, issue: CardNumberIssue): string {
  const name = FIELD_NAME[field];
  if (issue === "not_whole") {
    return isPay(field)
      ? `${name} needs a whole number of rupees, like 18000 or 18,000.`
      : `${name} needs a whole number of years, like 2.`;
  }
  if (issue === "too_large") {
    return isPay(field)
      ? `${name} must be at most ${formatIndianGrouped(PAY_MAX_INR)}.`
      : `${name} must be at most ${EXPERIENCE_MAX_YEARS} years.`;
  }
  return isPay(field)
    ? "Max pay must be greater than or equal to min pay."
    : "Max experience must be greater than or equal to min experience.";
}

/** Every issue as its inline message (what a submit surfaces). */
export function cardFieldErrors(issues: CardFormIssues): Partial<Record<CardNumberField, string>> {
  const out: Partial<Record<CardNumberField, string>> = {};
  for (const field of CARD_NUMBER_FIELDS) {
    const issue = issues[field];
    if (issue !== undefined) out[field] = cardIssueMessage(field, issue);
  }
  return out;
}

/**
 * The inline error a number box shows WHILE the payer types. A value that is not a whole number
 * or is over the ceiling shows at once — the character that broke it was just typed. "Max below
 * min" waits until the payer has left that box (`revealed`): typing 26000 past a 21000 minimum
 * passes through 2, 26, 260, 2600, and flashing an error at each keystroke helps nobody. The CARD
 * shows that issue immediately either way — it never draws the inverted band.
 */
export function liveCardFieldError(
  issues: CardFormIssues,
  field: CardNumberField,
  revealed: boolean,
): string | undefined {
  const issue = issues[field];
  if (issue === undefined) return undefined;
  if (issue === "below_min" && !revealed) return undefined;
  return cardIssueMessage(field, issue);
}

/** Which number boxes have had their "max below min" error revealed (by leaving them, or a submit). */
export type RevealedNumbers = Partial<Record<CardNumberField, true>>;
export type CardNumberPair = "pay" | "experience";

const PAIR_FIELDS: Record<CardNumberPair, readonly [CardNumberField, CardNumberField]> = {
  pay: ["payMin", "payMax"],
  experience: ["minExperienceYears", "maxExperienceYears"],
};

/** Every number box revealed — what a refused submit shows. */
export const ALL_NUMBERS_REVEALED: RevealedNumbers = {
  payMin: true,
  payMax: true,
  minExperienceYears: true,
  maxExperienceYears: true,
};

/** The min/max pair a form key belongs to, or null for any other field. */
export function numberPairOf(key: string): CardNumberPair | null {
  if (key === "payMin" || key === "payMax") return "pay";
  if (key === "minExperienceYears" || key === "maxExperienceYears") return "experience";
  return null;
}

/**
 * Reveal (on leaving a box) or conceal (on typing in it again) one pair's order error. "Reward
 * early, punish late": the error appears once the payer has left the box, and stands down while
 * they are fixing it — the card keeps naming the issue throughout.
 */
export function revealNumberPair(
  revealed: RevealedNumbers,
  pair: CardNumberPair,
  shown: boolean,
): RevealedNumbers {
  const next: RevealedNumbers = { ...revealed };
  for (const field of PAIR_FIELDS[pair]) {
    if (shown) next[field] = true;
    else delete next[field];
  }
  return next;
}

/** The gap rule's input, built from the SAME values the submit sends. */
export function gapInputFromValues(
  values: CardFormValues,
  description: string,
): WorkerCardGapInput {
  return {
    roleKind: values.roleKind ?? null,
    city: values.city ?? "",
    payMin: values.payMin ?? null,
    payMax: values.payMax ?? null,
    payType: values.payType ?? null,
    expMin: values.minExperienceYears ?? null,
    expMax: values.maxExperienceYears ?? null,
    shift: values.shift ?? null,
    neededBy: values.neededBy ?? null,
    description,
    requirements: values.requirements,
    benefits: values.benefits,
  };
}
