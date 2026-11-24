import type { PostingTradeCatalogueEntryWire } from "./contracts";

/**
 * #3020 — the picker's pure view of `GET /payer/posting-trades/catalogue`.
 *
 * Departments are headings in the order the server sent them, and trades keep the server's order
 * inside a heading. Search only narrows by `role_label`; it never re-sorts or invents a name.
 */
export interface TradeDepartmentGroup {
  department: string;
  label: string;
  trades: PostingTradeCatalogueEntryWire[];
}

/** The catalogue as department groups, filtered by a case-insensitive `role_label` substring. */
export function tradeDepartmentGroups(
  trades: readonly PostingTradeCatalogueEntryWire[],
  query = "",
): TradeDepartmentGroup[] {
  const needle = query.trim().toLocaleLowerCase();
  const groups: TradeDepartmentGroup[] = [];
  const byDepartment = new Map<string, TradeDepartmentGroup>();
  for (const trade of trades) {
    if (needle !== "" && !trade.role_label.toLocaleLowerCase().includes(needle)) continue;
    let group = byDepartment.get(trade.department);
    if (group === undefined) {
      group = {
        department: trade.department,
        label: trade.department_label,
        trades: [],
      };
      byDepartment.set(trade.department, group);
      groups.push(group);
    }
    group.trades.push(trade);
  }
  return groups;
}

/** The catalogue row for `roleKind`, or undefined when the trade is not offered. */
export function catalogueTrade(
  trades: readonly PostingTradeCatalogueEntryWire[],
  roleKind: string | null | undefined,
): PostingTradeCatalogueEntryWire | undefined {
  if (roleKind === null || roleKind === undefined || roleKind === "") return undefined;
  return trades.find((trade) => trade.role_kind === roleKind);
}

/** `setter_programmer` → `Setter Programmer`; a display-only slug, never prose. */
export function humaniseRungLabel(rung: string): string {
  return rung
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
