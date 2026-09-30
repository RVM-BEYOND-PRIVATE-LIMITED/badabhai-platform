/**
 * EVERY FACT THE WORKER'S JOB CARD SHOWS, IN ONE PLACE — the web port of the payer app's
 * `workerCardGap` (apps/payer-app/lib/features/jobs/domain/worker_card_fields.dart).
 *
 * The worker app's job card (`Design1JobCard`) draws exactly these:
 *   * the role title,
 *   * the place — `city`, plus the optional `area` beside it,
 *   * the ₹ band (`pay_min`–`pay_max`) and what that band MEANS (`pay_type`),
 *   * the experience window (`min/max_experience_years`),
 *   * the shift, and the needed-by chip,
 *   * the description, and
 *   * the requirement + benefit chip rows.
 *
 * An unstated field is a HOLE on the card, not a tidy omission. So the forms insist on all of
 * them — the company create, the agency create — and they do it through this ONE function,
 * because four copies of the rule would drift the moment the card gained a row.
 *
 * WEB EXTENSION: `roleKind` is checked FIRST. On web the role leads the card (the role label
 * from `role_kind`), so "Pick the role" is the first thing named. The rest of the order is the
 * VERBATIM Dart order, with the VERBATIM Dart copy.
 *
 * OWNER RULING: this rule is enforced on CREATE + PUBLISH only — editing a LIVE posting saves
 * with the gaps highlighted, never blocked. The API stays permissive (publish never refuses a
 * thin draft); this is a UX gate the forms/actions apply, not a server authority.
 */

/** A single missing field, ready for a toast. */
export interface WorkerCardGap {
  title: string;
  message: string;
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

/**
 * The FIRST field the card needs and the form does not have, or null when the card can be
 * drawn in full. Ordered as the forms are read, top to bottom, so the message always names the
 * field nearest the payer's eye rather than the last one checked.
 */
export function workerCardGap(input: WorkerCardGapInput): WorkerCardGap | null {
  // WEB FIRST: the role leads the card. Named before the city so the message follows the form.
  if (input.roleKind === null) {
    return {
      title: "Pick the role",
      message:
        "The role leads the worker's card. Pick it from the list so the card names what the " +
        "job is.",
    };
  }
  if (input.city.trim() === "") {
    return {
      title: "Add the city",
      message:
        "The city is the place shown on the worker's card. Without it the card shows a location " +
        "pin with nothing beside it.",
    };
  }
  if (input.payMin === null || input.payMax === null) {
    return {
      title: "Add the pay band",
      message:
        'Both ends of the ₹ band are shown on the card — "kitna milega" is the first thing a ' +
        "worker looks at.",
    };
  }
  if (input.payType === null) {
    return {
      title: "Pick the pay type",
      message: "Say what the band means — in-hand, gross or CTC. We never guess it for you.",
    };
  }
  if (input.expMin === null || input.expMax === null) {
    return {
      title: "Add the experience",
      message: "The card shows an experience window. Fill both the min and the max years.",
    };
  }
  if (input.shift === null) {
    return {
      title: "Pick the shift",
      message: "Day, night or rotational — the card shows it as a chip.",
    };
  }
  if (input.neededBy === null) {
    return {
      title: "Pick needed by",
      message: "When you need someone. The card shows it as a chip.",
    };
  }
  if (input.description.trim() === "") {
    return {
      title: "Add the description",
      message: "The card shows your description. Say what the work is.",
    };
  }
  if (input.requirements.length === 0) {
    return {
      title: "Add a requirement",
      message: "At least one requirement chip — the card has a row for them.",
    };
  }
  if (input.benefits.length === 0) {
    return {
      title: "Add a benefit",
      message: "At least one benefit chip — the card has a row for them.",
    };
  }
  return null;
}

/**
 * EVERY gap, in the same top-to-bottom order — the edit screen highlights all of them at once
 * (the workerCardGaps a chat publish or a live edit left behind), rather than surfacing one and
 * making the payer discover the next only after fixing the first.
 */
export function workerCardGaps(input: WorkerCardGapInput): WorkerCardGap[] {
  const gaps: WorkerCardGap[] = [];
  const push = (title: string, message: string) => gaps.push({ title, message });

  if (input.roleKind === null) {
    push(
      "Pick the role",
      "The role leads the worker's card. Pick it from the list so the card names what the " +
        "job is.",
    );
  }
  if (input.city.trim() === "") {
    push(
      "Add the city",
      "The city is the place shown on the worker's card. Without it the card shows a location " +
        "pin with nothing beside it.",
    );
  }
  if (input.payMin === null || input.payMax === null) {
    push(
      "Add the pay band",
      'Both ends of the ₹ band are shown on the card — "kitna milega" is the first thing a ' +
        "worker looks at.",
    );
  }
  if (input.payType === null) {
    push(
      "Pick the pay type",
      "Say what the band means — in-hand, gross or CTC. We never guess it for you.",
    );
  }
  if (input.expMin === null || input.expMax === null) {
    push(
      "Add the experience",
      "The card shows an experience window. Fill both the min and the max years.",
    );
  }
  if (input.shift === null) {
    push("Pick the shift", "Day, night or rotational — the card shows it as a chip.");
  }
  if (input.neededBy === null) {
    push("Pick needed by", "When you need someone. The card shows it as a chip.");
  }
  if (input.description.trim() === "") {
    push("Add the description", "The card shows your description. Say what the work is.");
  }
  if (input.requirements.length === 0) {
    push("Add a requirement", "At least one requirement chip — the card has a row for them.");
  }
  if (input.benefits.length === 0) {
    push("Add a benefit", "At least one benefit chip — the card has a row for them.");
  }
  return gaps;
}
