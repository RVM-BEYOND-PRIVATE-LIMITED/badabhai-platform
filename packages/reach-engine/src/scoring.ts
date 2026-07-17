/**
 * Reach Engine — deterministic relevance scoring (§3 "common-sense checklist").
 *
 * Day-one rules, no learning, no data needed — fully deterministic (no clocks, no
 * randomness), so it works on launch day and is explainable. Every signal returns a
 * 0..1 contribution; unknown signals fall back to a NEUTRAL default (benefit of the
 * doubt — the chat can ask later) rather than a penalty, so a blank field never
 * drops a worker. A fuller, stronger profile naturally scores higher (§5).
 *
 * ADR-0033 (2026-07-17): the 2026-06-19 CEO weight lock is operative — a
 * deterministic closed-set skills-overlap factor enters RANK at weight .15 (see
 * `skillsOverlap` / the WEIGHTS ledger below). The factor compares canonical
 * `skill_id` tokens by exact equality ONLY — no embeddings, no similarity, no model
 * call ever ranks (invariant #4). One deliberate exception to the neutral-default
 * rule, per the ruling: a worker with NO confirmed skills scores 0 on this factor
 * (never a block — sort-never-block holds; the chat can confirm skills later).
 */
import type {
  GeoPoint,
  JobSpec,
  RankOptions,
  ScoreComponent,
  WorkerJobScore,
  WorkerSignals,
} from "./types";

// The 2026-06-19 CEO weight lock, operative per the 2026-07-17 owner ruling (ADR-0033).
// Sum = 1.0. The ledger is a FULL table (not a proportional re-scale of the old set):
//
//   | signal       | pre-ADR-0033 | CEO lock (ADR-0033) |
//   | ------------ | ------------ | ------------------- |
//   | role/trade   | .35          | .35                 |
//   | distance     | .20          | .20                 |
//   | skills       | — (locked out, TAX-6) | .15 (NEW — deterministic overlap) |
//   | experience   | .15          | .15                 |
//   | pay/salary   | .10          | .10                 |
//   | availability | .10          | .05                 |
//   | activity     | .10          | 0 (dropped from the score; the component is KEPT
//   |              |              |    at weight 0 for explainability, the ranking
//   |              |              |    tie-break, and LEARN feature continuity)      |
//
// When a job lists NO skill ids, the skills weight is redistributed proportionally
// across the other factors (÷ (1 - WEIGHTS.skills)) so Σ stays 1.0 and a skill-less
// job's ordering is EXACTLY what the non-skills factors produce (see scoreWorkerForJob).
export const WEIGHTS = {
  role: 0.35, // "Does the worker do this kind of work?" — the biggest factor
  distance: 0.2, // "Can they get there?"
  skills: 0.15, // "Do they hold the skills the job asks for?" (ADR-0033, closed-set overlap)
  experience: 0.15, // "Roughly the right experience?"
  pay: 0.1, // "Is the pay in their range?"
  availability: 0.05, // "Can they start when needed?"
  activity: 0, // dropped by the CEO ledger; kept as a 0-weight explainable component
} as const;

const DEFAULT_MAX_TRAVEL_KM = 50;
const EARTH_RADIUS_KM = 6371;

// Finite-safe: a non-finite intermediate (NaN/Infinity from a bad input) collapses
// to 0 rather than poisoning the score and breaking the deterministic order.
const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Is this a usable numeric signal? A `null`/`undefined` (not provided) AND a garbage
 * `NaN`/`Infinity` (corrupt input) are BOTH treated as "unknown" — the §3 rule is that
 * a blank/unusable signal gets the neutral default (benefit of the doubt), never a
 * penalty. So a corrupt value must not score worse than a missing one.
 */
const num = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const isFiniteGeo = (g: GeoPoint | null | undefined): g is GeoPoint =>
  g != null && num(g.lat) && num(g.lng);

/** Great-circle distance in km between two points. */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

type Part = { raw: number; reason: string };

/**
 * Normalize a skill-id list into a usable set: non-blank strings only, trimmed,
 * deduplicated. Garbage entries (non-strings, blanks) are dropped, so a corrupt list
 * degrades to "fewer known ids", never a throw or a penalty on another factor.
 */
function usableSkillIds(ids: readonly string[] | null | undefined): Set<string> {
  const set = new Set<string>();
  if (!Array.isArray(ids)) return set;
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (trimmed.length > 0) set.add(trimmed);
  }
  return set;
}

/**
 * ADR-0033 — the deterministic skills-overlap factor (the CEO ledger's "Skills 15").
 *
 * `|worker ∩ jobRequired| / |jobRequired|` over DEDUPLICATED canonical closed-set
 * `skill_id` tokens (ADR-0030 vocabulary), compared by EXACT string equality only.
 * Pure + deterministic: no embeddings, no similarity, no model call, no clock
 * (invariant #4 — LLMs/embeddings never rank; the vector layer assigns ids UPSTREAM,
 * at profiling/posting time, never here).
 *
 * Zero-set semantics (ADR-0033 §factor):
 *  - empty/absent JOB set → 0 here; the CALLER treats the factor as NOT APPLICABLE
 *    and redistributes its weight (see scoreWorkerForJob) — order-neutral for
 *    skill-less jobs, no flat score inflation.
 *  - empty/absent WORKER set (job HAS requirements) → 0 on this factor ONLY —
 *    never a block, never a penalty on any other factor.
 * Bounded [0,1]; monotonically non-decreasing in the overlap.
 */
export function skillsOverlap(
  workerSkillIds: readonly string[] | null | undefined,
  jobSkillIds: readonly string[] | null | undefined,
): number {
  const jobSet = usableSkillIds(jobSkillIds);
  if (jobSet.size === 0) return 0;
  const workerSet = usableSkillIds(workerSkillIds);
  if (workerSet.size === 0) return 0;
  let matched = 0;
  for (const id of jobSet) if (workerSet.has(id)) matched += 1;
  return clamp01(matched / jobSet.size);
}

function scoreSkills(job: JobSpec, w: WorkerSignals): Part {
  const jobSet = usableSkillIds(job.skillIds);
  if (jobSet.size === 0) {
    // Factor not applicable — the caller redistributes the weight (ADR-0033), so this
    // raw contributes nothing and the reason documents why the weight shows 0.
    return { raw: 0, reason: "job lists no skill requirements (weight redistributed)" };
  }
  if (usableSkillIds(w.skillIds).size === 0) {
    return { raw: 0, reason: "no confirmed skills yet (scores 0 on this factor only — never a block)" };
  }
  const raw = skillsOverlap(w.skillIds, job.skillIds);
  const matched = Math.round(raw * jobSet.size);
  return { raw, reason: `${matched}/${jobSet.size} required skills matched` };
}

function scoreRole(job: JobSpec, w: WorkerSignals): Part {
  if (w.roleId == null) return { raw: 0.4, reason: "trade not stated yet (can ask in chat)" };
  if (job.roleIds.includes(w.roleId)) return { raw: 1, reason: "exact trade match" };
  if (w.secondaryRoleIds?.some((r) => job.roleIds.includes(r)))
    return { raw: 0.6, reason: "secondary/related trade match" };
  return { raw: 0, reason: "different trade (still shown, ranked lower)" };
}

function scoreDistance(job: JobSpec, w: WorkerSignals, defaultMaxKm: number): Part {
  // Guard against a misconfigured/degenerate or non-finite radius (a <=0 / NaN band
  // would collapse the graded scale so anyone >0km away drops to the floor) — fall
  // back to the default. A garbage radius behaves like "no radius given".
  const requested = num(job.maxTravelKm)
    ? job.maxTravelKm
    : num(w.travelRadiusKm)
      ? w.travelRadiusKm
      : defaultMaxKm;
  const maxKm = requested > 0 ? requested : DEFAULT_MAX_TRAVEL_KM;
  // Only use coordinates when BOTH points are finite — garbage geo (NaN/Infinity lat/lng)
  // falls through to the city / "location unknown" neutral path, never a distance penalty.
  if (isFiniteGeo(job.location) && isFiniteGeo(w.location)) {
    const d = haversineKm(job.location, w.location);
    const near = maxKm * 0.5;
    if (d <= near) return { raw: 1, reason: `~${Math.round(d)}km — well within range` };
    if (d <= maxKm)
      return { raw: clamp01(1 - ((d - near) / near) * 0.7), reason: `~${Math.round(d)}km — within range` };
    // Beyond range still appears with a small floor (§3 auto-widening can reach it).
    return { raw: 0.1, reason: `~${Math.round(d)}km — beyond usual travel` };
  }
  if (job.city && w.city) {
    return w.city.trim().toLowerCase() === job.city.trim().toLowerCase()
      ? { raw: 0.9, reason: "same city" }
      : { raw: 0.3, reason: "different city (no coordinates)" };
  }
  return { raw: 0.5, reason: "location unknown" };
}

function scoreExperience(job: JobSpec, w: WorkerSignals): Part {
  if (!num(w.experienceYears)) return { raw: 0.5, reason: "experience unknown" };
  // A non-finite requirement is treated as "no requirement" (ignore garbage bounds).
  const min = num(job.minExperienceYears) ? job.minExperienceYears : null;
  const max = num(job.maxExperienceYears) ? job.maxExperienceYears : null;
  if (min == null && max == null) return { raw: 0.7, reason: "no experience requirement" };
  const y = w.experienceYears;
  if ((min == null || y >= min) && (max == null || y <= max))
    return { raw: 1, reason: `${y}y — in range` };
  if (min != null && y < min)
    return { raw: clamp01(1 - (min - y) / Math.max(min, 1)), reason: `${y}y — below the ${min}y target` };
  return { raw: 0.7, reason: `${y}y — above the target range (overqualified)` };
}

function scorePay(job: JobSpec, w: WorkerSignals): Part {
  if (!num(w.expectedSalary)) return { raw: 0.6, reason: "salary expectation unknown" };
  const offer = num(job.payMax) ? job.payMax : num(job.payMin) ? job.payMin : null;
  // No usable offer, or a zero/negative one (misconfigured posting), is "not specified" —
  // not a hard fail — and avoids a divide-by-zero → Infinity below.
  if (offer == null || offer <= 0) return { raw: 0.7, reason: "pay not specified" };
  if (w.expectedSalary <= offer) return { raw: 1, reason: "expectation within the offer" };
  const over = (w.expectedSalary - offer) / offer;
  return { raw: clamp01(1 - over * 2), reason: `expects ~${Math.round(over * 100)}% above the offer` };
}

function scoreAvailability(job: JobSpec, w: WorkerSignals): Part {
  const a = w.availability ?? "unknown";
  if (a === "not_looking") return { raw: 0.1, reason: "not currently looking" };
  if (a === "unknown") return { raw: 0.5, reason: "availability unknown" };
  const needed = job.neededBy ?? "flexible";
  if (needed === "flexible") return { raw: 0.85, reason: "job timing is flexible" };
  if (a === "immediate") return { raw: 1, reason: "available immediately" };
  return { raw: needed === "immediate" ? 0.5 : 0.7, reason: "on a notice period" };
}

function scoreActivity(w: WorkerSignals): Part {
  const d = w.lastActiveDaysAgo;
  if (!num(d)) return { raw: 0.3, reason: "no recent activity data" };
  if (d <= 3) return { raw: 1, reason: "active in the last few days" };
  if (d <= 7) return { raw: 0.8, reason: "active this week" };
  if (d <= 30) return { raw: 0.5, reason: "active this month" };
  return { raw: 0.2, reason: "inactive for a while" };
}

/**
 * Score one worker's relevance to one job. Returns a 0..1 score with a per-signal
 * breakdown. NEVER throws "not relevant" — a poor fit gets a low score and still
 * appears in ranking. Pure + deterministic.
 */
export function scoreWorkerForJob(
  job: JobSpec,
  worker: WorkerSignals,
  opts: RankOptions = {},
): WorkerJobScore {
  const maxKm =
    num(opts.defaultMaxTravelKm) && opts.defaultMaxTravelKm > 0
      ? opts.defaultMaxTravelKm
      : DEFAULT_MAX_TRAVEL_KM;
  // ADR-0033: the skills factor applies only when the job LISTS skill requirements.
  // When it does not, its weight is redistributed proportionally over the remaining
  // factors (÷ (1 - WEIGHTS.skills)) — the CEO-locked 35:20:15:10:5 proportions are
  // preserved, Σ(effective weights) stays 1.0, and a skill-less job's ORDERING is
  // exactly what the non-skills factors produce (the factor is order-neutral where no
  // demand-side skills exist — chosen over "score 1.0 for everyone", which would have
  // flatly inflated every skill-less job's score by +0.15 and shifted pushEligible).
  // Components carry the EFFECTIVE weights, so score == Σ(weight × raw) always holds.
  const skillsApply = usableSkillIds(job.skillIds).size > 0;
  const scale = skillsApply ? 1 : 1 / (1 - WEIGHTS.skills);
  const parts: Array<{ signal: ScoreComponent["signal"]; weight: number } & Part> = [
    { signal: "role", weight: WEIGHTS.role * scale, ...scoreRole(job, worker) },
    { signal: "distance", weight: WEIGHTS.distance * scale, ...scoreDistance(job, worker, maxKm) },
    { signal: "skills", weight: skillsApply ? WEIGHTS.skills : 0, ...scoreSkills(job, worker) },
    { signal: "experience", weight: WEIGHTS.experience * scale, ...scoreExperience(job, worker) },
    { signal: "pay", weight: WEIGHTS.pay * scale, ...scorePay(job, worker) },
    { signal: "availability", weight: WEIGHTS.availability * scale, ...scoreAvailability(job, worker) },
    { signal: "activity", weight: WEIGHTS.activity * scale, ...scoreActivity(worker) },
  ];
  const score = clamp01(parts.reduce((s, p) => s + p.weight * p.raw, 0));
  const components: ScoreComponent[] = parts.map((p) => ({
    signal: p.signal,
    raw: p.raw,
    weight: p.weight,
    reason: p.reason,
  }));
  return { workerId: worker.workerId, jobId: job.jobId, score, components };
}
