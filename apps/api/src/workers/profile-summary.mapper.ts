import type { ProfileStatus } from "@badabhai/types";
import { getRole, labelForTaxonomyId } from "@badabhai/taxonomy";
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
 * never `embedding`). `rawProfile` IS read, but only for the two closed education
 * labels below, narrowed defensively (never spread — the blob can carry other keys). */
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
  /**
   * The legacy DraftProfile snapshot JSONB (`raw_profile`). Read ONLY for the four keys
   * `RawProfileStringKey` names — `education_level`/`education_field` and the interview's
   * `role_label`/`domain_label` — none of which are projected columns. Each is pulled out with
   * the same defensive narrowing as every other JSONB here, and the blob is never spread, so
   * no other key can leak onto the wire.
   */
  rawProfile: unknown;
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
 * (`resolveTradeContent(...).display_name`), then the interview's own labels,
 * else `null`. Null ids never reach the resolvers.
 *
 * THE LABEL ARM IS WHY THE WORKER'S OWN PROFILE TAB SAID "Aapki profile". Both resolvers key
 * off the canonical ids, and `toExtractionOutput` hardcodes both to null on the LLM-led path —
 * inventing a taxonomy id would put an unvalidated value where the match engine trusts
 * absolutely (§3). So this returned null for every interview-led worker, and the app's header
 * (`profile_tab_screen.dart` `_identity`) falls back to the generic "Aapki profile" when the
 * trade label is empty. The worker had named their trade in the interview and their own
 * profile would not say it back to them.
 *
 * ID-FIRST, exactly as the résumé builders resolve the same two values: the taxonomy value is
 * reviewed and the label is model free text, so the label can only ever FILL A BLANK and any
 * profile carrying an id keeps rendering as it does today (invariant #8). `role_label` leads
 * `domain_label` because this slot is the specific job title, and the industry is the coarser
 * answer to fall back to.
 *
 * PRESENTATION ONLY. `computeStrength` and `computeMissingFields` deliberately do NOT consult
 * these labels — see the note on `computeStrength`.
 */
function readDisplayName(
  roleId: string | null,
  tradeId: string | null,
  rawProfile: unknown,
): string | null {
  if (roleId) {
    const role = getRole(roleId);
    if (role) return role.name;
  }
  if (roleId || tradeId) {
    const resolved = resolveTradeContent(roleId, tradeId)?.display_name;
    if (resolved) return resolved;
  }
  return (
    readRawProfileString(rawProfile, "role_label") ??
    readRawProfileString(rawProfile, "domain_label")
  );
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
 *
 * THE INTERVIEW'S LABELS ARE DELIBERATELY NOT COUNTED HERE, and `computeMissingFields` below
 * does not consult them either. `readDisplayName` reads them, but that is PRESENTATION — what
 * the worker's header says. Strength is a BUSINESS signal count that must stay identical to
 * `countFields` in profile-extraction.processor.ts, and the two dimensions it scores are
 * "canonicalized role" and "canonicalized trade": a free-text label is precisely the state
 * canonicalization has not yet resolved. Counting it would tell a worker their profile is
 * stronger than the match engine can actually use it, and would silently move a number the
 * product hangs behaviour off (§3 — AI never owns business decisions).
 *
 * Same rule for `missing_fields`: "role"/"trade" mean "no canonical id", which stays true.
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
 * `raw_profile` JSONB → one named string key. Read with the SAME defensive narrowing as the
 * rest of the file (asObject + nonBlankStringOrNull): a missing key, non-object blob, or
 * non-string value maps to `null`, never a throw.
 *
 * THE KEY UNION IS THE ALLOW-LIST, and it is the whole privacy contract of this function. Only
 * these four keys can ever be read; the blob is NEVER spread, so no other field it happens to
 * carry — `experience.summary`, the résumé container, anything a future writer adds — can leak
 * onto the wire by accident. Widening this union is a deliberate act, not a refactor.
 *
 * All four are PII-free by class: closed education tokens, and the occupational labels the
 * model wrote, which the ai-service's pseudonymize gate already certified on the way in.
 */
type RawProfileStringKey =
  | "education_level"
  | "education_field"
  | "role_label"
  | "domain_label";

function readRawProfileString(rawProfile: unknown, key: RawProfileStringKey): string | null {
  return nonBlankStringOrNull(asObject(rawProfile)?.[key]);
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
  education_level: null,
  education_field: null,
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
      display_name: readDisplayName(canonicalRoleId, canonicalTradeId, profile.rawProfile),
    },
    city: readCity(profile.locationPreference),
    strength: computeStrength(profile),
    strength_max: STRENGTH_MAX,
    missing_fields: computeMissingFields(profile),
    // Resolve `skill_*` / `mach_*` ids to display names — the resume tab must show
    // "MIG Welding"/"VMC", never a raw id. Non-id strings pass through unchanged.
    skills: readStringArray(profile.skills).map(labelForTaxonomyId),
    machines: readStringArray(profile.machines).map(labelForTaxonomyId),
    experience_years: readExperienceYears(profile.experience),
    education_level: readRawProfileString(profile.rawProfile, "education_level"),
    education_field: readRawProfileString(profile.rawProfile, "education_field"),
    has_photo: profile.hasPhoto,
  };
}
