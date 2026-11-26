import type { PostingReasonCode } from "./company-vocabulary";

/**
 * #3050 — the Campus narrow queue's own vocabulary. No route strings live here; the reads and
 * writes are in `lib/campus-narrow.ts`.
 *
 * The six machine trades mirror `NARROWABLE_ROLE_KINDS` in
 * `apps/api/src/admin-postings/admin-campus-narrow.dto.ts` (pinned by
 * `campus-narrow-vocabulary.test.ts`). Their ladders come from `@badabhai/taxonomy` on the
 * server page, so this module stays free of the catalogue.
 */

export const NARROWABLE_ROLE_KINDS = [
  "cnc_turner",
  "vmc_milling",
  "cnc_grinding",
  "sheet_metal_worker",
  "press_operator",
  "injection_moulding_operator",
] as const;
export type NarrowableRoleKind = (typeof NARROWABLE_ROLE_KINDS)[number];

export const NARROWABLE_ROLE_LABELS: Readonly<Record<NarrowableRoleKind, string>> = {
  cnc_turner: "CNC Turner",
  vmc_milling: "VMC / Milling Operator",
  cnc_grinding: "CNC Grinding Operator",
  sheet_metal_worker: "Sheet Metal Worker",
  press_operator: "Press Operator",
  injection_moulding_operator: "Injection Moulding Operator",
};

export interface NarrowLevelOption {
  value: string;
  label: string;
}

/** The ladder rung options the page hands the dialog, keyed by trade kind. */
export type NarrowLevels = Readonly<Record<NarrowableRoleKind, readonly NarrowLevelOption[]>>;

export const NARROW_OUTCOME_COPY: Readonly<Record<string, string>> = {
  changed: "The trade was set.",
  not_found: "That job no longer exists.",
  not_campus_origin: "This job did not come from Campus.",
  not_narrowable: "This job is not waiting to be narrowed any more.",
  posting_closed: "This job is closed, so its trade cannot be changed.",
  trade_not_released: "That trade is not switched on yet, so the job was left as it is.",
};

export function narrowOutcomeCopy(outcome: string): string {
  return NARROW_OUTCOME_COPY[outcome] ?? "The job was not changed.";
}

export const NARROW_REASON_CODES = [
  "incorrect_details",
  "low_quality",
  "other",
] as const satisfies readonly PostingReasonCode[];

export const NARROW_REASON_LABELS: Readonly<Record<(typeof NARROW_REASON_CODES)[number], string>> =
  {
    incorrect_details: "Narrowing an old Campus job to its machine trade",
    low_quality: "Low quality",
    other: "Other",
  };

/** The API's own floor and ceiling for a reason (`AdminPostingReasonText`). */
export const NARROW_REASON_MIN = 15;
export const NARROW_REASON_MAX = 500;

export function narrowReasonValid(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= NARROW_REASON_MIN && trimmed.length <= NARROW_REASON_MAX;
}

/** The default reason an admin narrowing a job writes; the API still stores the text. */
export const NARROW_DEFAULT_REASON =
  "Narrowing an old Campus job from the general CNC skill to the machine trade in its description.";
