/**
 * WHAT A POSTING MUST STATE BEFORE IT GOES LIVE, IN ONE PLACE — the web port of the payer app's
 * `workerCardGap` (apps/payer-app/lib/features/jobs/domain/worker_card_fields.dart).
 *
 * The worker app's swipe card (`Design1JobCard`) draws:
 *   * the role title,
 *   * the place — the optional `area`, then the `city`,
 *   * the ₹ band (`pay_min`–`pay_max`) and what that band MEANS (`pay_type`),
 *   * the experience window (`min/max_experience_years`),
 *   * the shift, and the needed-by chip,
 *   * the requirement + benefit chip rows.
 * The DESCRIPTION is not on that card — the worker reads it when they open the posting (the detail
 * screen). It is still required: a worker who opens a job with no description has nothing to go on.
 *
 * An unstated field is a HOLE, not a tidy omission. So the forms insist on all of them — the
 * company create/publish, the agency create — through this ONE ordered list, because two copies
 * of the rule (one for the first gap, one for all of them) would drift the moment a row changed.
 *
 * WEB EXTENSION: `roleKind` is checked FIRST. It files the posting under the right role, and the
 * form asks for it first, so "Pick the role" is named first. The rest is the Dart order.
 *
 * It IS on the worker's card now — as the role ILLUSTRATION, keyed by `role_kind`, which both
 * `GET /feed` and `GET /jobs/:jobId` carry since the owner ruling of 2026-10-05 (ADR-0024
 * addendum, #2009). Never as words. The older note here said no worker read carried it, which
 * stopped being true when the art shipped.
 *
 * OWNER RULING: this rule is enforced on CREATE + PUBLISH only — editing a LIVE posting saves
 * with the gaps highlighted, never blocked. The API stays permissive (publish never refuses a
 * thin draft); this is a UX gate the forms/actions apply, not a server authority.
 */

/** The form control a gap points at (the forms focus it when a publish is refused). */
export type WorkerCardGapField =
  | "roleKind"
  | "city"
  | "payMin"
  | "payMax"
  | "payType"
  | "minExperienceYears"
  | "maxExperienceYears"
  | "shift"
  | "neededBy"
  | "description"
  | "requirements"
  | "benefits";

/** A single missing field, ready for a toast — and the control to take the payer to. */
export interface WorkerCardGap {
  title: string;
  message: string;
  field: WorkerCardGapField;
}

/** The raw editor contents the gap rule reads. Enums are null until picked; text is trimmed here. */
export interface WorkerCardGapInput {
  /** The picked role kind (one of the 21), or null until picked. Checked FIRST (web). */
  roleKind: string | null;
  city: string;
  payMin: number | null;
  payMax: number | null;
  payType: string | null;
  expMin: number | null;
  expMax: number | null;
  shift: string | null;
  neededBy: string | null;
  description: string;
  requirements: string[];
  benefits: string[];
}

interface GapCheck {
  title: string;
  message: string;
  /** The control to take the payer to — for a min/max pair, the end that is actually empty. */
  field: (input: WorkerCardGapInput) => WorkerCardGapField;
  missing: (input: WorkerCardGapInput) => boolean;
}

/** Top to bottom, as the forms are read — so a message names the field nearest the payer's eye. */
const CHECKS: readonly GapCheck[] = [
  {
    field: () => "roleKind",
    title: "Pick the role",
    message:
      "Pick the role from the list. It files your posting under the right trade — workers see " +
      "your role title, not this.",
    missing: (i) => i.roleKind === null,
  },
  {
    field: () => "city",
    title: "Add the city",
    message:
      "The city is the place shown on the worker's card. Without it the card shows a location " +
      "pin with nothing beside it.",
    missing: (i) => i.city.trim() === "",
  },
  {
    field: (i) => (i.payMin === null ? "payMin" : "payMax"),
    title: "Add the pay band",
    message:
      'Both ends of the ₹ band are shown on the card — "kitna milega" is the first thing a ' +
      "worker looks at.",
    missing: (i) => i.payMin === null || i.payMax === null,
  },
  {
    field: () => "payType",
    title: "Pick the pay type",
    message: "Say what the band means — in-hand, gross or CTC. We never guess it for you.",
    missing: (i) => i.payType === null,
  },
  {
    field: (i) => (i.expMin === null ? "minExperienceYears" : "maxExperienceYears"),
    title: "Add the experience",
    message: "The card shows an experience window. Fill both the min and the max years.",
    missing: (i) => i.expMin === null || i.expMax === null,
  },
  {
    field: () => "shift",
    title: "Pick the shift",
    message: "Day, night or rotational — the card shows it as a chip.",
    missing: (i) => i.shift === null,
  },
  {
    field: () => "neededBy",
    title: "Pick needed by",
    message: "When you need someone. The card shows it as a chip.",
    missing: (i) => i.neededBy === null,
  },
  {
    field: () => "description",
    title: "Add the description",
    message:
      "Workers read it when they open the posting — it is not on the swipe card. Say what the work is.",
    missing: (i) => i.description.trim() === "",
  },
  {
    field: () => "requirements",
    title: "Add a requirement",
    message: "At least one requirement chip — the card has a row for them.",
    missing: (i) => i.requirements.length === 0,
  },
  {
    field: () => "benefits",
    title: "Add a benefit",
    message: "At least one benefit chip — the card has a row for them.",
    missing: (i) => i.benefits.length === 0,
  },
];

const toGap = (check: GapCheck, input: WorkerCardGapInput): WorkerCardGap => ({
  title: check.title,
  message: check.message,
  field: check.field(input),
});

/**
 * The FIRST field the posting needs and the form does not have, or null when it is complete.
 * Ordered as the forms are read, top to bottom, so the message always names the field nearest
 * the payer's eye rather than the last one checked.
 */
export function workerCardGap(input: WorkerCardGapInput): WorkerCardGap | null {
  const check = CHECKS.find((c) => c.missing(input));
  return check === undefined ? null : toGap(check, input);
}

/**
 * EVERY gap, in the same top-to-bottom order — the edit screens highlight all of them at once
 * (the gaps a chat publish or a live edit left behind), rather than surfacing one and making the
 * payer discover the next only after fixing the first.
 */
export function workerCardGaps(input: WorkerCardGapInput): WorkerCardGap[] {
  return CHECKS.filter((c) => c.missing(input)).map((c) => toGap(c, input));
}
