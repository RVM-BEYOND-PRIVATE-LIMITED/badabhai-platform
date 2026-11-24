import type { TradeReleaseRow } from "./trade-release";

/** The screen's own vocabulary. No route strings live here — see lib/trade-release.ts. */

export const TRADE_STATUS_FILTERS = [
  "all",
  "posting_on",
  "posting_off",
  "form_on",
  "form_off",
] as const;
export type TradeStatusFilter = (typeof TRADE_STATUS_FILTERS)[number];

export const TRADE_STATUS_FILTER_LABELS: Record<TradeStatusFilter, string> = {
  all: "All trades",
  posting_on: "Posting on",
  posting_off: "Posting off",
  form_on: "Form hand-over on",
  form_off: "Form hand-over off",
};

export function isTradeStatusFilter(value: unknown): value is TradeStatusFilter {
  return (
    typeof value === "string" &&
    (TRADE_STATUS_FILTERS as readonly string[]).includes(value)
  );
}

export function tradeKindLabel(kind: TradeReleaseRow["kind"]): string {
  return kind === "shop_floor" ? "Shop floor" : "Desk";
}

/** The date part of a server timestamp, or the dash the table uses for "not yet". */
export function tradeWhen(value: string | null): string {
  return value ? value.slice(0, 10) : "—";
}

export interface TradeFilters {
  department: string;
  status: TradeStatusFilter;
}

/**
 * Apply the two client-side filters WITHOUT re-sorting: `filter` keeps the server's order
 * (department then pack order) byte for byte. An empty department means every department.
 */
export function filterTradeRows(
  rows: readonly TradeReleaseRow[],
  filters: TradeFilters,
): TradeReleaseRow[] {
  return rows.filter((row) => {
    if (filters.department && row.department !== filters.department) return false;
    switch (filters.status) {
      case "posting_on":
        return row.posting_enabled;
      case "posting_off":
        return !row.posting_enabled;
      case "form_on":
        return row.form_enabled;
      case "form_off":
        return !row.form_enabled;
      default:
        return true;
    }
  });
}

export interface DepartmentGroup {
  department: string;
  label: string;
  rows: TradeReleaseRow[];
}

/** Departments in server order, each with its rows in server order. */
export function departmentGroups(
  rows: readonly TradeReleaseRow[],
): DepartmentGroup[] {
  const groups = new Map<string, DepartmentGroup>();
  for (const row of rows) {
    const found = groups.get(row.department);
    if (found) found.rows.push(row);
    else
      groups.set(row.department, {
        department: row.department,
        label: row.department_label,
        rows: [row],
      });
  }
  return [...groups.values()];
}

/** The held list, sorted by count desc but keeping the server's order for equal counts. */
export function heldRolesByCount(
  roles: readonly { role_label: string; count: number }[],
): { role_label: string; count: number }[] {
  return roles
    .map((role, index) => ({ role, index }))
    .sort((a, b) => b.role.count - a.role.count || a.index - b.index)
    .map(({ role }) => role);
}

/** The clipboard text for the held list: one "role — count" per line, no personal data. */
export function heldRolesText(
  roles: readonly { role_label: string; count: number }[],
): string {
  return heldRolesByCount(roles)
    .map((role) => `${role.role_label} — ${role.count}`)
    .join("\n");
}
