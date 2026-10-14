import type { ProfileSource, ProfileStatus } from "@badabhai/types";
import { getRole, labelForTaxonomyId } from "@badabhai/taxonomy";
import { resolveTradeContent } from "../resume/trade-content";
import type { WorkerProfileSummary } from "./workers.dto";
import { NO_FORM_FACTS, type ProfileFormFacts } from "./profile-form-facts";

/**
 * PURE mapper: latest `worker_profiles` row → the TD54 self-view summary
 * (`GET /workers/me/profile-summary`). Mirrors the defensive-narrowing posture of
 * `reach.mappers.ts`: the JSONB columns are `unknown` at the DB boundary, so every
 * read narrows the shape, optional-accesses the key, and falls back to `null`/`0`
 * on anything missing or unparseable — a malformed row must NEVER throw a 500 at
 * the worker.
 *
 * FACELESS BY CONSTRUCTION: the input is the profile row (canonical ids + signal
 * JSONB) plus presence flags for the worker's form answers (#2201, never a value).
 * Name/phone live on `workers` and never enter this mapper — the
 * "Namaste, <name>" field is an OPEN §2 escalation
 * (docs/worker-profile-summary-spec.md) and ships only if ruled allowed.
 */

/** The structural subset of `WorkerProfile` the summary reads (D8-style projection —
 * never `embedding`). `rawProfile` IS read, but only for the two closed education
 * labels below, narrowed defensively (never spread — the blob can carry other keys). */
export interface ProfileSummarySource {
  profileStatus: ProfileStatus;
  /**
   * Task 1 — the road, `worker_profiles.source`. Optional because rows written
   * before migration 0107 carry NULL; the mapper narrows defensively and the
   * wire carries `null` (unknown), never a guessed road.
   */
  source?: ProfileSource | string | null;
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
  /**
   * The worker's OWN city from `workers.current_city` (#1428), if they gave one at onboarding.
   * Outranks anything in `locationPreference` — see {@link readCity}.
   */
  workerCity?: string | null;
  /**
   * #2201 — the worker's own form answers, presence only (see {@link ProfileFormFacts}). Absent
   * or null scores exactly as before: the profile row alone.
   */
  formFacts?: ProfileFormFacts | null;
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
 * The summary city, in precedence order.
 *
 * #1428 — `workers.current_city` FIRST, and that is an owner ruling (2026-09-05), not a
 * preference. It is the city the worker typed (or accepted from a device reverse-geocode) on the
 * first onboarding screen: a first-party assertion. Everything below it comes out of
 * `location_preference`, whose only writer is the extraction processor — a value the model
 * inferred from chat. "AI never owns business decisions" covers overwriting the worker's own
 * answer with a derived guess, so the derived guess loses. Nothing writes the other direction
 * either: the extraction path does not touch `workers.current_city`.
 *
 * Issue #423 — then the profile's own `current_city`, then the first non-blank
 * `preferred_cities` entry. The last fallback is NOT dead code: before current and preferred
 * locations were split, `_build_legacy` PREPENDED the current city to that array, so on every
 * profile extracted before the split it is the only place the city exists. Reading `current_city`
 * alone would blank the city for all of them.
 *
 * `null` when every source is absent, not an object, or missing/empty/malformed.
 */
function readCity(locationPreference: unknown, workerCity?: string | null): string | null {
  const own = nonBlankStringOrNull(workerCity);
  if (own) return own;

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
 * Task 1 — `worker_profiles.source` → the wire road. Closed vocabulary only:
 * anything outside `form`/`chat` (including pre-0107 NULL) maps to `null`
 * (unknown), never to a guessed road, and never throws.
 */
function readSource(source: unknown): ProfileSource | null {
  return source === "form" || source === "chat" ? source : null;
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
 * Profile strength, RECOMPUTED on read over the STORED row's JSONB (defensive narrowing) PLUS the
 * worker's own form answers (#2201, {@link ProfileFormFacts}). Never stored.
 *
 * The nine dimensions and what each scores:
 * +1 canonical_role_id, +1 canonical_trade_id, +skills.length, +machines.length,
 * +1 experience.total_years != null, +1 salary amount_min/amount_max present,
 * +1 preferred_cities non-empty, +1 availability.status !== "unknown",
 * +1 has_photo (TD77b — photo-in-strength).
 *
 * THE PROFILE ROW SCORES FIRST AND IS NEVER CHANGED BY THE FORM. A dimension the row already
 * fills scores exactly what it did before #2201. A dimension the row leaves blank can now score on
 * any road, because chat-road workers hold attributes too. The form answer only FILLS A BLANK, and it scores +1 for the group, not +N per item. That stops a
 * turner who ticked eight operations from jumping past `strength_max`. The row's own unbounded
 * `skills.length` / `machines.length` scoring is pre-existing and left as it is.
 *
 * WHY THE FORM COUNTS HERE AND NOT IN `countFields`. `countFields` (profile-extraction.processor.ts)
 * scores the draft at EXTRACTION time for the `profile.extracted` event's `field_count`. It cannot
 * see answers the worker gives afterwards, and the trade form is exactly that. This read is the
 * worker's live view, so it scores what the worker has actually told us. The résumé already prints
 * these same answers (`resume-preference-facts.ts`).
 *
 * THE INTERVIEW'S LABELS ARE DELIBERATELY NOT COUNTED, and `missing_fields` does not consult them
 * either. `readDisplayName` reads them, but that is PRESENTATION. The role/trade dimensions are
 * "canonicalized role" and "canonicalized trade", and a free-text label is precisely the state
 * canonicalization has not yet resolved. Counting it would tell a worker their profile is stronger
 * than the match engine can actually use (§3 — AI never owns business decisions). "role"/"trade"
 * in `missing_fields` mean "no canonical id".
 */
const STRENGTH_MAX = 9;

/** One strength dimension: its `missing_fields` key and the points it scores (0 = missing). */
interface StrengthDimension {
  readonly key: string;
  readonly points: number;
}

/** A profile list's own count, else +1 when the form fills the blank, else 0. */
function listPoints(value: unknown, formHas: boolean): number {
  if (Array.isArray(value) && value.length > 0) return value.length;
  return formHas ? 1 : 0;
}

/**
 * THE ONE TABLE strength and `missing_fields` are both derived from, in wire order, so the two can
 * never disagree about a dimension.
 */
function strengthDimensions(p: ProfileSummarySource): StrengthDimension[] {
  const form = p.formFacts ?? NO_FORM_FACTS;
  const salary = asObject(p.salaryExpectation);
  const cities = asObject(p.locationPreference)?.preferred_cities;
  const status = readAvailabilityStatus(p.availability);
  const has = (filled: boolean): number => (filled ? 1 : 0);
  return [
    { key: "role", points: has(Boolean(p.canonicalRoleId)) },
    { key: "trade", points: has(Boolean(p.canonicalTradeId)) },
    { key: "skills", points: listPoints(p.skills, form.hasSkills) },
    { key: "machines", points: listPoints(p.machines, form.hasMachines) },
    {
      key: "experience",
      points: has(asObject(p.experience)?.total_years != null || form.hasExperience),
    },
    {
      key: "salary",
      points: has(
        (salary != null && (salary.amount_min != null || salary.amount_max != null)) ||
          form.hasSalary,
      ),
    },
    {
      key: "location",
      points: has((Array.isArray(cities) && cities.length > 0) || form.hasPreferredLocations),
    },
    {
      key: "availability",
      points: has((status != null && status !== "unknown") || form.hasAvailability),
    },
    { key: "photo", points: has(p.hasPhoto) },
  ];
}

function computeStrength(p: ProfileSummarySource): number {
  return strengthDimensions(p).reduce((sum, d) => sum + d.points, 0);
}

/** The dimensions that score nothing. Each maps to exactly one key in `missing_fields`. */
function computeMissingFields(p: ProfileSummarySource): string[] {
  return strengthDimensions(p)
    .filter((d) => d.points === 0)
    .map((d) => d.key);
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
type RawProfileStringKey = "education_level" | "education_field" | "role_label" | "domain_label";

function readRawProfileString(rawProfile: unknown, key: RawProfileStringKey): string | null {
  return nonBlankStringOrNull(asObject(rawProfile)?.[key]);
}

/** No-profile-yet summary: everything null/zero/empty, `profile_status: "none"`. */
const NO_PROFILE: WorkerProfileSummary = {
  profile_status: "none",
  source: null,
  confirmed_at: null,
  trade: { canonical_trade_id: null, canonical_role_id: null, display_name: null },
  city: null,
  strength: 0,
  strength_max: STRENGTH_MAX,
  missing_fields: [
    "role",
    "trade",
    "skills",
    "machines",
    "experience",
    "salary",
    "location",
    "availability",
    "photo",
  ],
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
    source: readSource(profile.source),
    confirmed_at: toIsoOrNull(profile.confirmedAt),
    trade: {
      canonical_trade_id: canonicalTradeId,
      canonical_role_id: canonicalRoleId,
      display_name: readDisplayName(canonicalRoleId, canonicalTradeId, profile.rawProfile),
    },
    city: readCity(profile.locationPreference, profile.workerCity),
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
