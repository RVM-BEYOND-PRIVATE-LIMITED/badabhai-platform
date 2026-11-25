import "server-only";
import { z } from "zod";
import { TRADE_CATALOGUE } from "@badabhai/taxonomy";
import { JOB_ROLE_LABELS, TRADE_FORM_KINDS_ALL } from "@badabhai/types";
import { adminFetch } from "./admin-http";

/**
 * THE TRADE CATALOGUE'S ONE ROUTE MODULE (#3023, contract fixed by #3067).
 *
 * GET /admin/trade-release            capability: manage_trade_release (super_admin)
 *   -> { "releases": [ { role_kind, posting_enabled, form_enabled, updated_by, updated_at } ] }
 *   One row per declared trade kind. The API carries no name, department, kind or wave: those
 *   come from the trade catalogue (`@badabhai/taxonomy` TRADE_CATALOGUE) and the role labels
 *   (`@badabhai/types` JOB_ROLE_LABELS), joined here by `role_kind`.
 *
 * PUT /admin/trade-release            capability: manage_trade_release
 *   body { role_kind, posting_enabled, form_enabled }  (strict, both flags required)
 *   -> { "changed": boolean, "release": <one row as above> }
 *   503 while the trade_release table is missing.
 *
 * GET /admin/campus-roles/held        capability: read_entities (#3014)
 *   -> { "roles": [ { role_label, count, … } ], "courses": [ … ] }
 *   Already sorted by count desc. Names and counts only. A 404 means it is not switched on yet.
 *
 * The release switch does NOT gate a worker reaching a form in chat. That is decided by the
 * seeded phrases and code bindings (#3002); this screen only reads and changes the two flags.
 */

export const tradeReleaseSchema = z.object({
  role_kind: z.string(),
  posting_enabled: z.boolean(),
  form_enabled: z.boolean(),
  updated_by: z.string().nullable(),
  updated_at: z.string().nullable(),
});
/** One trade's two switches, and who last changed them. */
export type TradeRelease = z.infer<typeof tradeReleaseSchema>;

const tradeReleaseListSchema = z.object({ releases: z.array(tradeReleaseSchema) });
const tradeReleaseSetSchema = z.object({ changed: z.boolean(), release: tradeReleaseSchema });

/** The department a declared kind the catalogue does not list is grouped under. */
export const UNCATALOGUED_DEPARTMENT = "Not in the catalogue";

/** One row of the screen: the catalogue's statement of a trade, plus its switches. */
export interface TradeRow {
  role_kind: string;
  role_label: string;
  department: string;
  kind: "shop_floor" | "desk" | null;
  wave: number | null;
  /** Null when this session may not read the switches (`manage_trade_release` is super_admin). */
  release: TradeRelease | null;
}

const CATALOGUE = new Map(TRADE_CATALOGUE.map((entry, index) => [entry.roleKind, { entry, index }]));
const LABELS: Readonly<Record<string, { label: string } | undefined>> = JOB_ROLE_LABELS;

function tradeRow(roleKind: string, release: TradeRelease | null): TradeRow {
  const entry = CATALOGUE.get(roleKind)?.entry;
  return {
    role_kind: roleKind,
    role_label: LABELS[roleKind]?.label ?? roleKind,
    department: entry?.department ?? UNCATALOGUED_DEPARTMENT,
    kind: entry?.kind ?? null,
    wave: entry?.wave ?? null,
    release,
  };
}

/** Catalogue order (T01…T60); kinds the catalogue does not list keep their order, last. */
function inCatalogueOrder(rows: TradeRow[]): TradeRow[] {
  const position = (row: TradeRow) => CATALOGUE.get(row.role_kind)?.index ?? Number.MAX_SAFE_INTEGER;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => position(a.row) - position(b.row) || a.index - b.index)
    .map(({ row }) => row);
}

/** Every declared trade with its switches. Needs `manage_trade_release`. */
export async function getTradeRelease(): Promise<TradeRow[]> {
  const res = await adminFetch("/admin/trade-release", { schema: tradeReleaseListSchema });
  return inCatalogueOrder(res.releases.map((release) => tradeRow(release.role_kind, release)));
}

/** Every declared trade WITHOUT its switches — what a session without the capability sees. */
export function getTradeCatalogue(): TradeRow[] {
  return inCatalogueOrder(TRADE_FORM_KINDS_ALL.map((roleKind) => tradeRow(roleKind, null)));
}

/** Set one trade's two switches. The API takes both flags, so the caller sends both. */
export async function setTradeRelease(
  roleKind: string,
  flags: { postingEnabled: boolean; formEnabled: boolean },
): Promise<TradeRelease> {
  const res = await adminFetch("/admin/trade-release", {
    method: "PUT",
    body: {
      role_kind: roleKind,
      posting_enabled: flags.postingEnabled,
      form_enabled: flags.formEnabled,
    },
    schema: tradeReleaseSetSchema,
  });
  return res.release;
}

export const heldCampusRoleSchema = z.object({
  role_label: z.string(),
  count: z.number(),
});
export type HeldCampusRole = z.infer<typeof heldCampusRoleSchema>;

const heldCampusRolesSchema = z.object({
  roles: z.array(heldCampusRoleSchema),
});

export async function getHeldCampusRoles(): Promise<HeldCampusRole[]> {
  const res = await adminFetch("/admin/campus-roles/held", { schema: heldCampusRolesSchema });
  return res.roles;
}
