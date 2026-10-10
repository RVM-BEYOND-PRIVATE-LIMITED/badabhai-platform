import { getDomain, getRole } from "@badabhai/taxonomy";

import { descriptorForPack } from "./role-registry";

/**
 * THE FORM ROAD'S CANONICAL IDS (#2202).
 *
 * THE DEFECT. `GET /workers/me/profile-summary` derives `missing_fields` purely from the
 * canonical columns (`role` ⇔ `canonical_role_id IS NULL`, `trade` ⇔ `canonical_trade_id
 * IS NULL`), while the header label falls back to the interview's free-text `role_label` /
 * `domain_label`. No production path ever wrote non-null canonical ids — extraction hardcodes
 * both to null ("CANONICAL IDS ARE NOT INVENTED HERE"), form answers land in
 * `worker_pack_answer` + `worker_attributes` only, and `POST /profiles/confirm` touches
 * `confirmed_at` — so a worker who answered every trade-form question kept seeing
 * "FORM ADHOORA HAI … Sirf apna kaam / role aur apni industry bharna baaki hai" forever.
 *
 * THE FIX. A completed trade form IS the worker naming their trade: they tapped through the
 * pack the router handed them for that trade. Resolving the pack's DECLARED role (this
 * registry's closed set — never the model's free text) to its taxonomy `role_*` id and
 * stamping it on the profile row is canonicalization of a worker-attested fact, not an
 * invented id. The domain (`canonical_trade_id`) is derived from the role's own taxonomy
 * record, so the two can never disagree.
 *
 * FAIL-CLOSED, TWICE. An unmapped kind (a trade the taxonomy has no role for yet) resolves
 * to null and nothing is written — a worker keeps the honest "adhoora" card rather than a
 * fabricated completeness. A mapped id that the installed taxonomy no longer knows (a retag
 * that renamed it) also resolves to null at read time, so a stale table can never write an
 * id the match engine cannot resolve.
 *
 * WHY ONLY FIVE. The taxonomy mints 13 roles; the form registry declares 21 trades. Only the
 * trades below have an EXACT taxonomy counterpart — same occupation, same domain. Everything
 * else is deliberately absent:
 *   - `cad_draughtsman` is a MECHANICAL draughtsman; `role_designer` is a generic Designer
 *     (retrieval once resolved "cad designer" to a garment designer). Mapping them would be
 *     the nearest-skill proxy the `PACK_ANSWER_SKILLS` rules forbid.
 *   - `fitter`, `conventional_machinist`, `tool_die_maker`, `sheet_metal_worker`,
 *     `press_operator`, `painter_coating`, `maintenance_technician`,
 *     `industrial_electrician`, `assembly_line_worker`, `quality_inspector` have corpus
 *     `skill_*` / pack-only `mskill_*` reach but no `role_*`. Minting the role is a taxonomy
 *     decision; this table must not anticipate it.
 * Closing any row means the taxonomy minted the role AND this table names it — a test pins
 * every mapping below, so a retag that renames an id fails here rather than in production.
 */
const TRADE_KIND_TO_ROLE_ID: Readonly<Record<string, string>> = {
  cnc_turner: "role_cnc_turner_operator",
  vmc_milling: "role_vmc_operator",
  cnc_grinding: "role_cnc_grinding_operator",
  cam_programmer: "role_cam_programmer",
  welder: "role_welder",
};

export interface TradeCanonicalIds {
  readonly canonicalRoleId: string;
  readonly canonicalTradeId: string;
}

/**
 * The canonical ids a completed trade form claims, or null when the kind has no exact
 * taxonomy counterpart (fail-closed — see the file note). Validates BOTH ids against the
 * installed taxonomy on every call: a renamed id resolves to null rather than writing an
 * unresolvable value where the match engine trusts absolutely.
 */
export function canonicalIdsForKind(kind: string): TradeCanonicalIds | null {
  const roleId = TRADE_KIND_TO_ROLE_ID[kind];
  if (typeof roleId !== "string" || roleId.length === 0) return null;
  const role = getRole(roleId);
  if (!role) return null;
  const domain = getDomain(role.domainId);
  if (!domain) return null;
  return { canonicalRoleId: role.id, canonicalTradeId: domain.id };
}

/**
 * The canonical ids for the pack a form was built from, or null. Pack → kind is the
 * registry's own derivation (`descriptorForPack`), so a pack rename moves this with it;
 * an unknown pack fails closed like an unmapped kind.
 */
export function canonicalIdsForPack(packId: string | null | undefined): TradeCanonicalIds | null {
  if (typeof packId !== "string" || packId.length === 0) return null;
  const kind = descriptorForPack(packId)?.kind;
  return typeof kind === "string" ? canonicalIdsForKind(kind) : null;
}
