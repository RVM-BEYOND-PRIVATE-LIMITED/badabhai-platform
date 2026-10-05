import type { ApiFieldIssue } from "./payer-errors";

/**
 * Map a posting validation 400's `issues[].path` (the server's snake_case schema
 * keys) onto the payer-web form's camelCase field keys (#1912), so a refused
 * `role_title` / `description` shows INLINE on the field the payer typed into —
 * instead of one generic banner.
 *
 * The server remains the authority; this only routes its already-safe,
 * field-naming messages to the right input. A path with no form field (e.g. the
 * match half) is returned in `rest` for the caller's generic message.
 */
const FORM_FIELD_BY_WIRE: Readonly<Record<string, string>> = {
  role_title: "roleTitle",
  role_kind: "roleKind",
  description: "description",
  city: "city",
  area: "area",
  location_label: "locationLabel",
  vacancies: "vacancies",
  pay_min: "payMin",
  pay_max: "payMax",
  min_experience_years: "minExperienceYears",
  max_experience_years: "maxExperienceYears",
  requirements: "requirements",
  benefits: "benefits",
  shift: "shift",
  needed_by: "neededBy",
};

/** camelCase form key for a server path, or null when it is not a form field. */
function toFormField(path: string): string | null {
  const head = path.split(".")[0] ?? "";
  return FORM_FIELD_BY_WIRE[head] ?? null;
}

export interface MappedPostingIssues {
  /** Inline field errors, keyed by the form's camelCase field name (first issue wins). */
  fieldErrors: Record<string, string>;
  /** Messages with no form field to attach to — the caller shows these as a banner. */
  rest: string[];
}

export function mapPostingIssues(issues: readonly ApiFieldIssue[]): MappedPostingIssues {
  const fieldErrors: Record<string, string> = {};
  const rest: string[] = [];
  for (const issue of issues) {
    const key = toFormField(issue.path);
    if (key === null) {
      if (!rest.includes(issue.message)) rest.push(issue.message);
    } else if (fieldErrors[key] === undefined) {
      fieldErrors[key] = issue.message;
    }
  }
  return { fieldErrors, rest };
}
