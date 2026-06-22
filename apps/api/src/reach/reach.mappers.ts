import type { GeoPoint, WorkerSignals } from "@badabhai/reach-engine";
import { getRole, getDomain } from "@badabhai/taxonomy";

/**
 * Boundary mappers (ADR-0011 §mapping table) — PURE functions, unit-testable in
 * isolation. They map a `worker_profiles` signal row → the engine's `WorkerSignals`.
 *
 * THREE RULES, all from the ADR:
 *  1. NULL/BLANK IS THE ENGINE'S JOB. The mapper passes `null`/`undefined` straight
 *     through; the core neutral-defaults. A blank field must NEVER drop or penalize a
 *     worker (sort-never-block). We never filter, never invent data.
 *  2. FACELESS. Only canonicalized, non-identifying signals + the opaque `workerId`
 *     are read. Name/phone/address live only in `workers` and are never touched here.
 *  3. CLOCK LIVES HERE. `lastActiveDaysAgo` is derived from `updated_at` in the
 *     mapper (outside the engine) so the core stays clock-free (ADR-0006); it affects
 *     ordering only, never inclusion.
 *
 * The JSONB columns are `unknown` at the DB boundary, so every read is DEFENSIVE:
 * narrow the shape, optional-access the key, return `null` on anything missing or
 * unparseable. The real canonical shapes are `@badabhai/ai-contracts`' Experience /
 * SalaryExpectation / LocationPreference / Availability schemas; we read those keys
 * but tolerate enrichment keys (centroid / travel) that the contract does not yet carry.
 */

/** The signal columns the repository projects (D8) — never `embedding`/`rawProfile`. */
export interface WorkerProfileSignalRow {
  workerId: string;
  canonicalRoleId: string | null;
  canonicalTradeId: string | null;
  experience: unknown;
  salaryExpectation: unknown;
  locationPreference: unknown;
  availability: unknown;
  updatedAt: Date | string | null;
}

type Json = Record<string, unknown>;

/** True only for a plain object we can safely key into. */
function asObject(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

/** A finite number or `null` — a non-number / NaN / Infinity is "unknown" (null). */
function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A non-blank trimmed string or `null` (a blank string is "unknown", not ""). */
function nonBlankStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * `experience` JSONB → years. Canonical shape: `{ total_years, summary }`
 * (ExperienceSchema). `null` if missing/blank/unparseable.
 */
function readExperienceYears(experience: unknown): number | null {
  const obj = asObject(experience);
  if (!obj) return null;
  return finiteNumberOrNull(obj.total_years);
}

/**
 * `salary_expectation` JSONB → expected monthly INR. Canonical shape:
 * `{ amount_min, amount_max, currency, period }` (SalaryExpectationSchema). There is
 * no single "monthly INR" field, so we DERIVE one defensively: prefer `amount_min`
 * (the floor the worker expects), else `amount_max`; only when `period` is "monthly"
 * or absent (monthly is the contract default). A non-monthly period we do NOT convert
 * (we would be inventing a factor) → `null`, which the engine neutral-defaults.
 */
function readExpectedSalary(salaryExpectation: unknown): number | null {
  const obj = asObject(salaryExpectation);
  if (!obj) return null;

  const period = obj.period;
  // Unknown/absent period defaults to monthly (the contract default); any explicit
  // non-monthly period is left unconverted (null) rather than fabricating a rate.
  if (period != null && period !== "monthly") return null;

  return finiteNumberOrNull(obj.amount_min) ?? finiteNumberOrNull(obj.amount_max);
}

/**
 * `location_preference` JSONB → a city-CENTROID `GeoPoint` (ADR-0005), never a
 * worker-precise point. The canonical contract (LocationPreferenceSchema) carries
 * only `{ preferred_cities, willing_to_relocate }` and has NO centroid yet, so this
 * is defensive: read an optional enriched `centroid`/`location` `{lat,lng}` if present,
 * else `null`. We never invent coordinates from a city name here.
 */
function readLocationCentroid(locationPreference: unknown): GeoPoint | null {
  const obj = asObject(locationPreference);
  if (!obj) return null;

  const point = asObject(obj.centroid) ?? asObject(obj.location);
  if (!point) return null;

  const lat = finiteNumberOrNull(point.lat);
  const lng = finiteNumberOrNull(point.lng);
  if (lat == null || lng == null) return null;
  return { lat, lng };
}

/**
 * `location_preference` JSONB → city slug. Canonical: first of `preferred_cities`
 * (LocationPreferenceSchema); tolerate an enriched scalar `city`/`city_slug`. `null`
 * if none.
 */
function readCity(locationPreference: unknown): string | null {
  const obj = asObject(locationPreference);
  if (!obj) return null;

  const scalar = nonBlankStringOrNull(obj.city) ?? nonBlankStringOrNull(obj.city_slug);
  if (scalar) return scalar;

  const cities = obj.preferred_cities;
  if (Array.isArray(cities)) {
    for (const c of cities) {
      const slug = nonBlankStringOrNull(c);
      if (slug) return slug;
    }
  }
  return null;
}

/**
 * `location_preference` JSONB → travel willingness (km). The canonical contract has
 * no travel-radius field yet, so this is defensive: read an optional enriched
 * `travel_radius_km`/`max_travel_km` if present, else `null` → the engine option
 * default applies.
 */
function readTravelRadiusKm(locationPreference: unknown): number | null {
  const obj = asObject(locationPreference);
  if (!obj) return null;
  return finiteNumberOrNull(obj.travel_radius_km) ?? finiteNumberOrNull(obj.max_travel_km);
}

const AVAILABILITY_VALUES = ["immediate", "notice_period", "not_looking", "unknown"] as const;
type Availability = (typeof AVAILABILITY_VALUES)[number];

/**
 * `availability` JSONB → enum. Canonical shape: `{ status, notice_period_days }`
 * (AvailabilitySchema), where `status` is the enum; tolerate a bare string. An
 * unrecognised value maps to `null` (the engine treats null/"unknown" as neutral).
 */
function readAvailability(availability: unknown): Availability | null {
  const obj = asObject(availability);
  const raw = obj ? obj.status : availability;
  if (typeof raw !== "string") return null;
  return (AVAILABILITY_VALUES as readonly string[]).includes(raw) ? (raw as Availability) : null;
}

/**
 * Days since `updated_at`, derived AT REQUEST TIME outside the engine. `null` when
 * `updated_at` is missing/unparseable or in the future (clock skew) → the engine
 * neutral-defaults recency. Floored to whole days; never negative.
 */
export function lastActiveDaysAgoFrom(
  updatedAt: Date | string | null,
  now: Date = new Date(),
): number | null {
  if (updatedAt == null) return null;
  const then = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);
  const ms = then.getTime();
  if (!Number.isFinite(ms)) return null;

  const diffMs = now.getTime() - ms;
  if (diffMs < 0) return null; // future timestamp (clock skew) — treat as unknown
  return Math.floor(diffMs / 86_400_000);
}

/**
 * `worker_profiles` signal row → `WorkerSignals` (ADR-0011 mapping table). Pure,
 * faceless, null pass-through. `now` is injectable for deterministic tests; the
 * single clock-derived input (`lastActiveDaysAgo`) is computed here, not in the engine.
 *
 * `secondaryRoleIds`: the ADR says derive from `canonical_trade_id`/taxonomy adjacency
 * "if readily available, else []". There is no in-process adjacency lookup wired on
 * this read path, so we honestly return `[]` (never null-drop) — the post-ADR-0010
 * follow-up can enrich it without changing this signature.
 */
export function workerProfileRowToSignals(
  row: WorkerProfileSignalRow,
  now: Date = new Date(),
): WorkerSignals {
  return {
    workerId: row.workerId,
    roleId: nonBlankStringOrNull(row.canonicalRoleId),
    secondaryRoleIds: [],
    experienceYears: readExperienceYears(row.experience),
    expectedSalary: readExpectedSalary(row.salaryExpectation),
    location: readLocationCentroid(row.locationPreference),
    city: readCity(row.locationPreference),
    travelRadiusKm: readTravelRadiusKm(row.locationPreference),
    availability: readAvailability(row.availability),
    lastActiveDaysAgo: lastActiveDaysAgoFrom(row.updatedAt, now),
  };
}

/**
 * The FACELESS banded taxonomy chips a payer may browse for a ranked applicant
 * (ADR-0019 R22 / the reach faceless boundary, CLAUDE.md inv #2). PII-FREE by
 * construction — every field is a coarse band, an enum, or a canonical taxonomy
 * LABEL; NONE is a name / phone / address / employer / free text. Response-only
 * (never enters a `feed.shown` payload or a log). All fields are `null` when the
 * underlying signal is missing (sort-never-block: bands never gate inclusion).
 */
export interface WorkerBands {
  /** Coarse experience band derived from total years; `null` when unknown. */
  experienceBand: string | null;
  /** Canonical role/trade LABEL (taxonomy name, e.g. "VMC Operator"); `null` when unknown. */
  tradeLabel: string | null;
  /** Coarse preferred city slug (no sub-locality / address / coordinates); `null` when unknown. */
  cityLabel: string | null;
}

/**
 * `experience.total_years` → a COARSE display band, matching the payer surface's
 * established year-range vocabulary ("1-2 yrs" / "3-5 yrs" / "6-10 yrs"). This is a
 * display-only discretization to keep the faceless surface coarse — NOT a ranking input
 * or a business rule (the engine ranks on the raw years). `null` (unknown) for a
 * missing / non-finite / negative value; never throws, never invents.
 */
export function experienceBandFromYears(years: number | null): string | null {
  if (years == null || !Number.isFinite(years) || years < 0) return null;
  if (years < 1) return "<1 yr";
  if (years < 3) return "1-2 yrs";
  if (years < 6) return "3-5 yrs";
  if (years <= 10) return "6-10 yrs";
  return "10+ yrs";
}

/**
 * `worker_profiles` signal row → faceless {@link WorkerBands}. Pure, faceless, null
 * pass-through — the band analogue of {@link workerProfileRowToSignals}, reading the
 * SAME projected columns (no new PII surface). The trade label resolves the canonical
 * ROLE id to its taxonomy name, falling back to the DOMAIN (trade) name, then to the
 * raw canonical id (a faceless taxonomy token), then `null` — so the chip is populated
 * whenever any trade signal exists yet never leaks PII.
 */
export function workerProfileRowToBands(row: WorkerProfileSignalRow): WorkerBands {
  const roleId = nonBlankStringOrNull(row.canonicalRoleId);
  const tradeId = nonBlankStringOrNull(row.canonicalTradeId);
  const tradeLabel =
    (roleId ? getRole(roleId)?.name : undefined) ??
    (tradeId ? getDomain(tradeId)?.name : undefined) ??
    roleId ??
    tradeId ??
    null;
  return {
    experienceBand: experienceBandFromYears(readExperienceYears(row.experience)),
    tradeLabel,
    cityLabel: readCity(row.locationPreference),
  };
}
