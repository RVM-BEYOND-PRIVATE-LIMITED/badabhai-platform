import type { TradeRow } from "./trade-release";

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

export function tradeKindLabel(kind: TradeRow["kind"]): string {
  if (kind === null) return "—";
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
 * Apply the two client-side filters WITHOUT re-sorting: `filter` keeps the catalogue order byte
 * for byte. An empty department means every department. A row whose switches this session cannot
 * read matches only "All trades".
 */
export function filterTradeRows(rows: readonly TradeRow[], filters: TradeFilters): TradeRow[] {
  return rows.filter((row) => {
    if (filters.department && row.department !== filters.department) return false;
    if (filters.status === "all") return true;
    if (row.release === null) return false;
    switch (filters.status) {
      case "posting_on":
        return row.release.posting_enabled;
      case "posting_off":
        return !row.release.posting_enabled;
      case "form_on":
        return row.release.form_enabled;
      case "form_off":
        return !row.release.form_enabled;
    }
  });
}

export interface DepartmentGroup {
  department: string;
  rows: TradeRow[];
}

/** Departments in first-seen order, each with its rows in the order given. */
export function departmentGroups(rows: readonly TradeRow[]): DepartmentGroup[] {
  const groups = new Map<string, DepartmentGroup>();
  for (const row of rows) {
    const found = groups.get(row.department);
    if (found) found.rows.push(row);
    else
      groups.set(row.department, { department: row.department, rows: [row] });
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
