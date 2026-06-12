/**
 * Reach Engine — deterministic relevance scoring (§3 "common-sense checklist").
 *
 * Day-one rules, no learning, no data needed — fully deterministic (no clocks, no
 * randomness), so it works on launch day and is explainable. Every signal returns a
 * 0..1 contribution; unknown signals fall back to a NEUTRAL default (benefit of the
 * doubt — the chat can ask later) rather than a penalty, so a blank field never
 * drops a worker. A fuller, stronger profile naturally scores higher (§5).
 */
import type {
  GeoPoint,
  JobSpec,
  RankOptions,
  ScoreComponent,
  WorkerJobScore,
  WorkerSignals,
} from "./types";

// §3 weights. Sum = 1.0. DIALS (§12) — tune later; the shape is fixed here.
export const WEIGHTS = {
  role: 0.35, // "Does the worker do this kind of work?" — the biggest factor
  distance: 0.2, // "Can they get there?"
  experience: 0.15, // "Roughly the right experience?"
  pay: 0.1, // "Is the pay in their range?"
  availability: 0.1, // "Can they start when needed?"
  activity: 0.1, // "Are they active?"
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
  const parts: Array<{ signal: ScoreComponent["signal"]; weight: number } & Part> = [
    { signal: "role", weight: WEIGHTS.role, ...scoreRole(job, worker) },
    { signal: "distance", weight: WEIGHTS.distance, ...scoreDistance(job, worker, maxKm) },
    { signal: "experience", weight: WEIGHTS.experience, ...scoreExperience(job, worker) },
    { signal: "pay", weight: WEIGHTS.pay, ...scorePay(job, worker) },
    { signal: "availability", weight: WEIGHTS.availability, ...scoreAvailability(job, worker) },
    { signal: "activity", weight: WEIGHTS.activity, ...scoreActivity(worker) },
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
