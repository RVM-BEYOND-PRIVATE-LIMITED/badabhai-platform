import { CITY_CATALOGUE } from "./worker-cities.catalogue";

/**
 * THE CURATED INDUSTRIAL-HUB CATALOGUE (#1634) — the DESIGN2 multi-city picker's states → hubs
 * data, served additively on `GET /workers/me/work-preferences/options` as `city_hubs`.
 *
 * WHY A SECOND LIST WHEN `cities` ALREADY EXISTS. The flat gazetteer is the right shape for the
 * employer-location field and the state cascade; it is the wrong shape for the mockup's picker,
 * which shows a handful of hubs per state, each with the industrial areas a worker actually
 * recognises ("Chakan, Bhosari MIDC"), a one-tap select, and a POPULAR row. None of that
 * vocabulary exists in the gazetteer — and inventing it client-side would mint a second, drifting
 * copy of product content, which is the cross-language failure this endpoint exists to prevent.
 *
 * EVERY `city_value` IS A CANONICAL CITY. The display spelling and the submitted value are
 * deliberately separate fields: `Sambhaji Nagar` is a rename of the canonical `Aurangabad`, so a
 * hub whose display is the new name still submits the value `canonicalCity` accepts. The test
 * pins the round trip through the REAL DTO, so a hub can never suggest a tap that 400s the save.
 *
 * `state` IS A FILTER KEY, exactly as on {@link CityOption}: the client cascades by string
 * equality against `states`, and the test pins every hub's state to that list.
 *
 * CONTENT PROVENANCE. The hub set and the area sub-labels are authored from the DESIGN2 mockup
 * (`apps/worker-app/assets/fonts/image/DESIGN2.png`), whose captured text is indicative rather
 * than final; the owner's ratification is the review of this file. `popular` is a STATIC authored
 * flag (owner ruling 2026-09-21) — there is no demand data behind it, and deriving one is a later
 * owner call.
 *
 * FROZEN, because it is handed out by reference on a response every worker fetches on mount and a
 * caller mutating it would corrupt every later request in the process.
 */

/** One hub on the DESIGN2 picker. */
export interface CityHub {
  /** A member of the served `states` list — the cascade key. */
  readonly state: string;
  /** Stable slug for analytics / one-tap idempotency. Unique across the catalogue. */
  readonly hub_key: string;
  /** What the chip shows, e.g. "Mumbai / Thane" — may differ from `city_value`. */
  readonly display: string;
  /** Display-only industrial-area sub-labels, e.g. ["Chakan", "Bhosari MIDC"]. */
  readonly areas: readonly string[];
  /** The CANONICAL value submitted in `preferred_cities`. */
  readonly city_value: string;
  /** Drives the "POPULAR FACTORY HUBS" row. Static and authored, never derived. */
  readonly popular: boolean;
}

export const CITY_HUBS: readonly CityHub[] = Object.freeze([
  // ── Maharashtra ────────────────────────────────────────────────────────────────
  {
    state: "Maharashtra",
    hub_key: "pune",
    display: "Pune",
    areas: ["Chakan", "Bhosari MIDC"],
    city_value: "Pune",
    popular: true,
  },
  {
    state: "Maharashtra",
    hub_key: "mumbai-thane",
    display: "Mumbai / Thane",
    areas: ["TTC", "Bhiwandi Logistics"],
    // Thane is its own canonical city since #1634; the hub keeps the metro pairing the mockup
    // shows, and submits the canonical value it is displayed under.
    city_value: "Thane",
    popular: true,
  },
  {
    state: "Maharashtra",
    hub_key: "nashik",
    display: "Nashik",
    areas: ["Ambad MIDC", "Satpur MIDC"],
    city_value: "Nashik",
    popular: true,
  },
  {
    state: "Maharashtra",
    hub_key: "sambhaji-nagar",
    display: "Sambhaji Nagar",
    areas: ["Waluj MIDC", "Shendra MIDC"],
    // The gazetteer's canonical token is still `aurangabad` — the rename is display-only.
    city_value: "Aurangabad",
    popular: false,
  },
  {
    state: "Maharashtra",
    hub_key: "nagpur",
    display: "Nagpur",
    areas: ["Butibori", "MIHAN"],
    city_value: "Nagpur",
    popular: false,
  },
  {
    state: "Maharashtra",
    hub_key: "kolhapur",
    display: "Kolhapur",
    areas: ["Shiroli MIDC", "Kagal Five Star MIDC"],
    city_value: "Kolhapur",
    popular: false,
  },
  // ── Haryana ────────────────────────────────────────────────────────────────────
  {
    state: "Haryana",
    hub_key: "manesar",
    display: "Manesar",
    areas: ["IMT Manesar"],
    city_value: "Manesar",
    popular: true,
  },
  {
    state: "Haryana",
    hub_key: "gurugram",
    display: "Gurugram",
    areas: ["Udyog Vihar", "Pataudi Road"],
    city_value: "Gurugram",
    popular: false,
  },
  // ── Gujarat ────────────────────────────────────────────────────────────────────
  {
    state: "Gujarat",
    hub_key: "sanand",
    display: "Sanand",
    areas: ["GIDC Sanand"],
    city_value: "Sanand",
    popular: true,
  },
  {
    state: "Gujarat",
    hub_key: "ahmedabad",
    display: "Ahmedabad",
    areas: ["Vatva GIDC", "Naroda"],
    city_value: "Ahmedabad",
    popular: false,
  },
  // ── Tamil Nadu ─────────────────────────────────────────────────────────────────
  {
    state: "Tamil Nadu",
    hub_key: "chennai",
    display: "Chennai",
    areas: ["Ambattur", "Guindy"],
    city_value: "Chennai",
    popular: true,
  },
  {
    state: "Tamil Nadu",
    hub_key: "sriperumbudur",
    display: "Sriperumbudur",
    areas: ["Oragadam", "SIPCOT"],
    city_value: "Sriperumbudur",
    popular: false,
  },
  {
    state: "Tamil Nadu",
    hub_key: "coimbatore",
    display: "Coimbatore",
    areas: ["Peelamedu", "SIDCO"],
    city_value: "Coimbatore",
    popular: false,
  },
  // ── Karnataka ──────────────────────────────────────────────────────────────────
  {
    state: "Karnataka",
    hub_key: "peenya",
    display: "Peenya (Bengaluru)",
    areas: ["Peenya Industrial Area", "Bommasandra"],
    // `Peenya` is the gazetteer's own Karnataka hub token; `bengaluru` folds onto `bangalore`
    // and would make the chip say one city while the body sends another.
    city_value: "Peenya",
    popular: true,
  },
  // ── Telangana ──────────────────────────────────────────────────────────────────
  {
    state: "Telangana",
    hub_key: "hyderabad",
    display: "Hyderabad",
    areas: ["Jeedimetla", "Balanagar"],
    city_value: "Hyderabad",
    popular: false,
  },
  // ── Delhi NCR ──────────────────────────────────────────────────────────────────
  {
    state: "Delhi",
    hub_key: "delhi",
    display: "Delhi NCR",
    areas: ["Bawana", "Narela"],
    city_value: "Delhi",
    popular: false,
  },
  // ── Uttar Pradesh ──────────────────────────────────────────────────────────────
  {
    state: "Uttar Pradesh",
    hub_key: "noida",
    display: "Noida / Greater Noida",
    areas: ["Sector 63", "Surajpur"],
    city_value: "Noida",
    popular: false,
  },
  // ── West Bengal ────────────────────────────────────────────────────────────────
  {
    state: "West Bengal",
    hub_key: "kolkata",
    display: "Kolkata",
    areas: ["Howrah", "Dankuni"],
    city_value: "Kolkata",
    popular: false,
  },
]);

/** The canonical city values the catalogue may submit — the served list's own values. */
export const CITY_HUB_VALUES: ReadonlySet<string> = new Set(CITY_CATALOGUE.map((c) => c.value));
