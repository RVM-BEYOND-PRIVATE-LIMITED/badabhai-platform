import type { ProfileStatus } from "@badabhai/types";
import { getRole } from "@badabhai/taxonomy";
import { resolveTradeContent } from "../resume/trade-content";
import type { WorkerProfileSummary } from "./workers.dto";

/**
 * PURE mapper: latest `worker_profiles` row → the TD54 self-view summary
 * (`GET /workers/me/profile-summary`). Mirrors the defensive-narrowing posture of
 * `reach.mappers.ts`: the JSONB columns are `unknown` at the DB boundary, so every
 * read narrows the shape, optional-accesses the key, and falls back to `null`/`0`
 * on anything missing or unparseable — a malformed row must NEVER throw a 500 at
 * the worker.
 *
 * FACELESS BY CONSTRUCTION: the input is the profile row only (canonical ids +
 * signal JSONB). Name/phone live on `workers` and never enter this mapper — the
 * "Namaste, <name>" field is an OPEN §2 escalation
 * (docs/worker-profile-summary-spec.md) and ships only if ruled allowed.
 */

/** The structural subset of `WorkerProfile` the summary reads (D8-style projection —
 * never `embedding`/`rawProfile`). */
export interface ProfileSummarySource {
  profileStatus: ProfileStatus;
  canonicalTradeId: string | null;
  canonicalRoleId: string | null;
  skills: unknown;
  machines: unknown;
  experience: unknown;
  salaryExpectation: unknown;
  locationPreference: unknown;
  availability: unknown;
  confirmedAt: Date | string | null;
  hasPhoto: boolean;
}

type Json = Record<string, unknown>;

/** True only for a plain object we can safely key into (mirrors reach.mappers). */
function asObject(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

/** A non-blank trimmed string or `null` (a blank string is "unknown", not ""). */
function nonBlankStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** `confirmed_at` → ISO-8601 string. Tolerates a driver-returned string; an
 * unparseable value maps to `null` rather than throwing. */
function toIsoOrNull(value: Date | string | null): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * `location_preference` JSONB → the summary city.
 *
 * Issue #423 — prefers the worker's own `current_city`, then falls back to the first
 * non-blank `preferred_cities` entry. The fallback is NOT dead code: before current
 * and preferred locations were split, `_build_legacy` PREPENDED the current city to
 * that array, so on every profile extracted before the split it is the only place the
 * city exists. Reading `current_city` alone would blank the city for all of them.
 *
 * `null` when the JSONB is absent, not an object, or both sources are
 * missing/empty/malformed.
 */
function readCity(locationPreference: unknown): string | null {
  const obj = asObject(locationPreference);
  const current = nonBlankStringOrNull(obj?.current_city);
  if (current) return current;

  const cities = obj?.preferred_cities;
  if (!Array.isArray(cities)) return null;
  for (const c of cities) {
    const city = nonBlankStringOrNull(c);
    if (city) return city;
  }
  return null;
}

/** `availability` JSONB → the status string (canonical `{ status }` shape;
 * tolerate a bare string, like reach's readAvailability). `null` = unknown. */
function readAvailabilityStatus(availability: unknown): string | null {
  if (typeof availability === "string") return nonBlankStringOrNull(availability);
  return nonBlankStringOrNull(asObject(availability)?.status);
}

/**
 * A JSONB `skills`/`machines` column → a clean `string[]`: keep non-blank trimmed
 * strings, drop everything else (a malformed row yields `[]`, never a throw). The
 * labels are canonical taxonomy strings — PII-free by construction.
 */
function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = nonBlankStringOrNull(item);
    if (s) out.push(s);
  }
  return out;
}

/**
 * `experience.total_years` → a finite, non-negative number, else `null`. ONLY the
 * number is read — `experience.summary` (free text, possible §2 employer PII) is
 * never projected to the wire.
 */
function readExperienceYears(experience: unknown): number | null {
  const years = asObject(experience)?.total_years;
  return typeof years === "number" && Number.isFinite(years) && years >= 0 ? years : null;
}

/**
 * Human display name for the trade block: taxonomy first
 * (`getRole(canonicalRoleId).name`), then the authored trade-content fallback
 * (`resolveTradeContent(...).display_name`), else `null`. Null ids never reach
 * the resolvers.
 */
function readDisplayName(roleId: string | null, tradeId: string | null): string | null {
  if (roleId) {
    const role = getRole(roleId);
    if (role) return role.name;
  }
  if (!roleId && !tradeId) return null;
  return resolveTradeContent(roleId, tradeId)?.display_name ?? null;
}

/**
 * Profile strength, RECOMPUTED on read — the exact `countFields` algorithm from
 * profile-extraction.processor.ts, re-derived over the STORED row's JSONB (with
 * defensive narrowing instead of the processor's typed DraftProfile):
 * +1 canonical_role_id, +1 canonical_trade_id, +skills.length, +machines.length,
 * +1 experience.total_years != null, +1 salary amount_min/amount_max present,
 * +1 preferred_cities non-empty, +1 availability.status !== "unknown",
 * +1 has_photo (TD77b — photo-in-strength).
 * Deliberately NOT stored (no new column, no drift with the processor's value).
 */
const STRENGTH_MAX = 9;

function computeStrength(p: ProfileSummarySource): number {
  let n = 0;
  if (p.canonicalRoleId) n += 1;
  if (p.canonicalTradeId) n += 1;
  n += Array.isArray(p.skills) ? p.skills.length : 0;
  n += Array.isArray(p.machines) ? p.machines.length : 0;
  if (asObject(p.experience)?.total_years != null) n += 1;
  const salary = asObject(p.salaryExpectation);
  if (salary != null && (salary.amount_min != null || salary.amount_max != null)) n += 1;
  const cities = asObject(p.locationPreference)?.preferred_cities;
  if (Array.isArray(cities) && cities.length > 0) n += 1;
  const status = readAvailabilityStatus(p.availability);
  if (status != null && status !== "unknown") n += 1;
  if (p.hasPhoto) n += 1;
  return n;
}

/**
 * Which of the 9 field-group slots are empty/missing. Each maps to exactly one
 * key in missing_fields. Must stay in sync with computeStrength's dimension set.
 */
function computeMissingFields(p: ProfileSummarySource): string[] {
  const missing: string[] = [];
  if (!p.canonicalRoleId) missing.push("role");
  if (!p.canonicalTradeId) missing.push("trade");
  if (!Array.isArray(p.skills) || p.skills.length === 0) missing.push("skills");
  if (!Array.isArray(p.machines) || p.machines.length === 0) missing.push("machines");
  if (asObject(p.experience)?.total_years == null) missing.push("experience");
  const salary = asObject(p.salaryExpectation);
  if (salary == null || (salary.amount_min == null && salary.amount_max == null)) missing.push("salary");
  const cities = asObject(p.locationPreference)?.preferred_cities;
  if (!Array.isArray(cities) || cities.length === 0) missing.push("location");
  const status = readAvailabilityStatus(p.availability);
  if (status == null || status === "unknown") missing.push("availability");
  if (!p.hasPhoto) missing.push("photo");
  return missing;
}

/** No-profile-yet summary: everything null/zero/empty, `profile_status: "none"`. */
const NO_PROFILE: WorkerProfileSummary = {
  profile_status: "none",
  confirmed_at: null,
  trade: { canonical_trade_id: null, canonical_role_id: null, display_name: null },
  city: null,
  strength: 0,
  strength_max: STRENGTH_MAX,
  missing_fields: ["role", "trade", "skills", "machines", "experience", "salary", "location", "availability", "photo"],
  skills: [],
  machines: [],
  experience_years: null,
  has_photo: false,
};

/** Map the latest profile row (or its absence) to the wire summary. */
export function toProfileSummary(
  profile: ProfileSummarySource | null | undefined,
): WorkerProfileSummary {
  if (!profile) return NO_PROFILE;

  const canonicalRoleId = profile.canonicalRoleId ?? null;
  const canonicalTradeId = profile.canonicalTradeId ?? null;

  return {
    profile_status: profile.profileStatus,
    confirmed_at: toIsoOrNull(profile.confirmedAt),
    trade: {
      canonical_trade_id: canonicalTradeId,
      canonical_role_id: canonicalRoleId,
      display_name: readDisplayName(canonicalRoleId, canonicalTradeId),
    },
    city: readCity(profile.locationPreference),
    strength: computeStrength(profile),
    strength_max: STRENGTH_MAX,
    missing_fields: computeMissingFields(profile),
    skills: readStringArray(profile.skills),
    machines: readStringArray(profile.machines),
    experience_years: readExperienceYears(profile.experience),
    has_photo: profile.hasPhoto,
  };
}
