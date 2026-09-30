import { z } from "zod";
import {
  JOB_ROLE_FAMILIES,
  JOB_ROLE_FAMILY_LABELS,
  JOB_ROLE_LABELS,
  TRADE_FORM_KINDS_ALL,
  jobRoleLabel,
  type JobRoleFamily,
  type TradeFormKindName,
} from "@badabhai/types";

/**
 * The ROLE surface for the payer posting form (migration 0131 / PR-A).
 *
 * A posting's `role_kind` is one of the 21 DECLARED role kinds (`TRADE_FORM_KINDS_ALL`),
 * grouped for the picker under the six {@link JobRoleFamily} families. It is DISPLAY /
 * CLASSIFICATION ONLY (ADR-0036 addendum 2026-09-29): NEVER a match or rank input
 * (`match_skill_ids` stays the only match input), and on NO worker read this phase
 * (ADR-0024 addendum, #1823).
 *
 * This module is the SINGLE re-export of the shared `@badabhai/types` role vocabulary into
 * the payer-web surface, so no screen imports the labels/kinds directly and they can never
 * drift from the backend's `job_postings_role_kind_chk` / `JOB_ROLE_LABELS` copy (the API's
 * parity test asserts label === displayName for every kind).
 */
export {
  JOB_ROLE_FAMILIES,
  JOB_ROLE_FAMILY_LABELS,
  JOB_ROLE_LABELS,
  TRADE_FORM_KINDS_ALL,
  jobRoleLabel,
};
export type { JobRoleFamily, TradeFormKindName };

/**
 * The Zod enum over the 21 role kinds — the FORM/ACTION boundary guard. An out-of-set value
 * is rejected here AND by the backend `roleKindSchema` (a mirrored `z.enum(TRADE_FORM_KINDS_ALL)`),
 * so a posting can never carry an arbitrary string. Display-only; never a match input.
 */
export const roleKindInputSchema = z.enum(TRADE_FORM_KINDS_ALL);

/** One optgroup for the role picker: a family heading and its member kinds, in declared order. */
export interface RoleOptionGroup {
  family: JobRoleFamily;
  /** The family heading (e.g. "Machining"). */
  label: string;
  options: { value: TradeFormKindName; label: string }[];
}

/**
 * The 21 kinds grouped by family into optgroups for the DS `Select` (which renders `children`
 * — a payer picks a role via native `<optgroup>`/`<option>`). Every kind appears exactly once,
 * under its own family, and the family order matches {@link JOB_ROLE_FAMILIES}. A family with no
 * kinds is omitted (there is none today, but the filter keeps a stray heading off the list).
 */
export function roleOptionGroups(): RoleOptionGroup[] {
  return JOB_ROLE_FAMILIES.map((family) => ({
    family,
    label: JOB_ROLE_FAMILY_LABELS[family],
    options: TRADE_FORM_KINDS_ALL.filter((kind) => JOB_ROLE_LABELS[kind].family === family).map(
      (kind) => ({ value: kind, label: JOB_ROLE_LABELS[kind].label }),
    ),
  })).filter((group) => group.options.length > 0);
}
