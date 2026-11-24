import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";

/**
 * THE TRADE CATALOGUE'S ONE ROUTE MODULE (#3023).
 *
 * The backend halves are #3002 (the release table and admin route) and #3014 (the held-role
 * list). They are NOT merged yet, so every route string the screen uses is kept here, and only
 * here, against the assumed contract below. When the real routes land, changing this file is the
 * whole adaptation.
 *
 * ── ASSUMED BACKEND CONTRACT ──────────────────────────────────────────────────────────────
 *
 * GET /admin/trade-release
 *   -> { "trades": [ {
 *          "role_kind": string,
 *          "role_label": string,
 *          "department": string,
 *          "department_label": string,
 *          "kind": "shop_floor" | "desk",
 *          "wave": number | null,
 *          "posting_enabled": boolean,
 *          "form_enabled": boolean,
 *          "posting_changed_at": string | null,
 *          "form_changed_at": string | null,
 *          "updated_by": string | null,
 *          "updated_at": string | null
 *        } ] }
 *   Rows are ordered by department then pack order (server order); the screen never re-sorts
 *   names locally.
 *
 * PUT /admin/trade-release/:role_kind
 *   body { "posting_enabled"?: boolean, "form_enabled"?: boolean }
 *   -> the updated row, in the same shape as one catalogue row above.
 *   `role_kind` is URL-encoded. The server may refuse with a problem message; the screen shows
 *   that message. A 404 means the feature is not switched on.
 *
 * GET /admin/campus-roles/held
 *   -> { "roles": [ { "role_label": string, "count": number } ] }
 *   Already sorted by count desc. Names and counts only — never personal data.
 *
 * The release switch does NOT gate a worker reaching a form in chat. That is decided by the
 * seeded phrases and code bindings (#3002); this screen only reads and changes the two flags.
 */

export const TRADE_RELEASE_ROUTES = {
  list: "/admin/trade-release",
  update: (roleKind: string) => `/admin/trade-release/${encodeURIComponent(roleKind)}`,
  held: "/admin/campus-roles/held",
} as const;

export const TRADE_RELEASE_KINDS = ["shop_floor", "desk"] as const;

export const tradeReleaseRowSchema = z.object({
  role_kind: z.string(),
  role_label: z.string(),
  department: z.string(),
  department_label: z.string(),
  kind: z.enum(TRADE_RELEASE_KINDS),
  wave: z.number().nullable(),
  posting_enabled: z.boolean(),
  form_enabled: z.boolean(),
  posting_changed_at: z.string().nullable(),
  form_changed_at: z.string().nullable(),
  updated_by: z.string().nullable(),
  updated_at: z.string().nullable(),
});
export type TradeReleaseRow = z.infer<typeof tradeReleaseRowSchema>;

const tradeReleaseListSchema = z.object({
  trades: z.array(tradeReleaseRowSchema),
});

export async function getTradeRelease(): Promise<TradeReleaseRow[]> {
  const res = await adminFetch(TRADE_RELEASE_ROUTES.list, { schema: tradeReleaseListSchema });
  return res.trades;
}

export async function setTradeRelease(
  roleKind: string,
  change: { postingEnabled?: boolean; formEnabled?: boolean },
): Promise<TradeReleaseRow> {
  return adminFetch(TRADE_RELEASE_ROUTES.update(roleKind), {
    method: "PUT",
    body: {
      ...(change.postingEnabled === undefined
        ? {}
        : { posting_enabled: change.postingEnabled }),
      ...(change.formEnabled === undefined ? {} : { form_enabled: change.formEnabled }),
    },
    schema: tradeReleaseRowSchema,
  });
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
  const res = await adminFetch(TRADE_RELEASE_ROUTES.held, { schema: heldCampusRolesSchema });
  return res.roles;
}
