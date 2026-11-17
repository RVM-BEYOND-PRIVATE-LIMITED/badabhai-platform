import { ROLES } from "@badabhai/taxonomy";
import { TRADE_FORM_KINDS_ALL } from "@badabhai/types";

/**
 * #2755 item 3 — THE CITY GROUPS AND THE TRADE GROUPS of the numbers screen.
 *
 * ── VERSIONED CODE CONSTANTS, NOT SETTINGS IN ENV OR `match_config` ──────────────────────────
 * The issue asks for the maps "held as settings". They are held HERE, as reviewed code, because
 * neither alternative holds a list honestly: an env value cannot carry a reviewed list of city
 * spellings, and the `match_config` row is inert in production (prod ranks on code defaults, TD128).
 * A change to either map is a pull request that bumps {@link NUMBERS_DEFINITION_VERSION}; part B's
 * snapshot stamps every row with the version it was computed under, and its recompute tool records
 * the version it moved to, so a week counted under v1 is never silently compared with one under v2.
 *
 * ── HONEST BUCKETS ──────────────────────────────────────────────────────────────────────────
 * A value that is present but outside the launch split is `other`; a missing one is `unknown`.
 * Nothing is dropped and nothing is guessed. `all` is the ROLL-UP LABEL only: no mapping ever
 * returns it, and part B stores one row per metric × city group × trade group INCLUDING `all`, so a
 * filter reads its own stored cell and never adds suppressed cells together.
 */

/**
 * The definition version of every list in this module and in `definitions.ts`. Start 1. Bump it
 * in the same pull request as any change to a member list or a metric rule.
 */
export const NUMBERS_DEFINITION_VERSION = 1;

/** The roll-up label every group set includes. */
export const NUMBERS_ALL_GROUP = "all" as const;
/** A present value outside the launch split. */
export const NUMBERS_OTHER_GROUP = "other" as const;
/** No value recorded. */
export const NUMBERS_UNKNOWN_GROUP = "unknown" as const;

// ---------------------------------------------------------------------------------------------
// Cities
// ---------------------------------------------------------------------------------------------

/** The launch cities (Tamil Nadu joins from February 2027, as a version bump). */
export const NUMBERS_LAUNCH_CITY_GROUPS = ["ncr", "pune", "ahmedabad"] as const;
export type NumbersLaunchCityGroup = (typeof NUMBERS_LAUNCH_CITY_GROUPS)[number];

/** What a city maps to: a launch group, `other` or `unknown`. Never `all`. */
export const NUMBERS_CITY_GROUPS = [
  ...NUMBERS_LAUNCH_CITY_GROUPS,
  NUMBERS_OTHER_GROUP,
  NUMBERS_UNKNOWN_GROUP,
] as const;
export type NumbersCityGroup = (typeof NUMBERS_CITY_GROUPS)[number];

/** Every city label a stored row or a filter can carry, the roll-up first. */
export const NUMBERS_CITY_GROUP_LABELS = [NUMBERS_ALL_GROUP, ...NUMBERS_CITY_GROUPS] as const;
export type NumbersCityGroupLabel = (typeof NUMBERS_CITY_GROUP_LABELS)[number];

/**
 * The member spellings of each launch city group, already NORMALISED (see {@link normalizeCityName}).
 * Stored cities are free text (`workers.current_city`, `job_postings.city`), so the obvious spellings
 * and the gazetteer's aliases (`dilli`, `gudgaon`, `poona`) are listed.
 *
 * NCR is the brief's list: Delhi / New Delhi, Faridabad, Gurugram / Gurgaon, Noida / Greater Noida,
 * Ghaziabad. Towns of the wider NCR region that the brief does not name (Manesar, Bhiwadi, Neemrana,
 * Bawal, Sonipat, Bahadurgarh) are NOT in it: adding one is an owner decision and a version bump.
 */
export const NUMBERS_CITY_GROUP_MEMBERS: Readonly<
  Record<NumbersLaunchCityGroup, readonly string[]>
> = {
  ncr: [
    "delhi",
    "new delhi",
    "dilli",
    "dilly",
    "delhi ncr",
    "ncr",
    "faridabad",
    "gurugram",
    "gurgaon",
    "gudgaon",
    "noida",
    "greater noida",
    "ghaziabad",
  ],
  pune: ["pune", "poona", "pimpri chinchwad", "pimpri", "chinchwad", "chakan"],
  ahmedabad: ["ahmedabad", "ahmadabad", "amdavad", "sanand", "gandhinagar"],
};

/** Display titles, for the definitions route. */
export const NUMBERS_CITY_GROUP_TITLES: Readonly<Record<NumbersCityGroupLabel, string>> = {
  all: "All cities",
  ncr: "NCR",
  pune: "Pune",
  ahmedabad: "Ahmedabad",
  other: "Other cities",
  unknown: "City not given",
};

const CITY_GROUP_BY_MEMBER: ReadonlyMap<string, NumbersLaunchCityGroup> = new Map(
  NUMBERS_LAUNCH_CITY_GROUPS.flatMap((group) =>
    NUMBERS_CITY_GROUP_MEMBERS[group].map((member) => [member, group] as const),
  ),
);

/**
 * A stored city in the form the member lists use: Unicode NFKC, lower case, only the part before
 * the first comma ("Noida, UP" → "noida"), hyphens, dots and underscores read as spaces
 * ("Pimpri-Chinchwad" → "pimpri chinchwad"), runs of whitespace collapsed, trimmed. `null` for a
 * missing or blank value.
 */
export function normalizeCityName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const head = raw.normalize("NFKC").toLowerCase().split(",")[0] ?? "";
  const folded = head
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return folded === "" ? null : folded;
}

/** The city group of a stored city: a launch group, `other`, or `unknown` when none is given. */
export function cityGroupOf(raw: string | null | undefined): NumbersCityGroup {
  const name = normalizeCityName(raw);
  if (name === null) return NUMBERS_UNKNOWN_GROUP;
  return CITY_GROUP_BY_MEMBER.get(name) ?? NUMBERS_OTHER_GROUP;
}

// ---------------------------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------------------------

/** The launch trades (brief section 8). */
export const NUMBERS_LAUNCH_TRADE_GROUPS = [
  "cnc_operator",
  "cnc_cam_programmer",
  "sheet_metal",
  "cad_3d_designer",
] as const;
export type NumbersLaunchTradeGroup = (typeof NUMBERS_LAUNCH_TRADE_GROUPS)[number];

/** What a trade key maps to: a launch group, `other` or `unknown`. Never `all`. */
export const NUMBERS_TRADE_GROUPS = [
  ...NUMBERS_LAUNCH_TRADE_GROUPS,
  NUMBERS_OTHER_GROUP,
  NUMBERS_UNKNOWN_GROUP,
] as const;
export type NumbersTradeGroup = (typeof NUMBERS_TRADE_GROUPS)[number];

/** Every trade label a stored row or a filter can carry, the roll-up first. */
export const NUMBERS_TRADE_GROUP_LABELS = [NUMBERS_ALL_GROUP, ...NUMBERS_TRADE_GROUPS] as const;
export type NumbersTradeGroupLabel = (typeof NUMBERS_TRADE_GROUP_LABELS)[number];

/** The two key spaces a trade arrives in. */
export interface NumbersTradeGroupMembers {
  /**
   * Trade-form kinds (`TRADE_FORM_KINDS_ALL`): what `job_postings.role_kind` stores for a company's
   * posting, and the `form_kind` a form worker was handed.
   */
  readonly roleKinds: readonly string[];
  /**
   * Taxonomy `role_*` ids: what `worker_occupation.role_id` stores (the onboarding funnel's primary
   * trade is the lowest `sort_order` row) and `worker_profiles.canonical_role_id`.
   */
  readonly taxonomyRoles: readonly string[];
}

/**
 * The members of each launch trade group, in both key spaces.
 *
 *   - CNC operator: the turning and VMC forms (the #2753 launch trades) and every taxonomy CNC
 *     machine-operator role (turner, VMC, HMC, setter-operator, the generic CNC operator). CNC
 *     GRINDING is its own trade form outside the launch five, so it is `other`.
 *   - CNC/CAM programmer: the CAM programmer form and both programmer roles. A turner at the
 *     `programmer` RUNG stays a CNC operator: a group is the trade, never the level.
 *   - Sheet metal: the sheet-metal form, every rung (operator and programmer are levels of it).
 *     The taxonomy has no sheet-metal role, so a worker is placed here only through a form kind.
 *   - 3D CAD designer: the 3D CAD form kind and `role_cad_designer_3d`. The 2D `cad_draughtsman`
 *     and the generic `role_designer` are not it, so they are `other`.
 */
export const NUMBERS_TRADE_GROUP_MEMBERS: Readonly<
  Record<NumbersLaunchTradeGroup, NumbersTradeGroupMembers>
> = {
  cnc_operator: {
    roleKinds: ["cnc_turner", "vmc_milling"],
    taxonomyRoles: [
      "role_cnc_turner_operator",
      "role_vmc_operator",
      "role_hmc_operator",
      "role_cnc_setter_operator",
      "role_cnc_operator",
    ],
  },
  cnc_cam_programmer: {
    roleKinds: ["cam_programmer"],
    taxonomyRoles: ["role_cam_programmer", "role_cnc_programmer"],
  },
  sheet_metal: {
    roleKinds: ["sheet_metal_worker"],
    taxonomyRoles: [],
  },
  cad_3d_designer: {
    roleKinds: ["cad_designer_3d"],
    taxonomyRoles: ["role_cad_designer_3d"],
  },
};

/** Display titles, for the definitions route. */
export const NUMBERS_TRADE_GROUP_TITLES: Readonly<Record<NumbersTradeGroupLabel, string>> = {
  all: "All trades",
  cnc_operator: "CNC operator",
  cnc_cam_programmer: "CNC/CAM programmer",
  sheet_metal: "Sheet metal (operator and programmer)",
  cad_3d_designer: "3D CAD designer",
  other: "Other trades",
  unknown: "Trade not given",
};

/** Every key this code knows as a trade: the trade-form kinds and the taxonomy roles. */
const KNOWN_TRADE_KEYS: ReadonlySet<string> = new Set<string>([
  ...TRADE_FORM_KINDS_ALL,
  ...ROLES.map((r) => r.id),
]);

const TRADE_GROUP_BY_KEY: ReadonlyMap<string, NumbersLaunchTradeGroup> = new Map(
  NUMBERS_LAUNCH_TRADE_GROUPS.flatMap((group) => {
    const m = NUMBERS_TRADE_GROUP_MEMBERS[group];
    return [...m.roleKinds, ...m.taxonomyRoles].map((key) => [key, group] as const);
  }),
);

/**
 * The trade group of a stored trade key — a form kind or a taxonomy role id. A launch group for a
 * member; `other` for any other KNOWN trade; `unknown` for a missing key AND for a key this code
 * does not know (it cannot say which trade that is, so it does not claim one).
 */
export function tradeGroupOf(key: string | null | undefined): NumbersTradeGroup {
  if (typeof key !== "string") return NUMBERS_UNKNOWN_GROUP;
  const k = key.trim();
  if (k === "") return NUMBERS_UNKNOWN_GROUP;
  const launch = TRADE_GROUP_BY_KEY.get(k);
  if (launch !== undefined) return launch;
  return KNOWN_TRADE_KEYS.has(k) ? NUMBERS_OTHER_GROUP : NUMBERS_UNKNOWN_GROUP;
}

/** Every trade key this code knows, for the exhaustive pin in the tests. */
export function knownTradeKeys(): readonly string[] {
  return [...KNOWN_TRADE_KEYS].sort();
}
