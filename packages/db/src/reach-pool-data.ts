/**
 * SEED-1 shared data + determinism primitives for the Reach test pool.
 *
 * Kept separate from `seed-reach-pool.ts` (the DB writer) so the PURE pieces — the
 * seeded PRNG, the namespaced-UUID derivation, the city centroids, and the trade
 * frequency table — are import-side-effect-free and unit-testable with NO database.
 *
 * DETERMINISM CONTRACT: every random choice in the seed flows through `makeRng`
 * (mulberry32 — a tiny, fast, well-distributed 32-bit PRNG). It is NEVER `Math.random`,
 * so the same `SEED_RNG_SEED` produces a byte-identical pool. UUIDs are DERIVED from a
 * fixed namespace + the row index (no randomness), so they are stable across reseeds.
 */

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32. Deterministic, fast, no deps. (We do NOT use
// Math.random anywhere in the seed; the pool must be reproducible from the seed.)
// ---------------------------------------------------------------------------
export interface Rng {
  /** Next float in [0, 1). */
  next(): number;
}

/**
 * mulberry32: a 32-bit state PRNG. Given the same seed it emits the same sequence on
 * every platform/run — that is the whole point (reproducible synthetic data).
 */
export function makeRng(seed: number): Rng {
  // Coerce to a uint32 starting state (a non-finite/negative seed is normalized).
  let state = (Number.isFinite(seed) ? Math.floor(seed) : 0) >>> 0;
  return {
    next(): number {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/**
 * Weighted pick from parallel `items` / `weights` arrays, consuming exactly ONE rng
 * draw (so the consumption order is stable). Falls back to the last item for any
 * floating-point remainder. `items` MUST be non-empty.
 */
export function pickWeighted<T>(items: readonly T[], weights: readonly number[], rng: Rng): T {
  const total = weights.reduce((s, w) => s + (w > 0 ? w : 0), 0);
  if (items.length === 0) throw new Error("pickWeighted: items must be non-empty");
  if (total <= 0) return items[items.length - 1]!;
  let r = rng.next() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]! > 0 ? weights[i]! : 0;
    if (r < 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

// ---------------------------------------------------------------------------
// Namespaced, deterministic UUIDs.
//
// Every reach-seed row gets a STABLE UUID derived from (kind, index) — no randomness —
// so reseeding produces the same ids and the teardown can target exactly these rows.
// The "5eed" + "reac" prefix flags them as reach-seed rows at a glance (distinct from
// the demand seed's "5eeded00…" namespace) and keeps them out of any real-data range.
//
// Layout: 5eed<KK>-<IIII>-4a00-8000-<IIIIIIIIIIII>
//   KK   = a 2-hex "kind" tag (worker/profile/payer/…); keeps kinds in disjoint ranges.
//   IIII / the node = the row index in hex, so each (kind,index) is unique + reversible.
// Always a valid v4-shaped UUID (version nibble 4, variant nibble 8).
// ---------------------------------------------------------------------------
export const REACH_SEED_PREFIX = "5eed";

const KIND_TAG: Record<string, string> = {
  worker: "10",
  profile: "11",
  consent: "12",
  payer: "20",
  credits: "21",
  capacity: "22",
  posting: "30",
  plan: "31",
  job: "40",
};

export type ReachSeedKind = keyof typeof KIND_TAG;

/**
 * Deterministic, stable, v4-shaped UUID for a (kind, index) reach-seed row.
 *
 * Layout: "5eed"+<KK>+<hh> - <hhhh> - 4a00 - 8000 - <48-bit index>
 *   group 1 (8 hex) = "5eed" (namespace flag) + KK (2-hex kind tag) + 2 index hex.
 *   group 2 (4 hex) = 4 more index hex. The full index also fills the 48-bit node,
 *   making each (kind,index) unique + reversible while kinds stay in disjoint ranges.
 * Version nibble is 4, variant nibble is 8 → always a valid v4-shaped UUID.
 */
export function reachSeedUuid(kind: ReachSeedKind, index: number): string {
  const tag = KIND_TAG[kind];
  if (!tag) throw new Error(`reachSeedUuid: unknown kind "${kind}"`);
  const idx = Math.max(0, Math.floor(index));
  const hex = idx.toString(16);
  const idx48 = hex.padStart(12, "0").slice(-12); // 48-bit node carries the full index
  const g1tail = idx48.slice(0, 2); // 2 hex → completes the 8-char first group
  const g2 = idx48.slice(2, 6); // next 4 hex → the 4-char second group
  // 5eed<tag><g1tail>-<g2>-4a00-8000-<idx48>
  return `${REACH_SEED_PREFIX}${tag}${g1tail}-${g2}-4a00-8000-${idx48}`;
}

// ---------------------------------------------------------------------------
// Cities — real Indian manufacturing-hub CENTROIDS (ADR-0005: city-centroid only,
// never a worker-precise point). lat/lng are the accepted city-center coordinates.
// ---------------------------------------------------------------------------
export interface ReachCity {
  slug: string;
  name: string;
  lat: number;
  lng: number;
}

export const REACH_CITIES: readonly ReachCity[] = [
  { slug: "pune", name: "Pune", lat: 18.5204, lng: 73.8567 },
  { slug: "bengaluru", name: "Bengaluru", lat: 12.9716, lng: 77.5946 },
  { slug: "chennai", name: "Chennai", lat: 13.0827, lng: 80.2707 },
  { slug: "coimbatore", name: "Coimbatore", lat: 11.0168, lng: 76.9558 },
  { slug: "ahmedabad", name: "Ahmedabad", lat: 23.0225, lng: 72.5714 },
  { slug: "rajkot", name: "Rajkot", lat: 22.3039, lng: 70.8022 },
  { slug: "faridabad", name: "Faridabad", lat: 28.4089, lng: 77.3178 },
  { slug: "ludhiana", name: "Ludhiana", lat: 30.901, lng: 75.8573 },
  { slug: "aurangabad", name: "Aurangabad", lat: 19.8762, lng: 75.3433 },
  { slug: "ncr", name: "NCR (Delhi)", lat: 28.6139, lng: 77.209 },
] as const;

// ---------------------------------------------------------------------------
// Trades — the 7 canonical taxonomy ROLES, each tied to the ADR-0009 `jobs.trade_key`
// that maps back to it via the API's trade→role bridge (roleIdsForTradeKey), plus the
// taxonomy DOMAIN id (→ worker_profiles.canonical_trade_id). NON-UNIFORM weights:
// VMC / CNC-turner are common; CAM-programmer and CNC-grinding are RARE → grinding is
// the deliberate THIN-SUPPLY trade that would trip PACE supply-widening.
//
// trade_key linkage (matches apps/api src/resume/trade-content.ts taxonomy_role_ids):
//   role_cnc_turner_operator  ← cnc_operator
//   role_vmc_operator         ← vmc_operator
//   role_hmc_operator         ← vmc_operator        (shared; we map it to vmc_operator)
//   role_cnc_setter_operator  ← cnc_vmc_setter
//   role_cnc_programmer       ← cnc_programmer
//   role_cam_programmer       ← cnc_programmer      (shared; we map it to cnc_programmer)
//   role_cnc_grinding_operator← tool_room_technician
// So a `jobs` row with the listed trade_key exact-matches the worker's canonical_role_id
// through the bridge — the engine's Role factor (.35) lights up on the live path too.
// ---------------------------------------------------------------------------
import type { TradeKey } from "./schema";

export interface ReachTrade {
  roleId: string; // worker_profiles.canonical_role_id (taxonomy ROLE id)
  domainId: string; // worker_profiles.canonical_trade_id (taxonomy DOMAIN id)
  tradeKey: TradeKey; // jobs.trade_key whose bridge yields roleId
  title: string;
  weight: number; // relative frequency — NON-UNIFORM by design
}

export const REACH_TRADES: readonly ReachTrade[] = [
  {
    roleId: "role_vmc_operator",
    domainId: "dom_vmc_machining",
    tradeKey: "vmc_operator",
    title: "VMC Operator",
    weight: 0.28, // common
  },
  {
    roleId: "role_cnc_turner_operator",
    domainId: "dom_cnc_machining",
    tradeKey: "cnc_operator",
    title: "CNC Turner/Operator",
    weight: 0.26, // common
  },
  {
    roleId: "role_cnc_setter_operator",
    domainId: "dom_cnc_machining",
    tradeKey: "cnc_vmc_setter",
    title: "CNC Setter-Operator",
    weight: 0.16,
  },
  {
    roleId: "role_hmc_operator",
    domainId: "dom_hmc_machining",
    tradeKey: "vmc_operator", // bridge: vmc_operator → [role_vmc_operator, role_hmc_operator]
    title: "HMC Operator",
    weight: 0.13,
  },
  {
    roleId: "role_cnc_programmer",
    domainId: "dom_programming",
    tradeKey: "cnc_programmer",
    title: "CNC Programmer",
    weight: 0.1,
  },
  {
    roleId: "role_cam_programmer",
    domainId: "dom_programming",
    tradeKey: "cnc_programmer", // bridge: cnc_programmer → [role_cnc_programmer, role_cam_programmer]
    title: "CAM Programmer",
    weight: 0.04, // RARE
  },
  {
    roleId: "role_cnc_grinding_operator",
    domainId: "dom_grinding",
    tradeKey: "tool_room_technician", // bridge: tool_room_technician → [role_cnc_grinding_operator]
    title: "CNC Grinding Operator",
    weight: 0.03, // RARE — the thin-supply trade for PACE widening
  },
] as const;
